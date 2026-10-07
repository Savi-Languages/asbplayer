import { readSpotifyPlayback, type SpotifyMedia } from './spotify';

const ORIGIN = 'https://open.spotify.com';
const EVENTS = ['pause', 'waiting', 'seeking', 'ratechange', 'emptied', 'loadstart', 'volumechange', 'ended'];
type Snapshot = {
    key: string;
    currentTime: number;
    duration: number;
    playbackRate: number;
    paused: boolean;
    ended: boolean;
    muted: boolean;
    volume: number;
    readyState: number;
};
const valid = (m: any): m is Snapshot =>
    m &&
    typeof m.key === 'string' &&
    /^m\d+$/.test(m.key) &&
    ['currentTime', 'duration', 'playbackRate', 'volume', 'readyState'].every((k) => Number.isFinite(m[k])) &&
    m.currentTime >= 0 &&
    m.duration > 0 &&
    m.playbackRate > 0 &&
    m.playbackRate <= 16 &&
    m.volume >= 0 &&
    m.volume <= 1 &&
    m.readyState >= 0 &&
    m.readyState <= 4 &&
    ['paused', 'ended', 'muted'].every((k) => typeof m[k] === 'boolean');

/** Observe native media owned by Spotify, including `new Audio()` kept outside the DOM.
 * Never attach/move a player, inspect credentials, or synthesize a media clock. */
export function observeSpotifyMedia(win: Window, emit: (packet: unknown) => void = (p) => win.postMessage(p, ORIGIN)) {
    const tracked = new Map<HTMLMediaElement, { key: string; listener: (e: Event) => void }>();
    let sequence = 0;
    const detached = () => [...tracked.keys()].filter((m) => !m.isConnected);
    const publish = (event?: string, key?: string) => {
        const media = detached()
            .map((m) => ({
                key: tracked.get(m)!.key,
                currentTime: m.currentTime,
                duration: m.duration,
                playbackRate: m.playbackRate,
                paused: m.paused,
                ended: m.ended,
                muted: m.muted,
                volume: m.volume,
                readyState: m.readyState,
            }))
            .filter(valid);
        emit({ type: 'savi-spotify-media', media: media.length <= 16 ? media : [], event, key });
    };
    const observe = (m: HTMLMediaElement) => {
        if (tracked.has(m)) return;
        // Bound retained paused players; never discard an advancing clock to hide ambiguity.
        if (tracked.size >= 16)
            for (const [old, entry] of tracked) {
                if (old.paused || old.ended) {
                    for (const event of EVENTS) old.removeEventListener(event, entry.listener);
                    tracked.delete(old);
                    break;
                }
            }
        const key = `m${++sequence}`;
        const listener = (e: Event) => publish(e.type, key);
        tracked.set(m, { key, listener });
        for (const event of EVENTS) m.addEventListener(event, listener);
    };
    const proto = HTMLMediaElement.prototype;
    const original = proto.play;
    function play(this: HTMLMediaElement) {
        const result = original.call(this);
        observe(this);
        publish();
        return result;
    }
    proto.play = play;
    const message = (e: MessageEvent) => {
        if (e.source !== win || e.origin !== ORIGIN) return;
        if (e.data?.type === 'savi-spotify-media-request') {
            publish();
            return;
        }
        const d = e.data;
        if (d?.type !== 'savi-spotify-media-control' || typeof d.request !== 'string' || d.request.length > 80) return;
        const media = detached().find((m) => tracked.get(m)?.key === d.key);
        // Commands apply only to the one currently verified Now Playing clock.
        if (!media || readSpotifyPlayback(win.document, detached()).media !== media) {
            emit({ type: 'savi-spotify-media-result', request: d.request, ok: false });
            return;
        }
        const reply = (ok: boolean) => emit({ type: 'savi-spotify-media-result', request: d.request, ok });
        try {
            if (d.action === 'pause') {
                media.pause();
                reply(true);
            } else if (d.action === 'seek' && Number.isFinite(d.time) && d.time >= 0 && d.time <= media.duration) {
                media.currentTime = d.time;
                reply(true);
            } else if (d.action === 'replay' && Number.isFinite(d.time) && d.time >= 0 && d.time <= media.duration) {
                media.currentTime = d.time;
                void media.play().then(
                    () => reply(true),
                    () => reply(false)
                );
            } else if (d.action === 'play') {
                void media.play().then(
                    () => reply(true),
                    () => reply(false)
                );
            } else reply(false);
        } catch {
            reply(false);
        }
        publish();
    };
    win.addEventListener('message', message);
    const timer = setInterval(() => publish(), 250);
    return () => {
        clearInterval(timer);
        win.removeEventListener('message', message);
        if (proto.play === play) proto.play = original;
        for (const [m, entry] of tracked) for (const event of EVENTS) m.removeEventListener(event, entry.listener);
        tracked.clear();
    };
}

