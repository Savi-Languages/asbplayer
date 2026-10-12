import { lineElement, SUBTITLE_CONTAINER } from './hover-dict';

interface Cue {
    text: string;
    start: number;
    end: number;
    track?: number;
}
interface Sources {
    video: HTMLMediaElement;
    subtitles(): readonly Cue[];
    enabled(): boolean;
    pause(): void;
    play(): void;
    overPopup(x: number, y: number): boolean;
    resumeOnLeave?(): boolean;
    holdOpen?(): boolean;
}
const textOf = (element: HTMLElement) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('rt, rp').forEach((node) => node.remove());
    return (copy.textContent ?? '').replace(/\s+/g, '');
};
const cueText = (cue: Cue) => {
    // Provider subtitle markup is untrusted; never parse it in the live document.
    const template = document.createElement('template');
    template.innerHTML = cue.text;
    template.content.querySelectorAll('rt, rp').forEach((node) => node.remove());
    return (template.content.textContent ?? '').replace(/\s+/g, '');
};

/** Playback ownership is independent of language, dictionary requests and study mode. */
export class SaviHoverPause {
    private bound = false;
    private cue?: Cue;
    private timer?: ReturnType<typeof setTimeout>;
    private ownsPause = false;
    private acknowledgementTimer?: ReturnType<typeof setTimeout>;
    private left = false;
    constructor(private readonly sources: Sources) {}

    start() {
        if (this.bound) return;
        this.bound = true;
        document.addEventListener('mousemove', this.move, true);
        document.addEventListener('mouseout', this.out, true);
        window.addEventListener('blur', this.cancel);
        this.sources.video.addEventListener('seeking', this.cancel);
        this.sources.video.addEventListener('play', this.cancel);
        this.sources.video.addEventListener('pause', this.paused);
    }
    stop() {
        this.bound = false;
        this.cancel();
        document.removeEventListener('mousemove', this.move, true);
        document.removeEventListener('mouseout', this.out, true);
        window.removeEventListener('blur', this.cancel);
        this.sources.video.removeEventListener('seeking', this.cancel);
        this.sources.video.removeEventListener('play', this.cancel);
        this.sources.video.removeEventListener('pause', this.paused);
    }
    private cancel = () => {
        clearTimeout(this.timer);
        clearTimeout(this.acknowledgementTimer);
        this.cue = undefined;
        this.ownsPause = false;
        this.left = false;
    };
    private paused = () => {
        clearTimeout(this.acknowledgementTimer);
        if (!this.ownsPause)
            this.cancel(); // A manual/other feature's pause stays paused.
        else if (this.left) this.release(); // Netflix acknowledges via a later media event.
    };
    get hasOwnedPause(): boolean {
        return this.ownsPause;
    }
    /** The immediate-hover fallback must only defer when this controller can match the cue. */
    handlesHover(target: EventTarget | null): boolean {
        if (!this.sources.enabled() || this.sources.video.seeking) return false;
        const line = lineElement(target);
        return line !== null && this.matchCue(line) !== undefined;
    }
    private matchCue(line: HTMLElement): Cue | undefined {
        const now = this.sources.video.currentTime * 1000;
        const text = textOf(line);
        const track = Number(line.closest('[data-track]')?.getAttribute('data-track') ?? 0);
        return this.sources
            .subtitles()
            .find((cue) => (cue.track ?? 0) === track && cue.start <= now && now < cue.end && cueText(cue) === text);
    }
    private release() {
        clearTimeout(this.timer);
        this.left = true;
        if (this.ownsPause && this.sources.holdOpen?.()) {
            // The panel may have opened over a pause we own. Keep that pause until
            // it closes; don't require another pointer movement to release it.
            this.timer = setTimeout(() => {
                if (this.left) this.release();
            }, 50);
            return;
        }
        this.cue = undefined;
        if (this.ownsPause && this.sources.video.paused) {
            this.ownsPause = false;
            if (this.sources.resumeOnLeave?.() !== false) this.sources.play();
        }
    }
    private out = (event: MouseEvent) => {
        if (event.relatedTarget === null) this.release();
    };
    private move = (event: MouseEvent) => {
        if (!this.sources.enabled()) {
            this.release();
            return;
        }
        const { video } = this.sources;
        const candidates = new Set<HTMLElement>();
        const direct = lineElement(event.target);
        if (direct) candidates.add(direct);
        // Streaming overlays and fullscreen top-layer content can intercept the event.
        for (const element of document.elementsFromPoint?.(event.clientX, event.clientY) ?? []) {
            const line = lineElement(element);
            if (line) candidates.add(line);
        }
        if (document.fullscreenElement instanceof HTMLMediaElement) {
            for (const line of document.querySelectorAll<HTMLElement>(`:is(${SUBTITLE_CONTAINER}) [data-track]`)) {
                const r = line.getBoundingClientRect();
                if (
                    r.width > 0 &&
                    r.height > 0 &&
                    event.clientX >= r.left &&
                    event.clientX <= r.right &&
                    event.clientY >= r.top &&
                    event.clientY <= r.bottom
                )
                    candidates.add(line);
            }
        }
        for (const line of candidates) {
            const text = textOf(line);
            const track = Number(line.closest('[data-track]')?.getAttribute('data-track') ?? 0);
            // Keep the original line while held, including a slightly late media pause.
            if (this.cue && (this.cue.track ?? 0) === track && cueText(this.cue) === text) {
                this.left = false;
                if (this.ownsPause) clearTimeout(this.timer);
                return;
            }
            const cue = this.matchCue(line);
            if (!cue) continue;
            if (this.ownsPause) {
                this.left = false;
                if (this.ownsPause) clearTimeout(this.timer);
                return;
            }
            this.cancel();
            if (!video.paused && !video.seeking) {
                this.cue = cue;
                this.tick();
            }
            return;
        }
        if (this.cue && this.sources.overPopup(event.clientX, event.clientY)) return;
        this.release();
    };
    private tick = () => {
        clearTimeout(this.timer);
        const { video } = this.sources;
        const cue = this.cue;
        if (!cue || this.ownsPause) return;
        if (
            !this.sources.enabled() ||
            video.paused ||
            video.seeking ||
            video.ended ||
            !this.sources.subtitles().includes(cue)
        ) {
            this.cancel();
            return;
        }
        const remaining = cue.end - video.currentTime * 1000;
        // Check the media clock, not elapsed wall time: buffering and rate changes
        // must not move the pause to a different subtitle. A tiny lead keeps text visible.
        if (remaining <= 15) {
            this.ownsPause = true;
            // A lost bridge request must not claim an unrelated manual pause later.
            this.acknowledgementTimer = setTimeout(() => {
                if (!video.paused) this.cancel();
            }, 2000);
            this.sources.pause();
        } else {
            this.timer = setTimeout(this.tick, Math.max(4, Math.min(50, (remaining - 10) / (video.playbackRate || 1))));
        }
    };
}
