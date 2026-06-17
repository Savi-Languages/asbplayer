// Thin HTTP client for the savi daemon's capture API.
//
// Contract (savi-server crates/savi-server/src/capture.rs):
//   POST {base}/api/capture/start     {episodeId, show?, title?, lang?} → {captureId}
//        Capture v2: episodeId is platform-stable, so captureId is
//        deterministic (safe(episodeId)) and an existing episode resumes.
//        show/title are best-effort page metadata for the per-show library.
//   POST {base}/api/capture/chunk?captureId=&segmentId=&mediaTimeMs=&rate=
//        raw audio bytes; mediaTimeMs/rate read from a segment's FIRST chunk
//   POST {base}/api/capture/subtitles {captureId, content, format}
//   POST {base}/api/capture/finish    {captureId} → episode summary
//
// All requests carry `Authorization: Bearer <token>`. The extension
// declares host permissions for localhost/127.0.0.1/*.local, which is
// what exempts these cross-origin fetches from CORS (the daemon serves
// no CORS headers by design — it expects same-origin or trusted callers).

export interface SaviDaemonConfig {
    readonly baseUrl: string;
    readonly token: string;
}

export interface CaptureFinishInfo {
    readonly episodeId: string;
    readonly segmentsStitched: number;
    readonly totalLines: number;
    readonly keptDurationMs: number;
}

export const normalizedBaseUrl = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '');

const request = async (config: SaviDaemonConfig, path: string, init: RequestInit) => {
    const url = `${normalizedBaseUrl(config.baseUrl)}${path}`;
    const response = await fetch(url, {
        ...init,
        headers: {
            ...init.headers,
            Authorization: `Bearer ${config.token}`,
        },
    });

    if (!response.ok) {
        let message = `${response.status}`;

        try {
            const body = await response.json();
            message = body?.error ?? message;
        } catch (e) {
            // Not JSON - status alone will have to do
        }

        throw new Error(`savi daemon: ${message}`);
    }

    return await response.json();
};

const jsonInit = (body: any): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

export const startCapture = async (
    config: SaviDaemonConfig,
    { episodeId, show, title, lang }: { episodeId: string; show?: string; title?: string; lang?: string }
): Promise<string> => {
    const body = await request(config, '/api/capture/start', jsonInit({ episodeId, show, title, lang }));
    return body.captureId;
};

export const postSubtitles = async (
    config: SaviDaemonConfig,
    { captureId, content, format }: { captureId: string; content: string; format: 'srt' | 'vtt' }
): Promise<void> => {
    await request(config, '/api/capture/subtitles', jsonInit({ captureId, content, format }));
};

export const postChunk = async (
    config: SaviDaemonConfig,
    {
        captureId,
        segmentId,
        mediaTimeMs,
        rate,
        data,
    }: { captureId: string; segmentId: string; mediaTimeMs: number; rate: number; data: Blob }
): Promise<void> => {
    const query = new URLSearchParams({
        captureId,
        segmentId,
        mediaTimeMs: String(mediaTimeMs),
        rate: String(rate),
    });
    await request(config, `/api/capture/chunk?${query.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm' },
        body: data,
    });
};

// ── Hover dictionary ────────────────────────────────────────────────────

export interface SaviToken {
    readonly text: string;
    readonly reading?: string;
    readonly lemma?: string;
}

export interface SaviDictSense {
    readonly pos: string[];
    readonly glosses: string[];
}

export interface SaviDictEntry {
    readonly kanji: string[];
    readonly readings: string[];
    readonly senses: SaviDictSense[];
}

/** Tokenize a line; tokens concatenate back to the input so the caller can
 *  map a cursor offset to a token. Empty when the daemon has no analyzer. */
export const tokenize = async (config: SaviDaemonConfig, lang: string, text: string): Promise<SaviToken[]> => {
    const body = await request(config, '/api/tokenize', jsonInit({ lang, text }));
    return body.tokens ?? [];
};

/** JP→EN dictionary lookup; empty when nothing matches or no dictionary. */
export const lookupDict = async (config: SaviDaemonConfig, lang: string, term: string): Promise<SaviDictEntry[]> => {
    const path = `/api/dict/${encodeURIComponent(lang)}/${encodeURIComponent(term)}`;
    const body = await request(config, path, { method: 'GET' });
    return body.entries ?? [];
};

export const finishCapture = async (config: SaviDaemonConfig, captureId: string): Promise<CaptureFinishInfo> => {
    const body = await request(config, '/api/capture/finish', jsonInit({ captureId }));
    return {
        episodeId: body.episodeId,
        segmentsStitched: body.segmentsStitched,
        totalLines: body.totalLines,
        keptDurationMs: body.keptDurationMs,
    };
};
