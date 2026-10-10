import { SaviTargetController } from './target-controller';
jest.mock('./token-cache', () => ({
    subtitleTokens: { getRaw: jest.fn(async (text: string, line: string) => [{ text: line, lemma: '関与' }]) },
}));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const prep = () => ({
    account: 'alice',
    identity: { mediaType: 'tv', tmdbId: 1, season: 1, episode: 1, title: 'Dark' },
    targets: [{ lemma: '関与', count: 2, gloss: 'involvement', reason: 'twice', exampleCue: '関与した' }],
    cardEnabled: true,
    autoMineToAnki: false,
});
beforeEach(() => {
    Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: () => 'c4da0c28-7e46-42a3-9238-a81daa9864aa',
    });
    document.body.innerHTML = '';
    (global as any).browser = { storage: { onChanged: { addListener: jest.fn(), removeListener: jest.fn() } } };
});
it('prepares while paused, opens once near the episode start and records acceptance', async () => {
    const video = document.createElement('video');
    let resolve!: (value: any) => void;
    const send = jest
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        )
        .mockResolvedValue({ ok: true });
    const pause = jest.fn();
    const play = jest.fn();
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1:E1', show: 'Dark' }),
        subtitles: () => [],
        pause,
        play,
        send,
    });
    controller.setImmersionMode('explore');
    controller.start('ja');
    video.dispatchEvent(new Event('play'));
    resolve(prep());
    await settle();
    expect(pause).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('play'));
    expect(pause).toHaveBeenCalledTimes(1);
    const shadow = document.querySelector('[data-savi-target-card]')!.shadowRoot!;
    (
        Array.from(shadow.querySelectorAll('button')).find(
            (b) => b.textContent === 'Start watching'
        ) as HTMLButtonElement
    ).click();
    await settle();
    expect(play).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1][0].actions[0].kind).toBe('target_accepted');
    video.dispatchEvent(new Event('play'));
    expect(pause).toHaveBeenCalledTimes(1);
    controller.stop();
});
it('drops stale episode responses, and unresolved episodes never get a card', async () => {
    const video = document.createElement('video');
    let episodeId = 'netflix:1';
    let resolve!: (value: any) => void;
    const send = jest
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        )
        .mockResolvedValue(null);
    const pause = jest.fn();
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId, title: 'S1:E1', show: 'Dark' }),
        subtitles: () => [],
        pause,
        play: jest.fn(),
        send,
    });
    controller.setImmersionMode('explore');
    controller.start('ja');
    episodeId = 'netflix:2';
    video.dispatchEvent(new Event('timeupdate'));
    resolve(prep());
    await settle();
    video.dispatchEvent(new Event('play'));
    expect(pause).not.toHaveBeenCalled();
    expect(document.querySelector('[data-savi-target-card]')).toBeNull();
    controller.stop();
});

it('samples the cue end when its acknowledgement arrives before the next timeupdate', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'paused', { value: false });
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const send = jest.fn().mockResolvedValue({ ...prep(), cardEnabled: false });
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1:E1', show: 'Dark' }),
        subtitles: () => [{ text: '関与', start: 0, end: 1000, track: 0 }],
        pause: jest.fn(),
        play: jest.fn(),
        send,
    });
    controller.setImmersionMode('explore');
    controller.start('ja');
    await settle();
    video.dispatchEvent(new Event('play'));
    now = 750;
    video.currentTime = 0.75;
    video.dispatchEvent(new Event('timeupdate'));
    now = 1000;
    video.currentTime = 1;
    controller.onHeardAcknowledged({
        episodeId: 'netflix:1',
        lang: 'ja',
        lineStartMs: 0,
        text: '関与',
        occurredAtMs: 1000,
    } as any);
    await settle();
    expect(send.mock.calls.find((call) => call[0].command === 'savi-mine-targets')?.[0].mines).toHaveLength(1);
    controller.stop();
    clock.mockRestore();
});

it('retries transient preparation failures with exponential backoff without pausing playback', async () => {
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const video = document.createElement('video');
    const pause = jest.fn();
    const send = jest
        .fn()
        .mockResolvedValueOnce({ unavailable: true })
        .mockResolvedValueOnce({ unavailable: true })
        .mockResolvedValue(prep());
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1:E1', show: 'Dark' }),
        subtitles: () => [],
        pause,
        play: jest.fn(),
        send,
    });
    controller.setImmersionMode('explore');
    controller.start('ja');
    await settle();
    now = 100;
    video.dispatchEvent(new Event('timeupdate'));
    expect(send).toHaveBeenCalledTimes(1);
    now = 30001;
    video.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    now = 89999;
    video.dispatchEvent(new Event('timeupdate'));
    expect(send).toHaveBeenCalledTimes(2);
    now = 90001;
    video.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(send).toHaveBeenCalledTimes(3);
    expect(pause).not.toHaveBeenCalled();
    controller.stop();
    clock.mockRestore();
});

