import { NO_CAPTURE_TARGET_NOTICE, requestStartWithFeedback } from './request-start';

const deps = (sendToTab: jest.Mock, notifyTopFrame = jest.fn().mockResolvedValue(undefined)) => ({
    sendToTab,
    notifyTopFrame,
});

describe('requestStartWithFeedback', () => {
    it('stays silent when a frame took the request', async () => {
        // The qualifying frame — the one with subtitles loaded — answered, so
        // capture is starting and a "nothing to capture" toast would be a lie.
        const notify = jest.fn();
        const d = deps(jest.fn().mockResolvedValue({ requested: true }), notify);

        expect(await requestStartWithFeedback(7, d)).toBe(true);
        expect(notify).not.toHaveBeenCalled();
    });

    it('explains itself when no frame answered', async () => {
        // The silence this exists to fix: every frame declined the broadcast
        // because none had a subtitle track, so nothing happened and nothing
        // said why.
        const notify = jest.fn().mockResolvedValue(undefined);
        const d = deps(jest.fn().mockResolvedValue(undefined), notify);

        expect(await requestStartWithFeedback(7, d)).toBe(false);
        expect(notify).toHaveBeenCalledWith(7, NO_CAPTURE_TARGET_NOTICE);
    });

    it('notifies the TOP FRAME only, not every frame', async () => {
        // The request is broadcast tab-wide; the notice must not be, or a page
        // with N frames stacks N identical toasts.
        const notify = jest.fn().mockResolvedValue(undefined);
        const d = deps(jest.fn().mockResolvedValue(undefined), notify);

        await requestStartWithFeedback(7, d);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('treats an explicit requested:false as unclaimed', async () => {
        const notify = jest.fn().mockResolvedValue(undefined);
        const d = deps(jest.fn().mockResolvedValue({ requested: false }), notify);

        expect(await requestStartWithFeedback(7, d)).toBe(false);
        expect(notify).toHaveBeenCalledWith(7, NO_CAPTURE_TARGET_NOTICE);
    });

    it('treats a rejected dispatch as unclaimed rather than throwing', async () => {
        // No content script on the page (a settings tab, the Web Store) rejects
        // with "Could not establish connection" — an ordinary miss, not a crash
        // in the background worker.
        const notify = jest.fn().mockResolvedValue(undefined);
        const d = deps(jest.fn().mockRejectedValue(new Error('Could not establish connection')), notify);

        await expect(requestStartWithFeedback(7, d)).resolves.toBe(false);
        expect(notify).toHaveBeenCalled();
    });

    it('does not let a failed notice throw out of the dispatch', async () => {
        // A page that cannot receive the request usually cannot show a toast
        // either; that second failure must not become an unhandled rejection.
        const notify = jest.fn().mockRejectedValue(new Error('no receiver'));
        const d = deps(jest.fn().mockResolvedValue(undefined), notify);

        await expect(requestStartWithFeedback(7, d)).resolves.toBe(false);
    });
});
