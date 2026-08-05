// The savi CLOUD API client for extension-side calls that go STRAIGHT to the
// cloud (not the localhost daemon). The cloud holds every AI key (SV-16); the
// extension authenticates with the signed-in account's Supabase JWT.
//
// Currently the seam is the AI translation proxy that glossing / single-word
// translation (SV-13 / SV-12) will consume — labelling a target-language word in
// the user's known language. Kept deliberately thin: one fetch, no UI.

import { currentAccessToken } from './account';

// The cloud base URL is the caller's `saviCloudUrl` setting (default
// https://savi.tianxiaocao.com — our own domain, whose `/v2` proxy targets Cloud
// Run so the host survives URL changes). Passing it in — rather than hardcoding
// prod — lets a build point the extension at http://localhost:8080.
const normalizeBaseUrl = (baseUrl: string): string => baseUrl.trim().replace(/\/+$/, '');

// A DEV build (`yarn build:dev` or `yarn dev:extension` — both Vite `development`
// mode) routes the gloss cloud calls at the local cloud, so you never touch the
// "Savi cloud URL" field. Override the host/port with WXT_SAVI_CLOUD_URL at build
// time. A production build leaves this undefined → the caller's setting is used.
const DEV_CLOUD_URL: string | undefined = import.meta.env.DEV
    ? (import.meta.env.WXT_SAVI_CLOUD_URL as string | undefined)?.trim() || 'http://localhost:8080'
    : undefined;

/** The cloud base to hit: the dev override when a dev build baked one in, else
 *  the caller's configured `saviCloudUrl`. Exported so the roaming-settings
 *  callers (which pass `saviCloudUrl` to cloud-settings) get the same dev
 *  redirect — otherwise a dev build would gloss against localhost but still roam
 *  the target language against prod, and the two never meet. */
export const resolveCloudBase = (cloudUrl: string): string => normalizeBaseUrl(DEV_CLOUD_URL ?? cloudUrl);

// Abort a cloud call that stalls: these run in the background on behalf of a
// content-script message, and the message MUST get an answer — a fetch that
// never settles would leave the caller (and its concurrency slot) hanging.
const FETCH_TIMEOUT_MS = 8000;

const fetchWithTimeout = async (input: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
};

export interface TranslateResult {
    /** The translated text. */
    text: string;
    /** Which provider served it: "deepl" or "llm:<provider>". */
    provider: string;
    /** DeepL's detected source language (uppercase ISO), when it served the call. */
    detectedSourceLang?: string;
}

/** Translate `text` into `targetLang` (e.g. 'en') via the cloud AI proxy at
 *  `cloudUrl` — DeepL first, LLM fallback. `sourceLang` is optional
 *  (auto-detected). `context` (e.g. the full subtitle line) influences the
 *  translation but is not itself translated — it powers a context-aware
 *  single-word gloss (SV-12/13; DeepL has no word alignment, so context is the
 *  mechanism). Requires the user to be signed in (the JWT is relayed to the
 *  cloud, which holds every key). Throws when signed out or on a non-2xx response. */
