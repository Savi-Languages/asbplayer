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

import { siteSet } from './site-set';

const KEY = 'saviMutedSites';
const MAX_MUTED = 500;

/** The single key every `file://` page shares — see the header. */
export const LOCAL_FILE_SITE_KEY = 'file://';

const sites = siteSet(KEY, MAX_MUTED);

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
export const mutedSites = (): Promise<string[]> => sites.all();

export const isSiteMuted = (siteKey: string): Promise<boolean> => sites.has(siteKey);

/** Mute a site. Most-recent last; oldest dropped past MAX_MUTED. */
export const muteSite = (siteKey: string): Promise<void> => sites.add(siteKey);

export const unmuteSite = (siteKey: string): Promise<void> => sites.remove(siteKey);

/** Overwrite the local list from the account's copy (cloud → device mirror).
 *  Wholesale, not merged: the account list already won a last-write-wins race,
 *  and merging here would resurrect entries another device removed. */
export const replaceMutedSites = (siteKeys: string[]): Promise<void> => sites.replace(siteKeys);

/** Test seam — drops the in-process mirror so the next read hits storage. */
export const resetMutedSitesMemo = (): void => sites.resetMemo();