class RemoteMedia extends EventTarget implements SpotifyMedia {
    constructor(
        public snapshot: Snapshot,
        private command: (key: string, action: string, time?: number) => Promise<void>
    ) {
        super();
    }
    get currentTime() {
        return this.snapshot.currentTime;
    }
    set currentTime(time: number) {
        void this.command(this.snapshot.key, 'seek', time).catch(() => this.dispatchEvent(new Event('emptied')));
    }
    get duration() {
        return this.snapshot.duration;
    }
    get paused() {
        return this.snapshot.paused;
    }
    get ended() {
        return this.snapshot.ended;
    }
    get muted() {
        return this.snapshot.muted;
    }
    get volume() {
        return this.snapshot.volume;
    }
    get readyState() {
        return this.snapshot.readyState;
    }
    get playbackRate() {
        return this.snapshot.playbackRate;
    }
    play() {
        return this.command(this.snapshot.key, 'play');
    }
    replay(time: number) {
        return this.command(this.snapshot.key, 'replay', time);
    }
    pause() {
        void this.command(this.snapshot.key, 'pause').catch(() => this.dispatchEvent(new Event('emptied')));
    }
}

/** Isolated-world view of bounded native snapshots. Stale/missing snapshots disable capture. */
export class SpotifyMediaBridge {
    private clocks = new Map<string, RemoteMedia>();
    private receivedAt = -Infinity;
    private request = 0;
    private pending = new Map<
        string,
        { resolve: () => void; reject: () => void; timer: ReturnType<typeof setTimeout> }
    >();
    constructor(private win: Window) {}
    media = (): SpotifyMedia[] => (performance.now() - this.receivedAt < 1000 ? [...this.clocks.values()] : []);
    start() {
        this.win.addEventListener('message', this.receive);
        this.win.postMessage({ type: 'savi-spotify-media-request' }, ORIGIN);
    }
    stop() {
        this.win.removeEventListener('message', this.receive);
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject();
        }
        this.pending.clear();
        this.clocks.clear();
        this.receivedAt = -Infinity;
    }
    private command = (key: string, action: string, time?: number) =>
        new Promise<void>((resolve, reject) => {
            if (this.pending.size >= 16) {
                reject(new Error('Spotify player is not responding'));
                return;
            }
            const request = `savi-${++this.request}`;
            const fail = () => reject(new Error('Spotify playback control failed'));
            const timer = setTimeout(() => {
                this.pending.delete(request);
                fail();
            }, 2000);
            this.pending.set(request, { resolve, reject: fail, timer });
            this.win.postMessage({ type: 'savi-spotify-media-control', key, action, time, request }, ORIGIN);
        });
    private receive = (e: MessageEvent) => {
        if (e.source !== this.win || e.origin !== ORIGIN) return;
        const d = e.data;
        if (d?.type === 'savi-spotify-media-result') {
            const p = this.pending.get(d.request);
            if (p) {
                clearTimeout(p.timer);
                this.pending.delete(d.request);
                d.ok === true ? p.resolve() : p.reject();
            }
            return;
        }
        if (d?.type !== 'savi-spotify-media' || !Array.isArray(d.media) || d.media.length > 16 || !d.media.every(valid))
            return;
        const keep = new Set<string>();
        for (const snapshot of d.media as Snapshot[]) {
            keep.add(snapshot.key);
            const media = this.clocks.get(snapshot.key);
            if (media) media.snapshot = snapshot;
            else this.clocks.set(snapshot.key, new RemoteMedia(snapshot, this.command));
        }
        for (const key of this.clocks.keys()) if (!keep.has(key)) this.clocks.delete(key);
        this.receivedAt = performance.now();
        if (EVENTS.includes(d.event)) this.clocks.get(d.key)?.dispatchEvent(new Event(d.event));
    };
}