export const translate = async (
    cloudUrl: string,
    text: string,
    targetLang: string,
    sourceLang?: string,
    context?: string
): Promise<TranslateResult> => {
    const token = await currentAccessToken();
    if (!token) {
        throw new Error('sign in to use AI translation');
    }
    const response = await fetchWithTimeout(`${resolveCloudBase(cloudUrl)}/v2/ai/translate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            targetLang,
            ...(sourceLang ? { sourceLang } : {}),
            ...(context ? { context } : {}),
        }),
    });
    if (!response.ok) {
        throw new Error(`cloud translate failed: HTTP ${response.status}`);
    }
    return (await response.json()) as TranslateResult;
};

/** One word's glossing verdict from the cloud (mirrors savi-cloud's
 *  `GlossWord`; `skip` is serde kebab-case). */
export interface GlossDecision {
    readonly word: string;
    readonly lemma?: string;
    readonly skip?: 'known' | 'function-word' | 'untokenized';
    readonly proficiency?: number;
    readonly gloss?: string;
}

export interface GlossLineResult {
    readonly words: readonly GlossDecision[];
    readonly threshold: number;
}

/** Decide + label one subtitle line (POST /v2/gloss) — SV-40.
 *
 *  The decision belongs on the server because the LEMMATIZER is there: the
 *  extension only ever sees surfaces, so it can never tell that `sabía` is the
 *  `saber` the learner already knows. Throws when signed out or on a non-2xx
 *  response; the caller leaves the line unglossed rather than guessing. */
export const glossLine = async (
    cloudUrl: string,
    lang: string,
    glossLang: string,
    line: string,
    words: readonly string[]
): Promise<GlossLineResult> => {
    const token = await currentAccessToken();
    if (!token) {
        throw new Error('sign in to use glossing');
    }
    const response = await fetchWithTimeout(`${resolveCloudBase(cloudUrl)}/v2/gloss`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, glossLang, line, words }),
    });
    if (!response.ok) {
        throw new Error(`cloud gloss failed: HTTP ${response.status}`);
    }
    return (await response.json()) as GlossLineResult;
};

/** A word's learning bucket, mirroring savi-core's `Bucket` (serde snake_case). */
export type WordBucket = 'new' | 'word_box' | 'known';

/** Known-INCLUSIVE per-lemma bucket map for `lang` (GET /v2/words/{lang}/buckets)
 *  at `cloudUrl`. Untracked lemmas are absent. Glossing (SV-13) reads this to
 *  gloss a word iff its lemma is not yet `known`. Returns `{}` when signed out (so
 *  glossing degrades to glossing all content words); throws on a non-2xx response. */
export const wordBuckets = async (cloudUrl: string, lang: string): Promise<Record<string, WordBucket>> => {
    const token = await currentAccessToken();
    if (!token) {
        return {};
    }
    const response = await fetchWithTimeout(`${resolveCloudBase(cloudUrl)}/v2/words/${encodeURIComponent(lang)}/buckets`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`cloud word buckets failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { buckets?: Record<string, WordBucket> };
    return body.buckets ?? {};
};

/** Per-lemma proficiency [0,1] from the SV-20 review engine
 *  (GET /v2/words/{lang}/proficiency): exposure-weighted mean retrievability.
 *  Untracked lemmas are absent (treat as 0 → gloss). Returns undefined when
 *  signed out; throws on a non-2xx response (an old cloud → the caller falls
 *  back to buckets). */
export const wordsProficiency = async (
    cloudUrl: string,
    lang: string
): Promise<Record<string, number> | undefined> => {
    const token = await currentAccessToken();
    if (!token) {
        return undefined;
    }
    const response = await fetchWithTimeout(
        `${resolveCloudBase(cloudUrl)}/v2/words/${encodeURIComponent(lang)}/proficiency`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!response.ok) {
        throw new Error(`cloud word proficiency failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { proficiency?: Record<string, number> };
    return body.proficiency ?? {};
};

/** Ask the cloud to fold this language's Level-2 projection NOW
 *  (`POST /v2/words/{lang}/warm`), so the first gloss of a video doesn't absorb
 *  the cold fold — which takes ~20s against a remote Postgres, far past this
 *  client's 8s budget.
 *
 *  Fire-and-forget by design: the caller wants the SERVER-SIDE side effect, not
 *  the payload. Resolves silently when signed out, and an aborted call still
 *  leaves the fold running on the cloud, so a timeout here is not a failure.
 *
 *  Throws on a non-2xx response, like every other call in this file — the
 *  caller (`_warmProjections` in background-handler.ts) already swallows
 *  whatever this throws, so nothing about glossing changes. What this fixes is
 *  visibility: a 401 (expired JWT), a 404 (a cloud predating this route) or a
 *  500 used to resolve as silent success with nothing logged anywhere, which
 *  made "is the cold start actually fixed?" unanswerable without guessing —
 *  the exact failure mode that cost two rounds of misdiagnosis on the original
 *  bug. Logged on the console under the same `savi: gloss —` prefix gloss.ts's
 *  debug channel uses; this fires once per video bind, so it can never flood
 *  it. */
export const warmProjections = async (cloudUrl: string, lang: string): Promise<void> => {
    const token = await currentAccessToken();
    if (!token) {
        return;
    }
    const response = await fetchWithTimeout(
        `${resolveCloudBase(cloudUrl)}/v2/words/${encodeURIComponent(lang)}/warm`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: '{}',
        }
    );
    if (!response.ok) {
        console.debug(`savi: gloss — warm failed: HTTP ${response.status}`);
        throw new Error(`cloud warm failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { cached?: boolean; lemmas?: number; foldedAtMs?: number };
    console.debug(`savi: gloss — warm ok (cached=${body.cached}, lemmas=${body.lemmas}, foldedAtMs=${body.foldedAtMs})`);
};

/** The default gloss-decision threshold: gloss when proficiency < this. */
export const DEFAULT_GLOSS_THRESHOLD = 0.8;

/** The roaming `review.glossThreshold` setting (GET /v2/settings), defaulting
 *  to [`DEFAULT_GLOSS_THRESHOLD`] when unset / signed out / unreachable. */
export const glossThreshold = async (cloudUrl: string): Promise<number> => {
    try {
        const token = await currentAccessToken();
        if (!token) {
            return DEFAULT_GLOSS_THRESHOLD;
        }
        const response = await fetchWithTimeout(`${resolveCloudBase(cloudUrl)}/v2/settings`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!response.ok) {
            return DEFAULT_GLOSS_THRESHOLD;
        }
        const body = (await response.json()) as {
            settings?: Record<string, { value?: unknown } | undefined>;
        };
        const review = body.settings?.['review']?.value as { glossThreshold?: unknown } | undefined;
        const raw = review?.glossThreshold;
        return typeof raw === 'number' && raw > 0 && raw < 1 ? raw : DEFAULT_GLOSS_THRESHOLD;
    } catch {
        return DEFAULT_GLOSS_THRESHOLD;
    }
};
