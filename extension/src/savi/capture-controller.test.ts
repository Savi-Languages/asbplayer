import { sendWithRetry } from './capture-controller';

const noSleep = async () => {};

describe('sendWithRetry', () => {
    it('returns immediately when the first attempt lands', async () => {
        const send = jest.fn().mockResolvedValue(undefined);
        expect(await sendWithRetry(send, 3, 1, noSleep)).toBe(true);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('retries a transient failure and succeeds', async () => {
        // MV3 rejects sendMessage while the service worker tears down — which
        // is exactly when a pause op gets sent. One retry usually wakes it.
        const send = jest.fn().mockRejectedValueOnce(new Error('no receiver')).mockResolvedValue(undefined);
        expect(await sendWithRetry(send, 3, 1, noSleep)).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('reports failure after exhausting attempts, rather than throwing', async () => {
        // The caller logs a warning. Throwing here would surface as an
        // unhandled rejection in a content script and tell nobody anything.
        const send = jest.fn().mockRejectedValue(new Error('gone'));
        expect(await sendWithRetry(send, 3, 1, noSleep)).toBe(false);
        expect(send).toHaveBeenCalledTimes(3);
    });

    it('backs off progressively between attempts', async () => {
        // A tearing-down worker needs a moment; hammering it immediately three
        // times is three failures rather than one recovery.
        const waits: number[] = [];
        const send = jest.fn().mockRejectedValue(new Error('gone'));
        await sendWithRetry(send, 3, 100, async (ms) => void waits.push(ms));
        expect(waits).toEqual([100, 200]);
    });
});

// ── What a finished capture is allowed to claim ──────────────────────────
//
// A transcript-only finish was announced as "episode saved (subtitles only)"
// whether or not the session had been asked to record. For a subtitles-only
// session that is accurate. For a session that asked for audio it is a false
// success: nothing entered the library, and the only signal that a whole
// watched episode produced no take was a toast saying it had been saved.
import { captureStartNotice, finishNotice } from './capture-controller';

describe('finishNotice', () => {
    it('reports a normal audio finish with what was kept', () => {
        const notice = finishNotice({ totalLines: 312, keptDurationMs: 845000 });
        expect(notice.text).toContain('312');
        expect(notice.text).toContain('14.1'); // minutes of dialogue
        expect(notice.consoleError).toBeUndefined();
    });

    it('calls a subtitles-only session saved, because it was', () => {
        const notice = finishNotice({ totalLines: 100, transcriptOnly: true, audioRequested: false });
        expect(notice.text).toContain('saved');
        expect(notice.text).toContain('subtitles only');
        expect(notice.consoleError).toBeUndefined();
    });

    it('does NOT call it saved when audio was requested and none arrived', () => {
        const notice = finishNotice({ totalLines: 100, transcriptOnly: true, audioRequested: true });
        expect(notice.text).not.toContain('saved');
        expect(notice.text.toLowerCase()).toContain('no audio');
        // Loud in the tab console, where the person watching actually is —
        // the same treatment `condenseWarning` already gets.
        expect(notice.consoleError).toBeDefined();
    });

    it('keeps naming audio that was recorded and then lost', () => {
        const notice = finishNotice({
            totalLines: 100,
            transcriptOnly: true,
            audioRequested: true,
            audioLost: 'kept none of 4 segments',
        });
        expect(notice.consoleError).toContain('kept none of 4 segments');
    });
});

describe('captureStartNotice', () => {
    it('names what the tap attached to, so "recording" is checkable', () => {
        // sourceApp was returned by the daemon from the start and surfaced
        // nowhere, leaving "which process is it recording?" unanswerable
        // without reading the daemon's working directory.
        const notice = captureStartNotice({ state: 'recording', sourceApp: 'Google Chrome' });
        expect(notice).toContain('Google Chrome');
    });

    it('still announces recording when the source is not yet known', () => {
        expect(captureStartNotice({ state: 'recording' })).toContain('capturing episode');
    });

    it('says audio is off when it was deliberately off', () => {
        expect(captureStartNotice({ state: 'disabled' })).toContain('audio recording is off');
    });

    it('names the reason when the tap declined', () => {
        expect(captureStartNotice({ state: 'unavailable', reason: 'permission denied' })).toContain(
            'permission denied'
        );
    });
});

// ── Learning mid-episode that nothing is being recorded ──────────────────
//
// The daemon now reports `audio: 'off', audioRequested: true` when it is
// discarding segment ops. That reaches the desktop app's stderr and analytics
// — neither of which the person watching is looking at. This is the check that
// puts it in front of them, once, in the tab.
import { droppedOpsWarning } from './capture-controller';

describe('droppedOpsWarning', () => {
    it('fires when the daemon is discarding ops it was asked to record', () => {
        expect(droppedOpsWarning({ audio: 'off', audioRequested: true }, false)).toBeDefined();
    });

    it('stays quiet for a session that never wanted audio', () => {
        expect(droppedOpsWarning({ audio: 'off', audioRequested: false }, false)).toBeUndefined();
    });

    it('stays quiet while audio is actually recording', () => {
        expect(droppedOpsWarning({ audio: 'recording', audioRequested: true }, false)).toBeUndefined();
    });

    it('fires once, not once per op batch', () => {
        // Ops go out continuously while watching; this must not become a toast
        // every few seconds for the rest of the episode.
        expect(droppedOpsWarning({ audio: 'off', audioRequested: true }, true)).toBeUndefined();
    });

    it('says nothing when the daemon predates the field', () => {
        expect(droppedOpsWarning({ audio: 'off' }, false)).toBeUndefined();
        expect(droppedOpsWarning(undefined, false)).toBeUndefined();
    });
});
