// Sites the user has switched savi off for (SV-44).
//
// The per-EPISODE mute (muted-episodes.ts) answers "this one video is not in my
// learning language". This answers a different question — "never run savi
// here at all" — and it became necessary when savi started binding to any page
// with a video, not just the sites with a delegate. A per-episode escape hatch
// does not help when the offender is a site that plays a video on every page.
//
// Keyed by bare hostname (`youtube.com`, not `www.youtube.com`) so one mute
// covers the www and bare forms, and subdomains are muted independently —
// muting `mail.example.com` should not take out `example.com`.
//
// Local files share the single key `file://`: they have no host, and "don't use
// savi on files I open from disk" is a coherent thing to want.
//
// Bounded MRU for the same reason as the episode list: an unbounded list
// written from a content script is a leak waiting to happen.

const KEY = 'saviMutedSites';
const MAX_MUTED = 500;

/** The single key every `file://` page shares — see the header. */
export const LOCAL_FILE_SITE_KEY = 'file://';

/** In-process mirror so the gate's hot path doesn't hit storage per video. */
let memo: string[] | undefined;

const read = async (): Promise<string[]> => {
    if (memo !== undefined) return memo;
    try {
        const stored = await browser.storage.local.get(KEY);
        const list = (stored as Record<string, unknown>)[KEY];
        memo = Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : [];
    } catch {
        // Storage unavailable → behave as "nothing muted", which fails open,
        // matching the gate's posture everywhere else.
        memo = [];
    }
    return memo;
};

const write = async (list: string[]): Promise<void> => {
    memo = list;
    try {
        await browser.storage.local.set({ [KEY]: list });
    } catch {
        // Keep the in-process value: the mute still holds for this session.
    }
};

/**
 * The mute key for a page URL, or `undefined` when there is nothing muteable
 * (an unparseable URL, or a scheme with no meaningful site).
 *
 * Pure and total — never throws, so a caller can hand it `window.location.href`
 * without guarding.
 */
export const siteKeyForUrl = (url: string): string | undefined => {
    const raw = typeof url === 'string' ? url.trim() : '';
    if (raw.length === 0) {
        return undefined;
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return undefined;
    }

    if (parsed.protocol === 'file:') {
        return LOCAL_FILE_SITE_KEY;
    }

    const host = parsed.host.replace(/^www\./, '').toLowerCase();
    return host.length > 0 ? host : undefined;
};

/** The muted set, for handing to `decideLanguageGate`. */
export const mutedSites = async (): Promise<string[]> => [...(await read())];

export const isSiteMuted = async (siteKey: string): Promise<boolean> => (await read()).includes(siteKey);

/** Mute a site. Most-recent last; oldest dropped past MAX_MUTED. */
export const muteSite = async (siteKey: string): Promise<void> => {
    const list = (await read()).filter((e) => e !== siteKey);
    list.push(siteKey);
    await write(list.slice(-MAX_MUTED));
};

export const unmuteSite = async (siteKey: string): Promise<void> => {
    await write((await read()).filter((e) => e !== siteKey));
};

/** Test seam — drops the in-process mirror so the next read hits storage. */
export const resetMutedSitesMemo = (): void => {
    memo = undefined;
};
