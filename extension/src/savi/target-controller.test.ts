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
it('never pauses for late preparation, opens once on the next play gesture and records acceptance', async () => {
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

it('retries a transient preparation failure after a bounded cooldown without pausing playback', async () => {
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const video = document.createElement('video');
    const pause = jest.fn();
    const send = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(prep());
    const controller = new SaviTargetController({
        video,
        metadata: () => ({ episodeId: 'netflix:1', title: 'S1:E1', show: 'Dark' }),
        subtitles: () => [],
        pause,
        play: jest.fn(),
        send,
    });
    controller.start('ja');
    await settle();
    now = 100;
    video.dispatchEvent(new Event('timeupdate'));
    expect(send).toHaveBeenCalledTimes(1);
    now = 30001;
    video.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(pause).not.toHaveBeenCalled();
    controller.stop();
    clock.mockRestore();
});
