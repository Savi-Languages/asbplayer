import { SpotifyReadingSurface, pointOnSpotifyText } from './spotify-reading';
import { spotifyIdentity, type SpotifyPlayback, type SpotifyLine } from './spotify';

const id = 'spotify:episode:1234567890123456789012';
const lines: SpotifyLine[] = [
    { text: '今日は旅行です。', timing: 'timed', start: 0, end: 3000 },
    { text: '楽しいです。', timing: 'timed', start: 3000, end: 5000 },
];
let surface: SpotifyReadingSurface;
let state: SpotifyPlayback;
let visible = true;
let pauseOnHoverMode = 0;
const snapshot = () => ({ playback: state, lines, lang: 'ja', visible, pauseOnHoverMode });
const originalRects = Range.prototype.getClientRects;
const settleTranslations = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => {
    Range.prototype.getClientRects = jest.fn(() => [{ left: 0, right: 100, top: 0, bottom: 20 }] as any);
    visible = true;
    pauseOnHoverMode = 0;
    document.elementFromPoint = jest.fn().mockReturnValue(document.body);
    document.body.innerHTML = '<footer data-testid="now-playing-bar"></footer>';
    state = {
        identity: spotifyIdentity(id),
        title: 'Episode',
        show: '',
        positionMs: 1000,
        playing: true,
        local: false,
        rate: 1,
    };
    surface = new SpotifyReadingSurface(snapshot, () => {});
    surface.start();
});
afterEach(() => {
    surface.stop();
    Range.prototype.getClientRects = originalRects;
});
function native() {
    const host = document.createElement('div');
    host.id = 'transcript-panel';
    host.setAttribute('role', 'tabpanel');
    host.innerHTML =
        '<span data-encore-id="text" dir="auto">今 日 は 旅 行 で す。</span><span data-encore-id="text" dir="auto">楽 し い で す。</span>';
    document.body.append(host);
    for (const el of [host, ...Array.from(host.children)])
        jest.spyOn(el, 'getBoundingClientRect').mockReturnValue({
            top: 100,
            bottom: 200,
            left: 100,
            right: 600,
            width: 500,
            height: 100,
        } as DOMRect);
    return host;
}
it('places English below each native line without changing Japanese lookup text and reuses translations', async () => {
    surface.stop();
    const translate = jest.fn(async (text: string) =>
        text === lines[0].text ? 'Today is a travel day.' : 'It is fun.'
    );
    surface = new SpotifyReadingSurface(
        () => ({ ...snapshot(), account: 'learner' }),
        () => {},
        translate
    );
    surface.start();
    const host = native();
    const update = surface.update.bind(surface);
    surface.update = () => update('https://open.spotify.com/episode/1234567890123456789012');
    surface.update();
    await settleTranslations();
    const japanese = host.querySelector('[data-savi-spotify-line]')!;
    expect(japanese.textContent).toBe(lines[0].text);
    expect(japanese.nextElementSibling?.textContent).toBe('Today is a travel day.');
    expect(host.querySelectorAll('[data-savi-spotify-translation]')).toHaveLength(2);
    surface.update();
    await settleTranslations();
    expect(translate).toHaveBeenCalledTimes(2);
    host.hidden = true;
    surface.update();
    expect(document.querySelector('[data-savi-spotify-captions] [lang=en]')?.textContent).toBe(
        'Today is a travel day.'
    );
    surface.stop();
    expect(host.querySelector('[data-savi-spotify-translation]')).toBeNull();
});
it('discards an English result from a previous episode and limits translation concurrency', async () => {
    surface.stop();
    const pending: Array<(text: string) => void> = [];
    const translate = jest.fn(() => new Promise<string>((resolve) => pending.push(resolve)));
    let snap = { ...snapshot(), account: 'learner' };
    surface = new SpotifyReadingSurface(
        () => snap,
        () => {},
        translate
    );
    surface.start();
    surface.update();
    expect(translate).toHaveBeenCalledTimes(2);
    snap = { ...snap, playback: { ...state, identity: spotifyIdentity('spotify:episode:abcdefghijklmnopqrstuv') } };
    surface.update();
    expect(translate).toHaveBeenCalledTimes(2);
    pending[0]('Old episode translation');
    pending[1]('Another old translation');
    await settleTranslations();
    expect(document.querySelector('[data-savi-spotify-captions]')?.textContent).not.toContain('Old episode');
    expect(translate).toHaveBeenCalledTimes(4);
    pending[2]('New episode translation');
    pending[3]('New second line');
    await settleTranslations();
    expect(document.querySelector('[data-savi-spotify-captions]')?.textContent).toContain('New episode translation');
});
it('translates a native paragraph that combines timed cues without inventing timing', async () => {
    surface.stop();
    const translate = jest.fn(async () => 'Today is a travel day. It is fun.');
    surface = new SpotifyReadingSurface(
        () => ({ ...snapshot(), account: 'learner' }),
        () => {},
        translate
    );
    surface.start();
    const host = native();
    host.innerHTML = '<span data-encore-id="text" dir="auto">今日は旅行です。楽しいです。</span>';
    const update = surface.update.bind(surface);
    surface.update = () => update('https://open.spotify.com/episode/1234567890123456789012');
    surface.update();
    await settleTranslations();
    expect(host.querySelector('[lang=en]')?.textContent).toBe('Today is a travel day. It is fun.');
    expect(host.firstElementChild!.getAttribute('data-savi-current')).toBe('false');
    expect(translate).toHaveBeenCalledWith('今日は旅行です。楽しいです。', 'ja', '今日は旅行です。楽しいです。');
});
it('shows a translation failure honestly and does not retry on every playback tick', async () => {
    surface.stop();
    const translate = jest.fn(async () => undefined);
    surface = new SpotifyReadingSurface(
        () => ({ ...snapshot(), account: 'learner' }),
        () => {},
        translate
    );
    surface.start();
    surface.update();
    await settleTranslations();
    expect(document.querySelector('[data-savi-spotify-captions] [lang=en]')?.textContent).toMatch(/unavailable/i);
    for (let i = 0; i < 8; i++) surface.update();
    expect(translate).toHaveBeenCalledTimes(2);
});
it('excludes spaces between text runs, including nested inline text', () => {
    const line = document.createElement('span');
    line.innerHTML = '今日は <b>旅行</b>　';
    Range.prototype.getClientRects = jest.fn(function (this: Range) {
        const text = this.toString();
        return (
            text === '今日は'
                ? [{ left: 10, right: 40, top: 10, bottom: 30 }]
                : text === '旅行'
                  ? [{ left: 60, right: 90, top: 10, bottom: 30 }]
                  : []
        ) as any;
    });
    expect(pointOnSpotifyText(line, 20, 20)).toBe(true);
    expect(pointOnSpotifyText(line, 70, 20)).toBe(true);
    expect(pointOnSpotifyText(line, 50, 20)).toBe(false);
    expect(pointOnSpotifyText(line, 70, 40)).toBe(false);
});
it('pauses only over drawn text, not the rest of a wide transcript row or its line spacing', () => {
    const host = native();
    const media = {
        paused: false,
        pause: jest.fn(() => {
            media.paused = true;
        }),
        play: jest.fn().mockResolvedValue(undefined),
    };
    state.local = true;
    state.media = media as any;
    pauseOnHoverMode = 1;
    Range.prototype.getClientRects = jest.fn(
        () =>
            [
                { left: 100, right: 230, top: 100, bottom: 120 },
                { left: 100, right: 180, top: 140, bottom: 160 },
            ] as any
    );
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    const line = host.firstElementChild!;
    const move = (clientX: number, clientY: number) =>
        line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
    move(550, 110); // the blank right-hand region still targets the span
    move(110, 130); // space between wrapped text fragments
    expect(media.pause).not.toHaveBeenCalled();
    move(120, 110);
    expect(media.pause).toHaveBeenCalledTimes(1);
    move(550, 110);
    expect(media.play).toHaveBeenCalledTimes(1);
    const adapter = (surface as any).dictionary;
    expect(adapter._resolveLine(line, 550, 110)).toBeNull();
    expect(adapter._resolveLine(line, 120, 150)).toBe(line);
});
it('shows only the current timed caption, advances with audio and clears gaps', () => {
    surface.update();
    expect(document.querySelector('[data-savi-spotify-caption]')?.textContent).toBe(lines[0].text);
    state.positionMs = 3500;
    surface.update();
    expect(document.querySelector('[data-savi-spotify-caption]')?.textContent).toBe(lines[1].text);
    state.positionMs = 6000;
    surface.update();
    expect((document.querySelector('[data-savi-spotify-captions]') as HTMLElement).hidden).toBe(true);
});
it('enhances the matching native transcript without replacing its text node and removes duplicate captions', () => {
    const host = native();
    const textNode = host.firstElementChild!.firstChild;
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    expect(host.firstElementChild!.firstChild).toBe(textNode);
    expect(host.firstElementChild!.textContent).toBe(lines[0].text);
    expect(host.firstElementChild!.getAttribute('data-savi-current')).toBe('true');
    expect((document.querySelector('[data-savi-spotify-captions]') as HTMLElement).hidden).toBe(true);
    state.positionMs = 3500;
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    expect(host.lastElementChild!.getAttribute('data-savi-current')).toBe('true');
    surface.stop();
    expect(host.firstElementChild!.textContent).toBe('今 日 は 旅 行 で す。');
    expect(host.querySelector('[data-savi-current]')).toBeNull();
});
it('does not annotate a browsed episode with another episode playing', () => {
    const host = native();
    surface.update('https://open.spotify.com/episode/abcdefghijklmnopqrstuv');
    expect(host.querySelector('[data-savi-spotify-line]')).toBeNull();
    expect(host.firstElementChild!.textContent).toBe('今 日 は 旅 行 で す。');
    expect((document.querySelector('[data-savi-spotify-captions]') as HTMLElement).hidden).toBe(false);
});
it('restores only text Savi still owns, leaving a Spotify rerender untouched', () => {
    const host = native();
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    host.firstElementChild!.firstChild!.textContent = '新しい文章';
    surface.stop();
    expect(host.firstElementChild!.textContent).toBe('新しい文章');
});
it('reattaches when Spotify replaces the text node during a rerender', () => {
    const host = native();
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    const replacement = document.createTextNode('今 日 は 旅 行 で す。');
    host.firstElementChild!.replaceChildren(replacement);
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    expect(replacement.textContent).toBe(lines[0].text);
    surface.stop();
    expect(replacement.textContent).toBe('今 日 は 旅 行 で す。');
});
it('holds scrolling after the learner scrolls and resumes with Back to current line', () => {
    const host = native();
    host.style.overflowY = 'auto';
    Object.defineProperties(host, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    host.scrollTop = 350;
    host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -50 }));
    state.positionMs = 3500;
    surface.update('https://open.spotify.com/episode/1234567890123456789012');
    expect(host.scrollTop).toBe(350);
    const back = document.querySelector<HTMLButtonElement>('[data-savi-spotify-follow]')!;
    expect(back.hidden).toBe(false);
    const update = surface.update.bind(surface);
    surface.update = () => update('https://open.spotify.com/episode/1234567890123456789012');
    back.click();
    expect(back.hidden).toBe(true);
});
it('respects listen/hide mode and clears previous episode captions', () => {
    surface.update();
    visible = false;
    surface.update();
    expect((document.querySelector('[data-savi-spotify-captions]') as HTMLElement).hidden).toBe(true);
    visible = true;
    state.identity = undefined;
    surface.update();
    expect((document.querySelector('[data-savi-spotify-captions]') as HTMLElement).hidden).toBe(true);
});
it('pauses on hover and resumes only its own pause when leaving', () => {
    const media = {
        paused: false,
        pause: jest.fn(() => {
            media.paused = true;
        }),
        play: jest.fn().mockResolvedValue(undefined),
    };
    state.local = true;
    state.media = media as any;
    pauseOnHoverMode = 1;
    surface.update();
    const caption = document.querySelector('[data-savi-spotify-caption]')!;
    caption.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(media.pause).toHaveBeenCalledTimes(1);
    state.positionMs = 3500;
    surface.update();
    expect(caption.textContent).toBe(lines[0].text);
    // A seek revokes ownership; leaving must not resume.
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(media.play).not.toHaveBeenCalled();
    state.positionMs = 1000;
    media.paused = false;
    surface.update();
    caption.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(media.play).toHaveBeenCalledTimes(1);
});
it('does not resume a manually paused player or one explicitly controlled during hover', () => {
    const media = { paused: true, pause: jest.fn(), play: jest.fn().mockResolvedValue(undefined) };
    state.local = true;
    state.media = media as any;
    state.playing = false;
    pauseOnHoverMode = 1;
    surface.update();
    const caption = document.querySelector('[data-savi-spotify-caption]')!;
    caption.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(media.play).not.toHaveBeenCalled();
    media.paused = false;
    state.playing = true;
    caption.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    media.paused = true;
    document.querySelector('footer')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(media.play).not.toHaveBeenCalled();
});
