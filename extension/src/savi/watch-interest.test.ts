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
            seek: jest.fn(),
            play: jest.fn(),
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
            seek: jest.fn(),
            play: jest.fn(),
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
        seek: jest.fn(),
        play: jest.fn(),
        video,
        subtitles: () => cues,
        metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
        onModeChange,
        send: jest.fn(async () => ({ account: 'u', enabled: true, mode: 'listen' })),
    });
    c.setToolbarEnabled(true);
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

test('a mode choice wins over an older config request', async () => {
    const video = document.createElement('video');
    const onModeChange = jest.fn();
    let resolveConfig!: (value: unknown) => void;
    const send = jest.fn((message: any) => {
        if (message.command === 'savi-watch-interest-config') {
            return new Promise((resolve) => {
                resolveConfig = resolve;
            });
        }
        return Promise.resolve({ ok: true });
    });
    const controller = new SaviWatchInterest({
        seek: jest.fn(),
        play: jest.fn(),
        video,
        subtitles: () => cues,
        metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
        onModeChange,
        send,
    });
    controller.setToolbarEnabled(true);
    controller.start('ja');
    const shadow = document.querySelector('[data-savi-immersion]')!.shadowRoot!;
    const explore = Array.from(shadow.querySelectorAll('button')).find((b) => b.textContent === 'Explore')!;
    explore.click();
    await flush();
    resolveConfig({ account: 'u', enabled: true, mode: 'listen' });
    await flush();

    expect(onModeChange).toHaveBeenLastCalledWith('explore', false);
    controller.stop();
});

test('Replay line uses the host player controls without writing to the media element', async () => {
    const video = document.createElement('video');
    video.currentTime = 2;
    const directPlay = jest.spyOn(video, 'play').mockResolvedValue();
    const deps = {
        video,
        seek: jest.fn(),
        play: jest.fn(),
        subtitles: () => cues,
        metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
        send: jest.fn(async () => ({ account: 'u', enabled: false, mode: 'watch' })),
    };
    const c = new SaviWatchInterest(deps);
    c.setToolbarEnabled(true);
    c.start('ja');
    await flush();
    const shadow = document.querySelector('[data-savi-immersion]')!.shadowRoot!;
    Array.from(shadow.querySelectorAll('button'))
        .find((b) => b.textContent === 'Replay line')!
        .click();
    expect(deps.seek).toHaveBeenCalledWith(1);
    expect(deps.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(2);
    expect(directPlay).not.toHaveBeenCalled();
    c.stop();
    directPlay.mockRestore();
});

test('bookmarks round fractional cue times to the outbox integer contract', async () => {
    const video = document.createElement('video');
    video.currentTime = 2;
    const send = jest.fn(async (message: any) =>
        message.command === 'savi-watch-interest-config'
            ? { account: 'u', enabled: false, mode: 'watch' }
            : { ok: true }
    );
    const c = new SaviWatchInterest({
        seek: jest.fn(),
        play: jest.fn(),
        video,
        subtitles: () => [{ ...cues[0], start: 1000.4, end: 4000.6 }],
        metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
        send,
    });
    c.setToolbarEnabled(true);
    c.start('ja');
    await flush();
    await (c as any).bookmark();
    expect(send.mock.calls.find(([m]) => m.command === 'savi-save-watch-interest')?.[0].item).toEqual(
        expect.objectContaining({ lineStartMs: 1000, lineEndMs: 4001 })
    );
    c.stop();
});

test('toolbar is opt-in and disabling it restores Listen subtitles across config refreshes', async () => {
    const onModeChange = jest.fn();
    const controller = new SaviWatchInterest({
        video: document.createElement('video'),
        seek: jest.fn(),
        play: jest.fn(),
        subtitles: () => cues,
        metadata: () => ({ title: 'Episode' }),
        onModeChange,
        send: jest.fn(async () => ({ account: 'u', enabled: true, mode: 'listen' })),
    });
    controller.start('ja');
    await flush();
    expect(document.querySelector('[data-savi-immersion]')).toBeNull();
    expect(onModeChange).toHaveBeenLastCalledWith('listen', false);
    controller.setToolbarEnabled(true);
    controller.setToolbarEnabled(true);
    expect(document.querySelectorAll('[data-savi-immersion]')).toHaveLength(1);
    expect(onModeChange).toHaveBeenLastCalledWith('listen', true);
    controller.setToolbarEnabled(false);
    expect(document.querySelector('[data-savi-immersion]')).toBeNull();
    expect(onModeChange).toHaveBeenLastCalledWith('listen', false);
    await (controller as any).config();
    expect(onModeChange).toHaveBeenLastCalledWith('listen', false);
    controller.stop();
    controller.start('ja');
    await flush();
    expect(document.querySelector('[data-savi-immersion]')).toBeNull();
    controller.stop();
    controller.setToolbarEnabled(true);
    expect(document.querySelector('[data-savi-immersion]')).toBeNull();
});
