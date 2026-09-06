jest.mock('./hover-dict', () => ({
    lineElement: (target: Element) => target?.closest?.('.asbplayer-subtitle-text') ?? null,
}));
import { interestCue, SaviWatchInterest } from './watch-interest';
const cues = [{ text: '準備に手間取った', start: 1000, end: 4000, track: 0 }];
const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};
describe('paused subtitle interest', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.useRealTimers();
        document.body.innerHTML = '';
    });
    test('only current primary exact cues qualify', () => {
        expect(interestCue(cues, '準備に 手間取った', 2000)).toBe(cues[0]);
        expect(interestCue(cues, 'notification', 2000)).toBeUndefined();
        expect(interestCue(cues, '準備に手間取った', 4500)).toBeUndefined();
        expect(interestCue([{ ...cues[0], track: 1 }], cues[0].text, 2000)).toBeUndefined();
    });
    test('requires dwell while paused; deduplicates and cancels on play', async () => {
        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: true, configurable: true });
        video.currentTime = 2;
        const send = jest.fn(async (message: any) =>
            message.command === 'savi-watch-interest-config'
                ? { enabled: true, account: 'u', mode: 'explore' }
                : { ok: true }
        );
        const controller = new SaviWatchInterest({
            video,
            subtitles: () => cues,
            metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
            send,
        });
        document.body.innerHTML = '<span class="asbplayer-subtitle-text">準備に手間取った</span>';
        const line = document.querySelector('span')!;
        controller.start('ja');
        await flush();
        line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        jest.advanceTimersByTime(1499);
        expect(send.mock.calls.filter(([m]) => m.command === 'savi-save-watch-interest')).toHaveLength(0);
        jest.advanceTimersByTime(1);
        await flush();
        expect(send.mock.calls.filter(([m]) => m.command === 'savi-save-watch-interest')).toHaveLength(1);
        document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        jest.advanceTimersByTime(2000);
        await flush();
        expect(send.mock.calls.filter(([m]) => m.command === 'savi-save-watch-interest')).toHaveLength(1);
        controller.stop();
        controller.start('ja');
        await flush();
        line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        video.dispatchEvent(new Event('play'));
        jest.advanceTimersByTime(2000);
        await flush();
        expect(send.mock.calls.filter(([m]) => m.command === 'savi-save-watch-interest')).toHaveLength(1);
        controller.stop();
    });
    test('disabled preference prevents saving', async () => {
        const video = document.createElement('video');
        video.currentTime = 2;
        const send = jest.fn(async () => ({ enabled: false, account: 'u' }));
        const controller = new SaviWatchInterest({
            video,
            subtitles: () => cues,
            metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
            send,
        });
        document.body.innerHTML = '<span class="asbplayer-subtitle-text">準備に手間取った</span>';
        controller.start('ja');
        await flush();
        document.querySelector('span')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        jest.advanceTimersByTime(2000);
        expect(send).toHaveBeenCalledTimes(1);
        controller.stop();
    });
});

test('Listen has a reversible text reveal and teardown restores subtitles', async () => {
    const video = document.createElement('video');
    const onModeChange = jest.fn();
    const c = new SaviWatchInterest({
        video,
        subtitles: () => cues,
        metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
        onModeChange,
        send: jest.fn(async () => ({ account: 'u', enabled: true, mode: 'listen' })),
    });
    c.start('ja');
    await flush();
    expect(onModeChange).toHaveBeenLastCalledWith('listen', true);
    const shadow = document.querySelector('[data-savi-immersion]')!.shadowRoot!;
    const button = Array.from(shadow.querySelectorAll('button')).find((b) => b.textContent === 'Reveal text')!;
    button.click();
    expect(onModeChange).toHaveBeenLastCalledWith('listen', false);
    button.click();
    expect(onModeChange).toHaveBeenLastCalledWith('listen', true);
    c.stop();
    expect(onModeChange).toHaveBeenLastCalledWith('watch', false);
    expect(document.querySelector('[data-savi-immersion]')).toBeNull();
});