it('Watch mode never prepares, samples, mines, or auto-pauses target words', async () => {
    const video = document.createElement('video');
    const pause = jest.fn();
    const send = jest.fn(async () => prep());
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1', show: 'Show' }),
        subtitles: () => [{ text: '関与', start: 0, end: 1000, track: 0 }],
        pause,
        play: jest.fn(),
        send,
    });
    controller.start('ja');
    await settle();
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('timeupdate'));
    controller.onHeardAcknowledged({
        episodeId: 'netflix:1',
        lang: 'ja',
        lineStartMs: 0,
        text: '関与',
        occurredAtMs: 1000,
    } as any);
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(document.querySelector('[data-savi-target-card]')).toBeNull();
    controller.stop();
});

it('starts preparation on Explore and cancels it when returning to Watch', async () => {
    const video = document.createElement('video');
    let resolve!: (value: any) => void;
    const send = jest.fn(
        () =>
            new Promise((r) => {
                resolve = r;
            })
    );
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1', show: 'Show' }),
        subtitles: () => [],
        pause: jest.fn(),
        play: jest.fn(),
        send,
    });
    controller.start('ja');
    controller.setImmersionMode('explore');
    expect(send).toHaveBeenCalledTimes(1);
    controller.setImmersionMode('watch');
    resolve(prep());
    await settle();
    video.dispatchEvent(new Event('play'));
    expect(document.querySelector('[data-savi-target-card]')).toBeNull();
    controller.setImmersionMode('explore');
    expect(send).toHaveBeenCalledTimes(2);
    controller.stop();
});

it('negative-caches an unresolved title instead of retrying every event', async () => {
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const video = document.createElement('video');
    const send = jest.fn().mockResolvedValue(null);
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'Unknown title', show: 'Unknown' }),
        subtitles: () => [],
        pause: jest.fn(),
        play: jest.fn(),
        send,
    });
    controller.setImmersionMode('explore');
    controller.start('ja');
    await settle();
    now = 10 * 60_000;
    video.dispatchEvent(new Event('timeupdate'));
    expect(send).toHaveBeenCalledTimes(1);
    now = 15 * 60_000 + 1;
    video.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    controller.stop();
    clock.mockRestore();
});

it.each([true, false])(
    'does not interrupt a later resume after preparation during playback (paused at resolution: %s)',
    async (pausedAtResolution) => {
        const video = document.createElement('video');
        let paused = pausedAtResolution;
        Object.defineProperty(video, 'paused', { get: () => paused });
        video.currentTime = pausedAtResolution ? 120 : 10;
        const pause = jest.fn();
        const controller = new SaviTargetController({
            video,
            metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
            subtitles: () => [],
            pause,
            play: jest.fn(),
            send: jest.fn(async () => prep()),
        });
        controller.setImmersionMode('explore');
        controller.start('ja');
        await settle();
        paused = true;
        video.dispatchEvent(new Event('pause'));
        paused = false;
        video.dispatchEvent(new Event('play'));
        expect(pause).not.toHaveBeenCalled();
        expect(document.querySelector('[data-savi-target-card]')).toBeNull();
        controller.stop();
    }
);

it('does not attach canvas screenshots from DRM-protected video to heard-target mines', async () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
        paused: { value: false },
        mediaKeys: { value: {} },
        videoWidth: { value: 640 },
        videoHeight: { value: 360 },
    });
    const drawImage = jest.fn();
    const context = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any);
    const image = jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,black');
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const send = jest.fn().mockResolvedValue({ ...prep(), cardEnabled: false });
    const c = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'Episode' }),
        subtitles: () => [{ text: '関与', start: 0, end: 1000 }],
        pause: jest.fn(),
        play: jest.fn(),
        send,
    });
    try {
        c.setImmersionMode('explore');
        c.start('ja');
        await settle();
        video.dispatchEvent(new Event('play'));
        now = 950;
        video.currentTime = 0.95;
        video.dispatchEvent(new Event('timeupdate'));
        await settle();
        c.onHeardAcknowledged({
            episodeId: 'netflix:1',
            lang: 'ja',
            lineStartMs: 0,
            text: '関与',
            occurredAtMs: 1000,
        } as any);
        await settle();
        const mine = send.mock.calls.find(([m]) => m.command === 'savi-mine-targets')?.[0].mines[0];
        expect(mine).toBeDefined();
        expect(mine.imageBase64).toBeUndefined();
        expect(drawImage).not.toHaveBeenCalled();
    } finally {
        c.stop();
        clock.mockRestore();
        context.mockRestore();
        image.mockRestore();
    }
});

it('does not interrupt the first programmatic play even when preparation completed while paused', async () => {
    const video = document.createElement('video');
    const pause = jest.fn();
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1:E1', show: 'Dark' }),
        subtitles: () => [],
        pause,
        play: jest.fn(),
        send: jest.fn().mockResolvedValue(prep()),
    });
    controller.setImmersionMode('explore');
    controller.start('ja');
    await settle();
    (controller as any).skipPrewatchCard?.();
    video.dispatchEvent(new Event('play'));
    expect(pause).not.toHaveBeenCalled();
    expect(document.querySelector('[data-savi-target-card]')).toBeNull();
    controller.stop();
});
