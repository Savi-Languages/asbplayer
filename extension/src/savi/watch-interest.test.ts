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

describe('Savi modes control', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.useRealTimers();
        document.body.innerHTML = '';
    });

    const fixture = async (setMode: (message: any) => Promise<any> = async () => ({ ok: true })) => {
        const video = document.createElement('video');
        video.getBoundingClientRect = () =>
            ({ x: 100, y: 50, left: 100, top: 50, width: 800, height: 450, right: 900, bottom: 500 }) as DOMRect;
        document.body.append(video);
        const onModeChange = jest.fn();
        const send = jest.fn((message: any) =>
            message.command === 'savi-watch-interest-config'
                ? Promise.resolve({ account: 'u', enabled: true, mode: 'watch' })
                : setMode(message)
        );
        const controller = new SaviWatchInterest({
            video,
            subtitles: () => cues,
            metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
            onModeChange,
            send,
        });
        controller.start('ja');
        await flush();
        const host = document.querySelector<HTMLElement>('[data-savi-immersion]')!;
        const shadow = host.shadowRoot!;
        return { controller, host, shadow, onModeChange, send };
    };

    test('the collapsed button follows player activity instead of staying stuck over the video', async () => {
        const f = await fixture();
        expect(f.host.style.display).not.toBe('none');
        jest.advanceTimersByTime(3000);
        expect(f.host.style.display).toBe('none');
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        expect(f.host.style.display).not.toBe('none');
        f.controller.stop();
    });

    test('a mode takes effect optimistically without waiting for cloud persistence', async () => {
        let resolve!: (value: any) => void;
        const f = await fixture(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        );
        const details = Array.from(f.shadow.querySelectorAll('button')).find((b) => b.textContent === 'Savi modes')!;
        details.click();
        const explore = Array.from(f.shadow.querySelectorAll('button')).find((b) => b.textContent === 'Explore')!;
        explore.click();
        expect(f.onModeChange).toHaveBeenLastCalledWith('explore', false);
        expect(explore.getAttribute('aria-pressed')).toBe('true');
        resolve({ ok: true });
        await flush();
        f.controller.stop();
    });

    test('the menu collapses on an outside click and then gets out of the way', async () => {
        const f = await fixture();
        const details = Array.from(f.shadow.querySelectorAll('button')).find((b) => b.textContent === 'Savi modes')!;
        details.click();
        jest.advanceTimersByTime(3000);
        expect(f.host.style.display).not.toBe('none');
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(details.textContent).toBe('Savi modes');
        jest.advanceTimersByTime(3000);
        expect(f.host.style.display).toBe('none');
        f.controller.stop();
    });
});
