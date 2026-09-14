import { SpotifyPanel } from '../../src/savi/spotify-panel';
const events = document.querySelector('#events')!;
let failed = false,
    audioFailure = false;
const panel = new SpotifyPanel({
    settings: async () => ({ lang: 'ja', enabled: true, muted: false, pauseOnHoverMode: 1 }),
    send: async (message: any) => {
        events.textContent = JSON.stringify(message, null, 2);
        if (message.command === 'savi-watch-interest-config')
            return { account: 'synthetic', mode: 'explore', enabled: true };
        if (message.command === 'savi-tokenize')
            return {
                tokens: Array.from(new Intl.Segmenter('ja', { granularity: 'word' }).segment(message.text), (s) => ({
                    text: s.segment,
                    lemma: s.segment,
                })),
            };
        if (message.command === 'savi-dict')
            return {
                entries: [
                    {
                        kanji: [message.term],
                        readings: ['りょこう'],
                        senses: [{ glosses: ['travel; trip (fixture definition)'] }],
                    },
                ],
                kanji: [],
            };
        if (message.command === 'savi-segment-line') return { ai: false, tokens: [], unavailable: 'disabled' };
        if (message.command === 'savi-explain-word') return { explanation: null, unavailable: 'disabled' };
        if (message.command === 'savi-kanji') return { kanji: [] };
        if (message.command === 'savi-start-capture')
            return {
                started: true,
                audio: audioFailure
                    ? { state: 'unavailable', reason: 'Synthetic permission failure' }
                    : { state: 'recording', sourceApp: 'Synthetic audio fixture' },
            };
        if (message.command === 'savi-stop-capture') {
            setTimeout(
                () =>
                    panel.captureEnded({
                        command: 'savi-capture-ended',
                        src: 'https://open.spotify.com/track/1234567890123456789012',
                        ok: true,
                        info: { totalLines: 2, keptDurationMs: 3000 },
                    }),
                50
            );
            return { stopped: true };
        }
        if (message.command === 'savi-save-watch-interest' && failed) {
            failed = false;
            return { ok: false };
        }
        return { ok: true };
    },
});
// Generated silence is a clock fixture, never a recording claimed as real audio.
const rate = 8000,
    samples = rate * 60,
    bytes = new ArrayBuffer(44 + samples * 2),
    v = new DataView(bytes);
const str = (offset: number, s: string) => Array.from(s).forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
str(0, 'RIFF');
v.setUint32(4, 36 + samples * 2, true);
str(8, 'WAVE');
str(12, 'fmt ');
v.setUint32(16, 16, true);
v.setUint16(20, 1, true);
v.setUint16(22, 1, true);
v.setUint32(24, rate, true);
v.setUint32(28, rate * 2, true);
v.setUint16(32, 2, true);
v.setUint16(34, 16, true);
str(36, 'data');
v.setUint32(40, samples * 2, true);
const media = document.querySelector('audio')!;
media.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
const control = document.querySelector<HTMLButtonElement>('[data-testid=control-button-playpause]')!;
control.onclick = () => {
    if (media.paused) void media.play();
    else media.pause();
};
media.ontimeupdate = () => {
    document.querySelector('[data-testid=playback-position]')!.textContent =
        `0:${Math.floor(media.currentTime).toString().padStart(2, '0')}`;
};
media.onplay = () => control.setAttribute('aria-label', 'Pause');
media.onpause = () => control.setAttribute('aria-label', 'Play');
document.querySelector<HTMLSelectElement>('#speed')!.onchange = (e) => {
    media.playbackRate = Number((e.target as HTMLSelectElement).value);
};
document.querySelector<HTMLButtonElement>('#next')!.onclick = () => {
    const a = document.querySelector<HTMLAnchorElement>('[data-testid=context-item-link]')!;
    a.href = 'https://open.spotify.com/episode/abcdefghijklmnopqrstuv';
    a.textContent = 'Synthetic podcast episode';
    media.currentTime = 0;
};
document.querySelector<HTMLButtonElement>('#failed')!.onclick = () => {
    failed = true;
};
document.querySelector<HTMLButtonElement>('#offline')!.onclick = () => {
    audioFailure = true;
};
document.querySelector<HTMLButtonElement>('#missing')!.onclick = () => location.reload();
panel.start();

// The shared production dictionary uses the runtime seam, isolated here.
(globalThis as any).browser = { runtime: { sendMessage: ({ message }: any) => (panel as any).deps.send(message) } };
const transcript = document.createElement('div');
transcript.id = 'native-lyrics';
transcript.style.cssText =
    'max-height:240px;overflow:auto;font-size:26px;line-height:2.4;padding:18px;background:#243229;border-radius:12px';
for (const text of ['今日は旅行です。', 'パリはきれいです。', '楽しいです。']) {
    const line = document.createElement('p');
    line.dataset.testid = 'lyrics-line';
    line.textContent = text;
    transcript.append(line);
}
document.querySelector('main')!.prepend(transcript);
const toggleNative = document.createElement('button');
toggleNative.textContent = 'Toggle native transcript';
toggleNative.onclick = () => {
    transcript.hidden = !transcript.hidden;
};
transcript.before(toggleNative);
const root = document.querySelector('[data-savi-spotify]')!.shadowRoot!;
root.querySelector('textarea')!.value =
    '00:00:00.000 --> 00:00:20.000\n今日は旅行です。\n\n00:00:20.000 --> 00:00:40.000\nパリはきれいです。\n\n00:00:40.000 --> 00:01:00.000\n楽しいです。';
Array.from(root.querySelectorAll('button'))
    .find((b) => b.textContent === 'Use this text')!
    .click();

const previewHover = document.createElement('button');
previewHover.textContent = 'Preview word hover';
previewHover.onclick = () => {
    const line = transcript.hidden
        ? document.querySelector('[data-savi-spotify-caption]')!
        : transcript.querySelector('p')!;
    const text = line.firstChild!;
    const range = document.createRange();
    range.setStart(text, 3);
    range.setEnd(text, 5);
    const r = range.getBoundingClientRect();
    line.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: r.left + 3, clientY: r.top + r.height / 2 })
    );
};
toggleNative.after(previewHover);
