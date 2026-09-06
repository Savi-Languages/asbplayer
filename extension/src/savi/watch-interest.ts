import { lineElement } from './hover-dict';

interface Cue {
    text: string;
    start: number;
    end: number;
    track?: number;
}
interface Sources {
    video: HTMLMediaElement;
    subtitles(): readonly Cue[];
    metadata(): { episodeId?: string; title: string; show?: string };
    send(message: unknown): Promise<any>;
}
const normalize = (text: string) =>
    text
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, '')
        .trim();
/** Only exact, current primary subtitle cues qualify; overlay notifications don't. */
export function interestCue(cues: readonly Cue[], text: string, timeMs: number): Cue | undefined {
    return cues.find(
        (c) => (c.track ?? 0) === 0 && c.start <= timeMs && timeMs < c.end && normalize(c.text) === normalize(text)
    );
}
export class SaviWatchInterest {
    private lang = '';
    private account = '';
    private enabled = false;
    private bound = false;
    private generation = 0;
    private element: HTMLElement | null = null;
    private timer?: ReturnType<typeof setTimeout>;
    private refresh?: ReturnType<typeof setInterval>;
    private saved = new Set<string>();
    constructor(private readonly deps: Sources) {}
    start(lang: string) {
        if (this.bound && this.lang === lang) return;
        this.stop();
        this.bound = true;
        this.lang = lang;
        document.addEventListener('mousemove', this.move);
        document.addEventListener('mouseout', this.leave);
        window.addEventListener('blur', this.clear);
        for (const event of ['play', 'seeking']) this.deps.video.addEventListener(event, this.clear);
        this.deps.video.addEventListener('pause', this.arm);
        void this.config();
        this.refresh = setInterval(() => void this.config(), 60000);
    }
    stop() {
        this.bound = false;
        this.generation++;
        this.enabled = false;
        this.account = '';
        this.saved.clear();
        this.clear();
        clearInterval(this.refresh);
        document.removeEventListener('mousemove', this.move);
        document.removeEventListener('mouseout', this.leave);
        window.removeEventListener('blur', this.clear);
        for (const event of ['play', 'seeking']) this.deps.video.removeEventListener(event, this.clear);
        this.deps.video.removeEventListener('pause', this.arm);
    }
    private async config() {
        const generation = this.generation;
        try {
            const result = await this.deps.send({ command: 'savi-watch-interest-config' });
            if (!this.bound || generation !== this.generation) return;
            if (this.account !== result?.account) {
                this.clear();
                this.saved.clear();
            }
            this.account = result?.account ?? '';
            this.enabled = result?.enabled === true;
            if (!this.enabled) this.clear();
        } catch {
            this.enabled = false;
            this.clear();
        }
    }
    private clear = () => {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.element = null;
    };
    private leave = (event: MouseEvent) => {
        if (!this.element?.contains(event.relatedTarget as Node | null)) this.clear();
    };
    private move = (event: MouseEvent) => {
        const element = lineElement(event.target);
        if (element === this.element) return;
        this.clear();
        this.element = element;
        this.arm();
    };
    private arm = () => {
        clearTimeout(this.timer);
        const element = this.element;
        if (!this.bound || !this.enabled || !this.account || !element || !this.deps.video.paused) return;
        const clone = element.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('rt, rp').forEach((e) => e.remove());
        const cue = interestCue(this.deps.subtitles(), clone.textContent ?? '', this.deps.video.currentTime * 1000);
        const meta = this.deps.metadata();
        if (!cue || !meta.episodeId) return;
        const account = this.account;
        const key = JSON.stringify([account, this.lang, meta.episodeId, cue.start]);
        if (this.saved.has(key)) return;
        this.timer = setTimeout(() => {
            if (
                !this.bound ||
                !this.enabled ||
                this.account !== account ||
                this.element !== element ||
                !element.isConnected ||
                !this.deps.video.paused ||
                this.deps.video.seeking ||
                this.deps.metadata().episodeId !== meta.episodeId
            )
                return;
            const current = element.cloneNode(true) as HTMLElement;
            current.querySelectorAll('rt, rp').forEach((e) => e.remove());
            if (
                interestCue(this.deps.subtitles(), current.textContent ?? '', this.deps.video.currentTime * 1000) !==
                cue
            )
                return;
            void this.deps
                .send({
                    command: 'savi-save-watch-interest',
                    account,
                    item: {
                        lang: this.lang,
                        episodeId: meta.episodeId,
                        show: meta.show ?? '',
                        episodeTitle: meta.title,
                        lineStartMs: Math.round(cue.start),
                        lineEndMs: Math.round(cue.end),
                        lineText: cue.text,
                        kind: 'hover',
                        dwellMs: 1500,
                        context: this.deps
                            .subtitles()
                            .filter(
                                (c) =>
                                    (c.track ?? 0) === 0 &&
                                    c !== cue &&
                                    c.start >= cue.start - 20000 &&
                                    c.start <= cue.end + 20000
                            )
                            .sort((a, b) => Math.abs(a.start - cue.start) - Math.abs(b.start - cue.start))
                            .slice(0, 4)
                            .sort((a, b) => a.start - b.start)
                            .map((c) => c.text.slice(0, 1000)),
                    },
                })
                .then((result) => {
                    if (result?.ok && this.account === account) this.saved.add(key);
                })
                .catch(() => {});
        }, 1500);
    };
}
