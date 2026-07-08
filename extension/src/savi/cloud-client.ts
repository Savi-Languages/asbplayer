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
 *  the caller's configured `saviCloudUrl`. */
const resolveCloudBase = (cloudUrl: string): string => normalizeBaseUrl(DEV_CLOUD_URL ?? cloudUrl);

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
    const response = await fetch(`${resolveCloudBase(cloudUrl)}/v2/ai/translate`, {
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
    const response = await fetch(`${resolveCloudBase(cloudUrl)}/v2/words/${encodeURIComponent(lang)}/buckets`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`cloud word buckets failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { buckets?: Record<string, WordBucket> };
    return body.buckets ?? {};
};
