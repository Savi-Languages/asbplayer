// Account-roaming settings the extension reads/writes on the savi cloud's
// generic key-value store (`GET /v2/settings`, `PUT /v2/settings/{key}`, LWW —
// see savi crates/savi-cloud). Two values roam with the user's account so they
// follow every device: the learner's `targetLanguage` (which streaming subtitle
// track to auto-load, SV-8) and their `openSubtitlesApiKey` (the fallback
// search). The daemon is credential-free and does no cloud I/O, so — like the
// account session itself — the extension talks to the cloud directly with the
// account JWT (extension/src/savi/account.ts).
//
// The cloud is the source of truth; we mirror both values into
// `browser.storage.local` so the content script (target-language auto-select)
// and the background (OpenSubtitles fetch) can read them synchronously and they
// survive offline / signed-out. Cloud reads/writes MUST run from a context with
// host permission for the cloud origin (background or the options/popup pages),
// never a streaming-site content script — that would hit CORS.

import { currentAccessToken } from './account';

export interface SaviRoamingSettings {
    /** BCP-47 tag/subtag of the language being learned, e.g. `es`, `ja`, `es-419`. */
    readonly targetLanguage: string;
    /** opensubtitles.com consumer API key (https://www.opensubtitles.com/vi/consumers). */
    readonly openSubtitlesApiKey: string;
}

export const DEFAULT_ROAMING_SETTINGS: SaviRoamingSettings = { targetLanguage: '', openSubtitlesApiKey: '' };

// browser.storage.local key holding the cached copy.
export const ROAMING_CACHE_KEY = 'saviRoamingSettings';

// Cloud KV keys — each must satisfy the cloud's valid_setting_key (alphanumeric
// + . _ -). One roaming value ⇒ one KV key.
const CLOUD_KEY: { [K in keyof SaviRoamingSettings]: string } = {
    targetLanguage: 'targetLanguage',
    openSubtitlesApiKey: 'openSubtitlesApiKey',
};

const normalizeBaseUrl = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '');

const normalize = (value: unknown): SaviRoamingSettings => {
    const v = (value ?? {}) as Partial<SaviRoamingSettings>;
    return {
        targetLanguage: typeof v.targetLanguage === 'string' ? v.targetLanguage : '',
        openSubtitlesApiKey: typeof v.openSubtitlesApiKey === 'string' ? v.openSubtitlesApiKey : '',
    };
};

/** The locally-cached roaming settings — works offline and signed out. Safe to
 *  call from any context that has `browser.storage.local` (background, content
 *  script, options/popup). */
export const getCachedRoamingSettings = async (): Promise<SaviRoamingSettings> => {
    try {
        const result = await browser.storage.local.get(ROAMING_CACHE_KEY);
        return normalize(result?.[ROAMING_CACHE_KEY]);
    } catch (e) {
        return { ...DEFAULT_ROAMING_SETTINGS };
    }
};

const setCache = (settings: SaviRoamingSettings): Promise<void> =>
    browser.storage.local.set({ [ROAMING_CACHE_KEY]: settings });

// `undefined` return = signed out (no token) — the caller keeps the cache.
const cloudFetch = async (cloudUrl: string, path: string, init: RequestInit): Promise<Response | undefined> => {
    const token = await currentAccessToken();

    if (!token) {
        return undefined;
    }

    return await fetch(`${normalizeBaseUrl(cloudUrl)}${path}`, {
        ...init,
        headers: {
            ...(init.headers ?? {}),
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });
};

/** Pull both roaming values from the cloud into the local cache (call on sign-in
 *  and when a settings UI mounts). A signed-out or unreachable cloud leaves the
 *  cache untouched — same code path as offline. */
export const loadRoamingSettings = async (cloudUrl: string): Promise<SaviRoamingSettings> => {
    try {
        const response = await cloudFetch(cloudUrl, '/v2/settings', { method: 'GET' });

        if (!response || !response.ok) {
            return await getCachedRoamingSettings();
        }

        const body = await response.json();
        const rows = (body?.settings ?? {}) as Record<string, { value?: unknown } | undefined>;
        // Merge: take the cloud's value for a key only when the cloud has a row
        // for it, so a value set locally (e.g. while signed out) is not clobbered
        // by an absent cloud key before its own write-through lands.
        const current = await getCachedRoamingSettings();
        const merged = normalize({
            targetLanguage: rows[CLOUD_KEY.targetLanguage]
                ? rows[CLOUD_KEY.targetLanguage]?.value
                : current.targetLanguage,
            openSubtitlesApiKey: rows[CLOUD_KEY.openSubtitlesApiKey]
                ? rows[CLOUD_KEY.openSubtitlesApiKey]?.value
                : current.openSubtitlesApiKey,
        });
        await setCache(merged);
        return merged;
    } catch (e) {
        return await getCachedRoamingSettings();
    }
};

/** Update one roaming value: cache immediately (optimistic, so it works even
 *  offline), then write through to the cloud (LWW). Throws AFTER the cache is
 *  updated if the write could not be persisted to the account — the caller
 *  surfaces that while the value already works on this device. */
export const putRoamingSetting = async (
    cloudUrl: string,
    key: keyof SaviRoamingSettings,
    value: string
): Promise<SaviRoamingSettings> => {
    const next: SaviRoamingSettings = { ...(await getCachedRoamingSettings()), [key]: value };
    await setCache(next);

    const response = await cloudFetch(cloudUrl, `/v2/settings/${CLOUD_KEY[key]}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, updatedAtMs: Date.now() }),
    });

    if (response === undefined) {
        throw new Error('Sign in to your savi account to save this across your devices.');
    }

    if (!response.ok) {
        throw new Error(`savi cloud: failed to save setting (${response.status})`);
    }

    return next;
};
