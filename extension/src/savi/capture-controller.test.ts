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
        const send = jest
            .fn()
            .mockRejectedValueOnce(new Error('no receiver'))
            .mockResolvedValue(undefined);
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
