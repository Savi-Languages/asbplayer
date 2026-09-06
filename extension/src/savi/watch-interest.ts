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
    onModeChange?(mode: string, hideText: boolean): void;
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
    private mode = 'watch';
    private revealed = false;
    private toolbar?: HTMLElement;
    private toolbarHost?: HTMLElement;
    private revealButton?: HTMLButtonElement;
    private status?: HTMLElement;
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
        document.addEventListener('fullscreenchange', this.fullscreen);
        document.addEventListener('mousemove', this.move);
        document.addEventListener('mouseout', this.leave);
        window.addEventListener('blur', this.clear);
        for (const event of ['play', 'seeking']) this.deps.video.addEventListener(event, this.clear);
        this.deps.video.addEventListener('pause', this.arm);
        this.mountControls();
        void this.config();
        this.refresh = setInterval(() => void this.config(), 60000);
    }
    stop() {
        this.bound = false;
        this.toolbarHost?.remove();
        this.toolbarHost = undefined;
        this.toolbar = undefined;
        this.mode = 'watch';
        this.revealed = false;
        document.removeEventListener('fullscreenchange', this.fullscreen);
        this.deps.onModeChange?.('watch', false);
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
            const nextMode = result?.mode ?? 'watch';
            if (nextMode !== this.mode) this.revealed = false;
            this.mode = nextMode;
            this.updateMode();
            if (!this.enabled) this.clear();
        } catch {
            this.enabled = false;
            this.clear();
        }
    }
    private fullscreen = () => {
        if (this.toolbarHost) (document.fullscreenElement ?? document.body).append(this.toolbarHost);
    };
    private updateMode() {
        this.deps.onModeChange?.(this.mode, this.mode === 'listen' && !this.revealed);
        this.toolbar?.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
            b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode));
            b.style.background = b.dataset.mode === this.mode ? '#225d75' : '#20252d';
        });
        if (this.revealButton) {
            this.revealButton.disabled = this.mode !== 'listen';
            this.revealButton.textContent = this.revealed ? 'Hide text' : 'Reveal text';
        }
        if (this.mode !== 'explore') this.clear();
    }
    private mountControls() {
        const host = document.createElement('div');
        host.dataset.saviImmersion = 'true';
        Object.assign(host.style, {
            position: 'fixed',
            left: '16px',
            bottom: '90px',
            zIndex: '2147483600',
            fontSize: '12px',
        });
        const shadow = host.attachShadow({ mode: 'open' });
        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#111820ed',
            color: '#fff',
            padding: '8px',
            borderRadius: '10px',
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            maxWidth: '420px',
            fontFamily: 'system-ui',
        });
        const button = (text: string, run: () => void) => {
            const b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, {
                padding: '6px 9px',
                border: '1px solid #69727e',
                borderRadius: '6px',
                color: 'white',
                background: '#20252d',
                cursor: 'pointer',
            });
            b.onclick = run;
            box.append(b);
            return b;
        };
        for (const mode of ['watch', 'explore', 'listen']) {
            const b = button(mode[0].toUpperCase() + mode.slice(1), () => {
                void this.deps
                    .send({ command: 'savi-set-immersion-mode', mode })
                    .then((r) => {
                        if (!this.bound) return;
                        if (!r?.ok) {
                            if (this.status) this.status.textContent = 'Could not save mode. Try again.';
                            return;
                        }
                        this.mode = mode;
                        this.revealed = false;
                        this.updateMode();
                    })
                    .catch(() => {
                        if (this.status) this.status.textContent = 'Mode unavailable.';
                    });
            });
            b.dataset.mode = mode;
        }
        this.revealButton = button('Reveal text', () => {
            this.revealed = !this.revealed;
            this.updateMode();
        });
        button('Replay line', () => {
            const cue = this.deps
                .subtitles()
                .find(
                    (c) =>
                        (c.track ?? 0) === 0 &&
                        c.start <= this.deps.video.currentTime * 1000 &&
                        this.deps.video.currentTime * 1000 < c.end
                );
            if (cue) {
                this.deps.video.currentTime = cue.start / 1000;
                void this.deps.video.play().catch(() => {});
            }
        });
        button('Bookmark', () => {
            void this.bookmark();
        });
        const details = button('−', () => {
            const collapsed = box.dataset.collapsed !== 'true';
            box.dataset.collapsed = String(collapsed);
            for (const child of Array.from(box.children)) {
                if (child !== details) (child as HTMLElement).style.display = collapsed ? 'none' : '';
            }
            details.textContent = collapsed ? 'Savi modes' : '−';
        });
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        box.append(status);
        this.status = status;
        shadow.append(box);
        (document.fullscreenElement ?? document.body).append(host);
        this.toolbarHost = host;
        this.toolbar = box;
        details.click();
        this.updateMode();
    }
    private async bookmark() {
        const cue = this.deps
            .subtitles()
            .find(
                (c) =>
                    (c.track ?? 0) === 0 &&
                    c.start <= this.deps.video.currentTime * 1000 &&
                    this.deps.video.currentTime * 1000 < c.end
            );
        const meta = this.deps.metadata();
        if (!cue || !meta.episodeId || !this.account) {
            if (this.status) this.status.textContent = 'Sign in and pause on a subtitle first.';
            return;
        }
        try {
            const r = await this.deps.send({
                command: 'savi-save-watch-interest',
                account: this.account,
                item: {
                    lang: this.lang,
                    episodeId: meta.episodeId,
                    show: meta.show ?? '',
                    episodeTitle: meta.title,
                    lineStartMs: cue.start,
                    lineEndMs: cue.end,
                    lineText: cue.text,
                    kind: 'bookmark',
                    context: this.deps
                        .subtitles()
                        .filter((c) => (c.track ?? 0) === 0 && c !== cue && Math.abs(c.start - cue.start) < 20000)
                        .slice(0, 4)
                        .map((c) => c.text),
                },
            });
            if (this.status)
                this.status.textContent = r?.ok
                    ? 'Bookmarked locally; sync will follow.'
                    : 'Could not save this moment.';
        } catch {
            if (this.status) this.status.textContent = 'Could not save this moment.';
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
        if (
            !this.bound ||
            this.mode !== 'explore' ||
            !this.enabled ||
            !this.account ||
            !element ||
            !this.deps.video.paused
        )
            return;
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
