import { replayFrom } from './replay';

describe('platform-aware replay', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('seeks in seconds and propagates native playback refusal', async () => {
        const video = document.createElement('video');
        const failure = new DOMException('Playback blocked', 'NotAllowedError');
        video.play = jest.fn().mockRejectedValue(failure);
        const seek = jest.fn();
        await expect(replayFrom(video, 1500, seek, false)).rejects.toBe(failure);
        expect(seek).toHaveBeenCalledWith(1.5);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('finishes an acknowledged Netflix play and removes both listeners', async () => {
        const video = document.createElement('video');
        video.play = jest.fn();
        const removed = jest.spyOn(video, 'removeEventListener');
        const acknowledge = jest.fn(() => video.dispatchEvent(new Event('playing')));
        document.addEventListener('asbplayer-netflix-play', acknowledge, { once: true });
        await replayFrom(video, 1000, jest.fn(), true);
        expect(acknowledge).toHaveBeenCalledTimes(1);
        expect(video.play).not.toHaveBeenCalled();
        expect(removed).toHaveBeenCalledWith('play', expect.any(Function));
        expect(removed).toHaveBeenCalledWith('playing', expect.any(Function));
        expect(jest.getTimerCount()).toBe(0);
    });

    test.each([false, true])('reports an unacknowledged player instead of hanging (Netflix=%s)', async (netflix) => {
        const video = document.createElement('video');
        video.play = jest.fn(() => new Promise<void>(() => {}));
        const removed = jest.spyOn(video, 'removeEventListener');
        const pending = expect(replayFrom(video, 1000, jest.fn(), netflix)).rejects.toThrow('Playback did not start');
        jest.advanceTimersByTime(10000);
        await pending;
        expect(removed).toHaveBeenCalledWith('play', expect.any(Function));
        expect(removed).toHaveBeenCalledWith('playing', expect.any(Function));
        expect(jest.getTimerCount()).toBe(0);
    });

    test('seeks an already playing Netflix video without waiting for a new play event', async () => {
        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false });
        const seek = jest.fn();
        await replayFrom(video, 2000, seek, true);
        expect(seek).toHaveBeenCalledWith(2);
        expect(jest.getTimerCount()).toBe(0);
    });
});
