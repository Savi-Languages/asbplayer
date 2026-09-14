import { SpotifyPanel } from './spotify-panel';
const id = '1234567890123456789012';
let sent: any[] = [];
function fixture() {
    document.body.innerHTML = `<footer data-testid="now-playing-bar"><div data-testid="now-playing-widget"><a data-testid="context-item-link" href="/track/${id}">Synthetic song</a></div><span data-testid="playback-position">0:01</span><span data-testid="playback-duration">1:00</span><button data-testid="control-button-playpause" aria-label="Play"></button></footer><audio></audio>`;
    const media = document.querySelector('audio')!;
    Object.defineProperties(media, {
        duration: { value: 60 },
        readyState: { value: 3 },
        paused: { value: true, writable: true },
        currentTime: { value: 1, writable: true },
    });
    return media;
}
const send = async (message: any) => {
    sent.push(message);
    if (message.command === 'savi-watch-interest-config')
        return { account: 'synthetic', mode: 'explore', enabled: true };
    if (message.command === 'savi-tokenize') return { tokens: [] };
    return { ok: true };
};
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};
async function autoFixture(
    options: { autoCapture?: boolean; muted?: boolean; untimed?: boolean; fail?: boolean } = {}
) {
    const p = new SpotifyPanel({
        send: async (message) => {
            const result = await send(message);
            if (message.command === 'savi-start-capture')
                return { started: !options.fail, audio: { state: 'recording' } };
            if (message.command === 'savi-stop-capture') return { stopped: true };
            return result;
        },
        settings: async () => ({
            lang: 'ja',
            enabled: false,
            muted: options.muted ?? false,
            autoCapture: options.autoCapture ?? true,
        }),
    });
    p.start();
    await settle();
    const root = document.querySelector('[data-savi-spotify]')!.shadowRoot!;
    const importLines = () => {
        root.querySelector('textarea')!.value = options.untimed
            ? 'こんにちは'
            : '00:00:00.000 --> 00:01:00.000\nこんにちは';
        Array.from(root.querySelectorAll('button'))
            .find((b) => b.textContent === 'Use this text')!
            .click();
    };
    importLines();
    const media = document.querySelector('audio')!;
    const advance = async (steps = 8) => {
        for (let i = 0; i < steps; i++) {
            media.currentTime += 0.25 * media.playbackRate;
            document.querySelector('[data-testid="playback-position"]')!.textContent =
                `0:${Math.floor(media.currentTime).toString().padStart(2, '0')}`;
            jest.advanceTimersByTime(250);
            await settle();
        }
    };
    const play = () => {
        Object.defineProperty(media, 'paused', { value: false, writable: true });
        document.querySelector('[data-testid="control-button-playpause"]')!.setAttribute('aria-label', 'Pause');
    };
    return { p, root, media, advance, play, importLines };
}
it('automatically records verified playback once, pauses segments, and respects Stop until the next item', async () => {
    const f = await autoFixture();
    await f.advance();
    expect(sent.some((m) => m.command === 'savi-start-capture')).toBe(false);
    f.play();
    await f.advance(12);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toEqual([
        expect.objectContaining({ manuallyRequested: false }),
    ]);
    Object.defineProperty(f.media, 'paused', { value: true, writable: true });
    jest.advanceTimersByTime(250);
    await settle();
    expect(sent.filter((m) => m.command === 'savi-playback-state').at(-1)?.ops).toContainEqual({ op: 'segment-end' });
    f.play();
    await f.advance(12);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toHaveLength(1);
    Array.from(f.root.querySelectorAll('button'))
        .find((b) => b.textContent === 'Stop and save audio')!
        .click();
    await f.advance(12);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toHaveLength(1);
    document.querySelector('a')!.href = '/episode/abcdefghijklmnopqrstuv';
    await f.advance(1);
    f.importLines();
    await f.advance(12);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toHaveLength(2);
    f.p.stop();
});
it.each([{ autoCapture: false }, { muted: true }, { untimed: true }])(
    'does not auto-record when blocked by %j',
    async (options) => {
        const f = await autoFixture(options);
        f.play();
        await f.advance(12);
        expect(sent.some((m) => m.command === 'savi-start-capture')).toBe(false);
        f.p.stop();
    }
);
it('backs off failed automatic starts instead of requesting capture every tick', async () => {
    const f = await autoFixture({ fail: true });
    f.play();
    await f.advance(40);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toHaveLength(1);
    await f.advance(100);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toHaveLength(2);
    f.p.stop();
});
it('does not open an audio segment if playback pauses while capture startup is pending', async () => {
    const f = await autoFixture();
    let resolveStart!: (value: any) => void;
    const originalSend = (f.p as any).deps.send;
    (f.p as any).deps.send = (message: any) => {
        if (message.command === 'savi-start-capture') {
            sent.push(message);
            return new Promise((resolve) => {
                resolveStart = resolve;
            });
        }
        return originalSend(message);
    };
    f.play();
    await f.advance(12);
    expect(sent.filter((m) => m.command === 'savi-start-capture')).toHaveLength(1);
    Object.defineProperty(f.media, 'paused', { value: true, writable: true });
    jest.advanceTimersByTime(250);
    await settle();
    resolveStart({ started: true, audio: { state: 'recording' } });
    await settle();
    await (f.p as any).captureChain;
    expect(sent.filter((m) => m.command === 'savi-playback-state').flatMap((m) => m.ops)).not.toContainEqual(
        expect.objectContaining({ op: 'segment-start' })
    );
    f.p.stop();
});
it('saves automatically when the media ends', async () => {
    const f = await autoFixture();
    f.play();
    await f.advance(12);
    Object.defineProperty(f.media, 'ended', { value: true });
    Object.defineProperty(f.media, 'paused', { value: true, writable: true });
    jest.advanceTimersByTime(250);
    await settle();
    await settle();
    expect(sent.filter((m) => m.command === 'savi-stop-capture')).toHaveLength(1);
    f.p.stop();
});
it('uses the daemon segment operation wire contract when recording starts and pauses', async () => {
    const p = new SpotifyPanel({ send, settings: async () => ({ lang: 'ja', enabled: true, muted: false }) });
    const segment = { segmentId: 's0', mediaTimeMs: 12500, rate: 1 };
    (p as any).captureId = `spotify:episode:${id}`;
    (p as any).enqueueOps([{ type: 'segment-start', segment }, { type: 'segment-end' }]);
    await (p as any).captureChain;
    expect(sent.find((m) => m.command === 'savi-playback-state')).toEqual({
        command: 'savi-playback-state',
        episodeId: `spotify:episode:${id}`,
        ops: [{ op: 'segment-start', segment }, { op: 'segment-end' }],
    });
});
beforeEach(() => {
    jest.useFakeTimers();
    sent = [];
    fixture();
    jest.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.replaceChildren();
});
it('saves untimed imported text without invented timings and clears it on a track change', async () => {
    const p = new SpotifyPanel({ send, settings: async () => ({ lang: 'ja', enabled: true, muted: false }) });
    p.start();
    await settle();
    const root = document.querySelector('[data-savi-spotify]')!.shadowRoot!;
    const textarea = root.querySelector('textarea')!;
    textarea.value = 'これはテストです\n次の行です';
    Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent === 'Use this text')!
        .click();
    const line = root.querySelector<HTMLButtonElement>('.lines button')!;
    line.click();
    await settle();
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Save selected line')!.disabled = false;
    Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent === 'Save selected line')!
        .click();
    await settle();
    expect(sent.find((m) => m.command === 'savi-save-watch-interest')?.item).toMatchObject({
        episodeId: `spotify:track:${id}`,
        textTiming: 'untimed',
        lineStartMs: 0,
        lineEndMs: 0,
        lineText: 'これはテストです',
        kind: 'bookmark',
    });
    const link = document.querySelector('a')!;
    link.href = '/episode/abcdefghijklmnopqrstuv';
    jest.advanceTimersByTime(250);
    await settle();
    expect(root.querySelectorAll('.lines button')).toHaveLength(0);
    expect(textarea.value).toBe('');
    p.stop();
});
it('requires 1.5s paused continuous interest and rejects resume before the threshold', async () => {
    const media = document.querySelector('audio')!;
    const p = new SpotifyPanel({ send, settings: async () => ({ lang: 'ja', enabled: true, muted: false }) });
    p.start();
    await settle();
    const root = document.querySelector('[data-savi-spotify]')!.shadowRoot!;
    root.querySelector('textarea')!.value = '私のテスト';
    Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent === 'Use this text')!
        .click();
    root.querySelector<HTMLButtonElement>('.lines button')!.click();
    await settle();
    jest.advanceTimersByTime(1499);
    await settle();
    expect(sent.some((m) => m.command === 'savi-save-watch-interest')).toBe(false);
    Object.defineProperty(media, 'paused', { value: false, writable: true });
    jest.advanceTimersByTime(250);
    await settle();
    expect(sent.some((m) => m.command === 'savi-save-watch-interest')).toBe(false);
    Object.defineProperty(media, 'paused', { value: true, writable: true });
    jest.advanceTimersByTime(250);
    root.querySelector<HTMLButtonElement>('.lines button')!.click();
    jest.advanceTimersByTime(1500);
    await settle();
    expect(sent.filter((m) => m.command === 'savi-save-watch-interest')).toHaveLength(1);
    p.stop();
});
