// Wake the rest of the extension when credentials APPEAR, however they appear.
//
// The problem this exists for: a target language only reaches the local roaming
// cache with a token, so while signed out `loadRoamingSettings` short-circuits
// and the cache stays empty. Content scripts read that cache once, at bind. So
// a tab that was already open when credentials arrived stays armed against the
// empty language until it is reloaded — glossing dead, exposure mis-scoped.
//
// Sign-in in the options page has its own fix (the hook pulls, then
// broadcasts). This covers the transitions that are NOT a sign-in — which,
// with hour-long tokens and a 20-minute refresh alarm, is most of them:
//
//   - the browser sat closed past the token's lifetime; the first resolution
//     after waking has to refresh before it can answer
//   - the session lapsed while offline and comes back when the network does
//   - a denied refresh cleared the session (account.ts `refresh()` removes it
//     directly), and a later sign-in or refresh restores it
//   - the alarm heartbeat refreshes a session that had gone stale
//
// None of those call `signIn`, so none can be hooked at the ceremony. This
// watches the state instead: a token resolution that yields one where the
// previous yielded none. account.ts calls the observer from
// `currentAccessToken`, which every daemon and cloud request already goes
// through — so no polling is added, and the signal keeps flowing while glossing
// is dead, which is precisely when a request-driven trigger built on GLOSSING
// would have gone silent. Watched-line reports do not stop when glossing does.

import { Command, SettingsUpdatedMessage } from '@project/common';
import { loadRoamingSettings } from './cloud-settings';
import { resolveCloudBase } from './cloud-client';

/** Whether the last resolution in this browser session produced a token.
 *
 *  storage.session, not module memory: MV3 unloads the background after ~30s
 *  idle, and an in-memory flag would reset to "no credentials" on every wake.
 *  The next resolution would then read as a fresh rising edge and re-arm every
 *  bound video, repeatedly. That is not merely wasteful —
 *  `SaviEngagementReporter.start()` calls `_clock.reset()` when it cannot arm,
 *  which DROPS the open block rather than flushing it. So a re-arm that lands
 *  while the roaming cache reads empty (failed pull, offline, no target
 *  language) silently loses accrued watch time. On a ~30s wake cycle that adds
 *  up to exposure nobody can see going missing.
 *
 *  This lifetime is the right one — it survives worker restarts and dies with
 *  the browser, like the credentials do.
 *
 *  Only a boolean is stored. No token is written anywhere new. */
export const CREDENTIAL_STATE_KEY = 'saviHadCredentials';

// In-memory mirror so the hot path (every gloss, dict and watched-line request)
// does not take a storage read. `undefined` = not yet seeded from storage.
let cached: boolean | undefined;
// Single-flight for the cold read, so a burst of resolutions on a fresh worker
// does not race N reads to the same answer.
let seeding: Promise<boolean> | undefined;
// Single-flight for the reaction: the pull is a network round trip, and a burst
// of resolutions must produce one of them, not one each.
let reacting: Promise<void> | undefined;

const readStoredState = async (): Promise<boolean> => {
    try {
        const result = await browser.storage.session.get(CREDENTIAL_STATE_KEY);
        return result?.[CREDENTIAL_STATE_KEY] === true;
    } catch (e) {
        // No storage.session (or access denied): fall back to "had credentials"
        // rather than "had none". Guessing `false` here would manufacture a
        // rising edge on the very next resolution, and a spurious re-arm is not
        // free — `SaviEngagementReporter.start()` resets its clock when it
        // cannot arm, dropping accrued watch time. Better to miss a re-arm.
        //
        // The cost of THIS choice is that the miss is sticky: the state reads
        // "had credentials" from here on, so the next rising edge only comes
        // after a falling one. Until then a tab needs a reload, which is the
        // pre-fix behaviour. Acceptable because this branch is close to
        // unreachable — storage.session is already load-bearing for the
        // capture session, and the background sets its access level at startup.
        return true;
    }
};

const writeStoredState = async (hasToken: boolean): Promise<void> => {
    try {
        await browser.storage.session.set({ [CREDENTIAL_STATE_KEY]: hasToken });
    } catch (e) {
        // Losing the write costs at most one redundant re-arm later.
    }
};

const notifySettingsUpdated = (): void => {
    const command: Command<SettingsUpdatedMessage> = {
        sender: 'asbplayer-settings',
        message: { command: 'settings-updated' },
    };
    // Fire-and-forget: with no options page open there may be no receiver, and
    // "could not establish connection" is the ordinary case, not a failure.
    void Promise.resolve(browser.runtime.sendMessage(command)).catch(() => {});
};

/**
 * Pull the roaming settings, THEN tell every bound video to re-read them.
 *
 * The order is the whole point, and it is the same order the sign-in path uses
 * for the same reason: broadcasting first has every content script re-read the
 * cache that is still empty, which is the bug rather than the fix.
 *
 * A failed pull still broadcasts — the re-arm is worth having on its own, and
 * the next video data sync fetches the language from the cloud anyway.
 */
const rearm = async (cloudUrl: string): Promise<void> => {
    try {
        await loadRoamingSettings(resolveCloudBase(cloudUrl));
    } catch (e) {
        console.warn('savi: could not pull roaming settings after credentials appeared', e);
    }
    notifySettingsUpdated();
};

/**
 * Record a token resolution and re-arm on a rising edge (none → some).
 *
 * Only the rising edge acts. Losing credentials needs no pull (there is nothing
 * to pull with) and no broadcast: a signed-out extension stops glossing because
 * its requests stop being authorized, and re-arming against a cache we can no
 * longer refresh would just restart the controllers against stale values.
 *
 * Resolves once the reaction has settled so tests — and callers that care — can
 * await it; `noteTokenResolution` itself is never awaited on the hot path.
 */
export const noteTokenResolution = async (hasToken: boolean, cloudUrl: string): Promise<void> => {
    if (cached === undefined) {
        seeding = seeding ?? readStoredState();
        const seeded = await seeding;
        seeding = undefined;
        // `cached ?? seeded`, not `= seeded`: several resolutions can be
        // awaiting the same cold read, and by the time the later ones resume an
        // earlier one may already have recorded a newer state. Overwriting it
        // with the value from storage would walk that back.
        cached = cached ?? seeded;
    }

    const previous = cached;

    if (previous === hasToken) {
        return;
    }

    cached = hasToken;
    await writeStoredState(hasToken);

    if (!hasToken) {
        return;
    }

    reacting = reacting ?? rearm(cloudUrl).finally(() => (reacting = undefined));
    await reacting;
};

/** Register the observer on the account module. Call from the background only —
 *  a content script registering this would re-arm per frame. */
export const bindCredentialWatch = (readCloudUrl: () => Promise<string>): ((hasToken: boolean) => void) => {
    return (hasToken: boolean) => {
        // Detached: `currentAccessToken` must not wait on a settings read and a
        // cloud pull to hand back a token it already resolved.
        void (async () => {
            try {
                await noteTokenResolution(hasToken, await readCloudUrl());
            } catch (e) {
                console.warn('savi: credential watch failed', e);
            }
        })();
    };
};

/** Test seam: forget the in-memory mirror so the next call re-seeds from
 *  storage, the way a restarted service worker does. */
export const resetCredentialWatchForTests = (): void => {
    cached = undefined;
    seeding = undefined;
    reacting = undefined;
};
