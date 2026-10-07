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
import type { SaviCapturePingResponse, SaviCapturePingToVideoMessage, SaviCommand } from './messages';

/** How long the owning tab gets to answer a ping. A live controller answers in
 *  a few ms; this only bounds a tab that cannot answer at all (frozen, or some
 *  other listener holding the channel open). */
const OWNER_PING_TIMEOUT_MS = 2000;

/**
 * Whether any capture controller in `tabId` is still feeding a capture. The
 * content script is the only thing that ever feeds one, so it — not our record,
 * and not the daemon — is the authority on whether the record has an owner.
 * Controllers that are not capturing stay silent, so no answer (no frame, no
 * listener, a rejected send, a timeout) all mean the same thing: nobody is.
 */
export const ownerIsCapturing = async (tabId: number): Promise<boolean> => {
    const command: SaviCommand<SaviCapturePingToVideoMessage> = {
        sender: 'savi-extension-to-video',
        message: { command: 'savi-capture-ping' },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        const response = (await Promise.race([
            browser.tabs.sendMessage(tabId, command),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), OWNER_PING_TIMEOUT_MS);
            }),
        ])) as SaviCapturePingResponse | undefined;
        return response?.capturing === true;
    } catch (e) {
        return false;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * The record used to be trusted unless its TAB had closed, which misses the
 * ways it actually goes stale — and left no recovery except closing the tab,
 * because nothing else ever clears it:
 *
 *  - **The tab navigated.** One tab plays one thing, so a session for a
 *    different episode in the SAME tab cannot still be capturing. This is the
 *    common case: watch one video, let it go idle, open the next in that tab.
 *  - **The daemon ended it.** Its orphan sweeper reaps sessions nobody is
 *    feeding, with no notification. `GET /v2/capture/state` is the authority;
 *    anything it does not list is over.
 *  - **The page reloaded.** The content script that fed the capture died with
 *    the page, but this record (storage.session) and the daemon's session both
 *    outlive it — the daemon keeps listing an unfed capture until its sweeper
 *    runs, 90 minutes later. For that whole window the reloaded page was told
 *    "a savi capture is already running" about a capture nothing was running,
 *    with subtitles on screen and nothing being recorded. So the last word goes
 *    to the owning tab itself: if no controller there says it is capturing, the
 *    record has no owner.
 *
 * A daemon that cannot answer — older build without the route, or unreachable —
 * yields `undefined`, and that silence is never read as "nothing is running":
 * it would throw away a live capture's bookkeeping on any hiccup. The owner
 * check is safe in exactly the way that inference is not — a live capture has a
 * live controller, and a live controller answers.
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

    if (active !== undefined && !active.includes(session.episodeId)) {
        return true; // the daemon ended it
    }

    return !(await ownerIsCapturing(session.tabId)); // nobody is feeding it
};
