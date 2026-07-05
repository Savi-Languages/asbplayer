// Thin HTTP client for the savi daemon's capture API (API v2 — every daemon
// route lives under /v2/; the pre-restructure unversioned /api/ surface is
// gone).
//
// Contract (savi crates/savi-daemon/src/capture.rs, docs/daemon-api/):
//   POST {base}/v2/capture/start     {episodeId, show?, title?, lang?} → {captureId}
//        episodeId is platform-stable, so captureId is deterministic
//        (safe(episodeId)) and an existing episode resumes. show/title are
//        best-effort page metadata for the per-show library.
//   POST {base}/v2/capture/chunk?captureId=&segmentId=&mediaTimeMs=&rate=
//        raw audio bytes; mediaTimeMs/rate read from a segment's FIRST chunk
//   POST {base}/v2/capture/subtitles {captureId, content, format}
//   POST {base}/v2/capture/finish    {captureId} → episode summary
//
// All requests carry `Authorization: Bearer <token>`. The extension
// declares host permissions for localhost/127.0.0.1/*.local, which is
// what exempts these cross-origin fetches from CORS (the daemon serves
// no CORS headers by design — it expects same-origin or trusted callers).
//
// PORT DISCOVERY: if the daemon's preferred port is taken by another program,
// the desktop shell walks preferred..preferred+5 and binds the first free one.
// When a request fails at the network level, we probe the same candidate range
// with GET /v2/health (which requires the bearer token — a 200 proves it's OUR
// daemon, not whatever else answered) and pin the discovered base until it
// stops responding.

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

// Must match the desktop shell's pick_port() walk (savi apps/desktop): the
// configured port first, then the savi port family — 4030 ("Savi" ASCII-sum
// ×10, the default), 4350 ("savi"), 3070 ("SAVI"), 6880 ("Khalifa"),
// 8290 ("Tianxiao"). None are registered or common local-dev ports.
const PORT_CANDIDATES = [4030, 4350, 3070, 6880, 8290];

// The base that most recently answered /v2/health after a network failure on
// the configured URL. Module state per extension context (background and the
// offscreen document each discover independently — that's fine, it's one
// health probe each).
let discoveredBaseUrl: string | null = null;

/** The configured base plus its port-walk siblings (loopback hosts only —
 *  a remote/mDNS daemon has a fixed, deliberately-configured address). */
const candidateBaseUrls = (configuredBase: string): string[] => {
    try {
        const url = new URL(configuredBase);
        if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
            return [configuredBase];
        }
        const preferred = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        const ports = [preferred, ...PORT_CANDIDATES.filter((p) => p !== preferred)];
        return ports.map((port) => {
            const candidate = new URL(url.origin);
            candidate.port = String(port);
            return normalizedBaseUrl(candidate.origin);
        });
    } catch (e) {
        return [configuredBase];
    }
};

const probeHealth = async (base: string, token: string): Promise<boolean> => {
    try {
        const response = await fetch(`${base}/v2/health`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return response.ok;
    } catch (e) {
        return false;
    }
};

const doFetch = async (base: string, config: SaviDaemonConfig, path: string, init: RequestInit) => {
    const response = await fetch(`${base}${path}`, {
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

const request = async (config: SaviDaemonConfig, path: string, init: RequestInit) => {
    const configured = normalizedBaseUrl(config.baseUrl);
    const base = discoveredBaseUrl ?? configured;

    try {
        return await doFetch(base, config, path, init);
    } catch (e) {
        // HTTP-level errors (auth, 4xx/5xx) come back as our Error above and
        // mean the daemon WAS reached — rethrow. Only a network-level failure
        // (fetch rejection: nothing listening / port moved) triggers discovery.
        if (e instanceof Error && e.message.startsWith('savi daemon:')) {
            throw e;
        }

        discoveredBaseUrl = null;

        for (const candidate of candidateBaseUrls(configured)) {
            if (candidate === base) {
                continue; // just failed
            }

            if (await probeHealth(candidate, config.token)) {
                discoveredBaseUrl = candidate;
                return await doFetch(candidate, config, path, init);
            }
        }

        throw e;
    }
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
    const body = await request(config, '/v2/capture/start', jsonInit({ episodeId, show, title, lang }));
    return body.captureId;
};

export const postSubtitles = async (
    config: SaviDaemonConfig,
    { captureId, content, format }: { captureId: string; content: string; format: 'srt' | 'vtt' }
): Promise<void> => {
    await request(config, '/v2/capture/subtitles', jsonInit({ captureId, content, format }));
};

// POST {base}/v2/episode/transcript {episodeId, content, format} — store the
// full subtitle track keyed by episode WITHOUT a capture session, so the daemon
// can build a whole-episode gist for hover-only (never-recorded) episodes.
export const postEpisodeTranscript = async (
    config: SaviDaemonConfig,
    { episodeId, content, format }: { episodeId: string; content: string; format: 'srt' | 'vtt' }
): Promise<void> => {
    await request(config, '/v2/episode/transcript', jsonInit({ episodeId, content, format }));
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
    await request(config, `/v2/capture/chunk?${query.toString()}`, {
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
    const body = await request(config, '/v2/tokenize', jsonInit({ lang, text }));
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
        '/v2/segment',
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
        '/v2/explain',
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
    const path = `/v2/dict/${encodeURIComponent(lang)}/${encodeURIComponent(term)}`;
    const body = await request(config, path, { method: 'GET' });
    return { entries: body.entries ?? [], kanji: body.kanji ?? [] };
};

export interface SaviKanjiExample {
    readonly word: string;
    readonly reading: string;
    readonly gloss: string;
}

/** Full per-kanji breakdown: KANJIDIC on/kun readings + meanings, RTK keyword,
 *  primitive components, the user's + community mnemonic stories, and common
 *  example compounds. The rich kanji view in the tap panel. */
export interface SaviKanjiFull {
    readonly kanji: string;
    readonly keyword: string;
    readonly on: string[];
    readonly kun: string[];
    readonly meanings: string[];
    readonly components: string[];
    readonly story?: string | null;
    readonly communityStory?: string | null;
    readonly examples: SaviKanjiExample[];
}

/** Full kanji breakdown for every kanji in `term` (readings, RTK keyword +
 *  components + stories, example words). Heavier than the dict lookup's lean kanji,
 *  so it's a separate call the tap panel makes; empty when nothing matches. */
export const lookupKanji = async (config: SaviDaemonConfig, lang: string, term: string): Promise<SaviKanjiFull[]> => {
    const path = `/v2/kanji/${encodeURIComponent(lang)}/${encodeURIComponent(term)}`;
    const body = await request(config, path, { method: 'GET' });
    return body.kanji ?? [];
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
        '/v2/anki/mine',
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
    const body = await request(config, '/v2/capture/finish', jsonInit({ captureId }));
    return {
        episodeId: body.episodeId,
        segmentsStitched: body.segmentsStitched,
        totalLines: body.totalLines,
        keptDurationMs: body.keptDurationMs,
    };
};
