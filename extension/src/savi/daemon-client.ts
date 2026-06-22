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

// POST {base}/api/episode/transcript {episodeId, content, format} — store the
// full subtitle track keyed by episode WITHOUT a capture session, so the daemon
// can build a whole-episode gist for hover-only (never-recorded) episodes.
export const postEpisodeTranscript = async (
    config: SaviDaemonConfig,
    { episodeId, content, format }: { episodeId: string; content: string; format: 'srt' | 'vtt' }
): Promise<void> => {
    await request(config, '/api/episode/transcript', jsonInit({ episodeId, content, format }));
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
    // Present only on AI-segmented chunks: the meaning IN THIS sentence + the
    // grammatical role here (e.g. でも → "but/however" / "conjunction").
    readonly gloss?: string;
    readonly grammar?: string;
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

/** Per-kanji breakdown (Heisig keyword + components + mnemonic) for the term. */
export interface SaviKanjiInfo {
    readonly kanji: string;
    readonly keyword: string;
    readonly components: string[];
    readonly story?: string;
}

export interface SaviDictResult {
    readonly entries: SaviDictEntry[];
    readonly kanji: SaviKanjiInfo[];
}

/** Tokenize a line; tokens concatenate back to the input so the caller can
 *  map a cursor offset to a token. Empty when the daemon has no analyzer. */
export const tokenize = async (config: SaviDaemonConfig, lang: string, text: string): Promise<SaviToken[]> => {
    const body = await request(config, '/api/tokenize', jsonInit({ lang, text }));
    return body.tokens ?? [];
};

export interface SaviSegmentResult {
    readonly ai: boolean;
    readonly tokens: SaviToken[];
}

/** AI context-aware segmentation of a line (resolves でも-conjunction vs で+も, は-topic
 *  vs 葉, …). A superset of `tokenize`: tokens still concatenate back to the line, and
 *  AI chunks carry `gloss`/`grammar`. `ai:false` = the daemon fell back to the rule-based
 *  split (no provider / offline / a split that wouldn't reconcile with the line). */
export const segmentLine = async (
    config: SaviDaemonConfig,
    lang: string,
    text: string,
    opts?: { prevLines?: string[]; nextLines?: string[]; episodeId?: string }
): Promise<SaviSegmentResult> => {
    const body = await request(
        config,
        '/api/segment',
        jsonInit({
            lang,
            text,
            prevLines: opts?.prevLines ?? [],
            nextLines: opts?.nextLines ?? [],
            episodeId: opts?.episodeId,
        })
    );
    return { ai: body.ai === true, tokens: body.tokens ?? [] };
};

/** A professor-style explanation of one word in the context of its sentence — the
 *  detailed "in this sentence" teaching note for the tap panel. `null` when no
 *  provider is configured / every provider fails. */
export const explainWord = async (
    config: SaviDaemonConfig,
    lang: string,
    term: string,
    text: string,
    opts?: { reading?: string; prevLines?: string[]; nextLines?: string[]; episodeId?: string }
): Promise<string | null> => {
    const body = await request(
        config,
        '/api/explain',
        jsonInit({
            lang,
            term,
            reading: opts?.reading,
            text,
            prevLines: opts?.prevLines ?? [],
            nextLines: opts?.nextLines ?? [],
            episodeId: opts?.episodeId,
        })
    );
    return typeof body.explanation === 'string' && body.explanation.trim().length > 0 ? body.explanation : null;
};

/** JP→EN dictionary lookup + per-kanji breakdown; both empty when nothing
 *  matches or no dictionary is loaded. */
export const lookupDict = async (config: SaviDaemonConfig, lang: string, term: string): Promise<SaviDictResult> => {
    const path = `/api/dict/${encodeURIComponent(lang)}/${encodeURIComponent(term)}`;
    const body = await request(config, path, { method: 'GET' });
    return { entries: body.entries ?? [], kanji: body.kanji ?? [] };
};

// ── Mine to Anki ────────────────────────────────────────────────────────

export interface MineLineResult {
    readonly ok: boolean;
    readonly noteId?: number;
    // True when the daemon found the captured episode and clipped the line's
    // audio into the card; false for a text-only card (no capture on disk).
    readonly hadAudio?: boolean;
    // True when the screenshot was stored on the card.
    readonly hadImage?: boolean;
    // True when AI enrichment (pitch, meaning, in-context) was attached; false =
    // dictionary-only fallback (no provider configured, or every provider failed).
    readonly enriched?: boolean;
}

/** Mine the hovered line+word into an Anki card. The daemon clips the line's
 *  audio from the captured episode (best-effort) and creates the note via
 *  AnkiConnect. Throws on daemon/Anki error — the caller maps it to a
 *  user-facing message. */
export const mineLine = async (
    config: SaviDaemonConfig,
    {
        episodeId,
        lineText,
        surface,
        term,
        reading,
        deck,
        imageBase64,
    }: {
        episodeId: string;
        lineText: string;
        surface?: string;
        term: string;
        reading?: string;
        deck?: string;
        imageBase64?: string;
    }
): Promise<MineLineResult> => {
    const body = await request(
        config,
        '/api/anki/mine',
        jsonInit({ episodeId, lineText, surface, term, reading, deck, imageBase64 })
    );
    return {
        ok: body.ok === true,
        noteId: body.noteId,
        hadAudio: body.hadAudio,
        hadImage: body.hadImage,
        enriched: body.enriched,
    };
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
