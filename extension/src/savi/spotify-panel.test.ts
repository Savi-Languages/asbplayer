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
