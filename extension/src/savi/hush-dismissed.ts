// Sites where the user has closed the "Don't use Savi on this site" prompt.
//
// The prompt (language-hush.ts) appears whenever the language gate is GUESSING,
// which on a site with no language signal is every video, forever. Its button
// is a one-way answer — "switch savi off here" — so a user who wants savi to
// run on that site had no answer at all, and got nagged on every load.
//
// The ✕ is that answer: it closes the prompt for the SITE, not merely for the
// current page, because a dismissal that lasts one video is not a dismissal.
// Deliberately a separate set from muted-sites: dismissing the offer is the
// opposite decision from accepting it, and storing them together would make
// the ✕ behave like the very button it declines.
//
// Local only, unlike the mute list. This is nag state, not a preference: it
// says nothing about what the user wants learned, so it does not earn a place
// in the account or a row in the settings UI.

import { siteSet } from './site-set';

const KEY = 'saviHushDismissedSites';
const MAX_DISMISSED = 500;

const sites = siteSet(KEY, MAX_DISMISSED);

/** Stop offering the hush prompt on this site. */
export const dismissHushFor = (siteKey: string): Promise<void> => sites.add(siteKey);

export const isHushDismissed = (siteKey: string): Promise<boolean> => sites.has(siteKey);

/** Offer the prompt here again (used when the site is un-muted from settings —
 *  the user is clearly re-engaging with the decision). */
export const clearHushDismissal = (siteKey: string): Promise<void> => sites.remove(siteKey);

/** Test seam — drops the in-process mirror so the next read hits storage. */
export const resetHushDismissedMemo = (): void => sites.resetMemo();
