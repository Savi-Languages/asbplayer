// When a stored capture session is bookkeeping to discard rather than a capture
// that is genuinely still running.
//
// Its own module, not a helper inside background-handler.ts: that file reaches
// `import.meta.env` through cloud-client and so cannot be loaded by jest at all,
// which is why none of its logic has ever been under test. This rule is exactly
// the kind that needs to be.

import { captureState } from './daemon-client';
import type { SaviDaemonConfig } from './daemon-client';
import type { CaptureSessionRecord } from './capture-session';

/**
 * The record used to be trusted unless its TAB had closed, which misses the two
 * ways it actually goes stale — and left no recovery except closing the tab,
 * because nothing else ever clears it:
 *
 *  - **The tab navigated.** One tab plays one thing, so a session for a
 *    different episode in the SAME tab cannot still be capturing. This is the
 *    common case: watch one video, let it go idle, open the next in that tab.
 *  - **The daemon ended it.** Its orphan sweeper reaps sessions nobody is
 *    feeding, with no notification. `GET /v2/capture/state` is the authority;
 *    anything it does not list is over.
 *
 * A daemon that cannot answer — older build without the route, or unreachable —
 * yields `undefined`, and we then keep the session. Treating silence as "nothing
 * is running" would throw away a live capture's bookkeeping on any hiccup, which
 * is the more damaging direction to be wrong in: it loses recorded audio, while
 * being wrong the other way only shows an error the user can act on.
 */
export const isStaleCaptureSession = async (
    session: CaptureSessionRecord,
    requestedEpisodeId: string,
    requestingTabId: number,
    config: SaviDaemonConfig
): Promise<boolean> => {
    try {
        await browser.tabs.get(session.tabId);
    } catch (e) {
        return true; // tab is gone
    }

    if (session.tabId === requestingTabId && session.episodeId !== requestedEpisodeId) {
        return true; // that tab moved on to something else
    }

    const active = await captureState(config);
    return active !== undefined && !active.includes(session.episodeId);
};
