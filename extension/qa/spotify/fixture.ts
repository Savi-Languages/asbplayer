import { SpotifyPanel } from '../../src/savi/spotify-panel';
const events = document.querySelector('#events')!;
let failed = false,
    audioFailure = false;
const panel = new SpotifyPanel({
    settings: async () => ({ lang: 'ja', enabled: true, muted: false }),
    send: async (message: any) => {
        events.textContent = JSON.stringify(message, null, 2);
        if (message.command === 'savi-watch-interest-config')
            return { account: 'synthetic', mode: 'explore', enabled: true };
        if (message.command === 'savi-tokenize') return { tokens: [{ text: message.text, lemma: message.text }] };
        if (message.command === 'savi-dict')
            return { entries: [{ readings: ['てすと'], senses: [{ glosses: ['Synthetic dictionary response'] }] }] };
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
