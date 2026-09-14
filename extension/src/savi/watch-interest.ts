import { captureWatchScreenshot } from './watch-screenshot';
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
    replay?(startMs: number): Promise<void>;
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
    private availability?: HTMLElement;
    private replayButton?: HTMLButtonElement;
    private bookmarkButton?: HTMLButtonElement;
    private controlRefresh?: ReturnType<typeof setInterval>;
    private modeRevision = 0;
    private savingMode = false;
    private savingBookmark = false;
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
        this.deps.video.addEventListener('timeupdate', this.updateControls);
        this.deps.video.addEventListener('seeked', this.updateControls);
        this.controlRefresh = setInterval(this.updateControls, 500);
        void this.config();
        this.refresh = setInterval(() => void this.config(), 60000);
    }
    stop() {
        this.bound = false;
        clearInterval(this.controlRefresh);
        this.deps.video.removeEventListener('timeupdate', this.updateControls);
        this.deps.video.removeEventListener('seeked', this.updateControls);
        this.savingMode = false;
        this.savingBookmark = false;
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
        const revision = this.modeRevision;
        try {
            const result = await this.deps.send({ command: 'savi-watch-interest-config' });
            if (!this.bound || generation !== this.generation) return;
            if (this.account !== result?.account) {
                this.clear();
                this.saved.clear();
            }
            this.account = result?.account ?? '';
            this.enabled = result?.enabled === true;
            const nextMode = revision === this.modeRevision ? (result?.mode ?? 'watch') : this.mode;
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
        this.updateControls();
    }
    private replayCue() {
        const now = this.deps.video.currentTime * 1000;
        const cues = this.deps
            .subtitles()
            .filter(
                (c) =>
                    (c.track ?? 0) === 0 &&
                    c.text.trim() &&
                    Number.isFinite(c.start) &&
                    Number.isFinite(c.end) &&
                    c.start >= 0 &&
                    c.end > c.start
            );
        const current = cues.find((c) => c.start <= now && now < c.end);
        const previous = cues
            .filter((c) => c.start <= now)
            .reduce<Cue | undefined>((latest, c) => (!latest || c.start > latest.start ? c : latest), undefined);
        return (
            current ??
            previous ??
            cues.reduce<Cue | undefined>((first, c) => (!first || c.start < first.start ? c : first), undefined)
        );
    }
    private updateControls = () => {
        if (!this.bound) return;
        const cue = this.replayCue();
        const now = this.deps.video.currentTime * 1000;
        const reasons: string[] = [];
        if (this.replayButton) {
            this.replayButton.disabled = !cue;
            this.replayButton.textContent = !cue
                ? 'Replay line'
                : now < cue.start
                  ? 'Play first line'
                  : now >= cue.end
                    ? 'Replay previous line'
                    : 'Replay line';
            this.replayButton.title = cue
                ? 'Play from the beginning of this subtitle.'
                : 'Load subtitles to replay a line.';
        }
        if (!cue) reasons.push('Load subtitles to use Replay.');
        if (this.revealButton) {
            this.revealButton.disabled = this.mode !== 'listen' || !cue;
            this.revealButton.title = !cue
                ? 'Load subtitles to use Reveal text.'
                : this.mode === 'listen'
                  ? 'Show or hide subtitles.'
                  : 'Reveal text is available in Listen mode.';
        }
        if (this.mode !== 'listen') reasons.push('Reveal text is available in Listen mode.');
        const current = this.deps.subtitles().some((c) => (c.track ?? 0) === 0 && c.start <= now && now < c.end);
        const bookmarkReason = !this.account
            ? 'Sign in to bookmark moments.'
            : !this.deps.metadata().episodeId
              ? 'This video is not identified yet.'
              : !current
                ? 'Play or seek to a subtitle to bookmark it.'
                : '';
        if (this.bookmarkButton) {
            this.bookmarkButton.disabled = !!bookmarkReason || this.savingBookmark;
            this.bookmarkButton.textContent = this.savingBookmark ? 'Saving…' : 'Bookmark';
            this.bookmarkButton.title = bookmarkReason || 'Save this subtitle to your Savi library.';
        }
        if (bookmarkReason) reasons.push(bookmarkReason);
        if (this.availability) this.availability.textContent = reasons.join(' ');
        this.toolbar?.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
            b.disabled = this.savingMode;
        });
    };
    private async changeMode(mode: string) {
        if (this.savingMode) return;
        const generation = this.generation;
        const previous = this.mode;
        const previousReveal = this.revealed;
        this.modeRevision++;
        this.mode = mode;
        this.revealed = false;
        this.savingMode = true;
        this.updateMode();
        if (this.status) this.status.textContent = 'Saving preference…';
        try {
            const result = await this.deps.send({ command: 'savi-set-immersion-mode', mode });
            if (!this.bound || generation !== this.generation) return;
            if (!result?.ok) throw new Error('Mode not saved');
            if (this.status)
                this.status.textContent = `${mode[0].toUpperCase() + mode.slice(1)} mode · saved on this browser`;
        } catch {
            if (!this.bound || generation !== this.generation) return;
            this.mode = previous;
            this.revealed = previousReveal;
            if (this.status) this.status.textContent = 'Could not save mode on this browser. Try again.';
        } finally {
            if (this.bound && generation === this.generation) {
                this.savingMode = false;
                this.updateMode();
            }
        }
    }
    private async replayLine() {
        const cue = this.replayCue();
        const generation = this.generation;
        if (!cue) {
            this.updateControls();
            return;
        }
        try {
            if (this.deps.replay) await this.deps.replay(cue.start);
            else {
                this.deps.video.currentTime = cue.start / 1000;
                await this.deps.video.play();
            }
            if (!this.bound || generation !== this.generation) return;
            if (this.status) this.status.textContent = 'Playing from the start of the subtitle.';
        } catch {
            if (!this.bound || generation !== this.generation) return;
            if (this.status)
                this.status.textContent = 'Could not replay this line. Press Play on the video and try again.';
        }
        this.updateControls();
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
        const style = document.createElement('style');
        style.textContent =
            'button:disabled { opacity:.4; cursor:not-allowed !important; } button:focus-visible { outline:2px solid #4cc2ff; outline-offset:2px; }';
        shadow.append(style);
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
                void this.changeMode(mode);
            });
            b.dataset.mode = mode;
        }
        this.revealButton = button('Reveal text', () => {
            this.revealed = !this.revealed;
            this.updateMode();
        });
        this.replayButton = button('Replay line', () => {
            void this.replayLine();
        });
        this.bookmarkButton = button('Bookmark', () => {
            const generation = this.generation;
            this.savingBookmark = true;
            this.updateControls();
            void this.bookmark().finally(() => {
                if (generation === this.generation) {
                    this.savingBookmark = false;
                    this.updateControls();
                }
            });
        });
        const availability = document.createElement('span');
        availability.id = 'availability';
        Object.assign(availability.style, { width: '100%', fontSize: '12px', lineHeight: '1.5', color: '#a6b3c1' });
        this.availability = availability;
        for (const control of [this.revealButton, this.replayButton, this.bookmarkButton])
            control.setAttribute('aria-describedby', 'availability');
        const details = button('−', () => {
            const collapsed = box.dataset.collapsed !== 'true';
            box.dataset.collapsed = String(collapsed);
            for (const child of Array.from(box.children)) {
                if (child !== details) (child as HTMLElement).style.display = collapsed ? 'none' : '';
            }
            details.textContent = collapsed ? 'Savi modes' : '−';
            details.setAttribute('aria-expanded', String(!collapsed));
            details.setAttribute('aria-label', collapsed ? 'Expand study controls' : 'Collapse study controls');
        });
        details.setAttribute('aria-label', 'Expand study controls');
        const status = document.createElement('span');
        status.setAttribute('role', 'status');
        box.append(status);
        this.status = status;
        box.append(availability);
        shadow.append(box);
        (document.fullscreenElement ?? document.body).append(host);
        this.toolbarHost = host;
        this.toolbar = box;
        details.click();
        this.updateMode();
    }
    private async saveMoment(account: string, item: any) {
        const generation = this.generation;
        const time = this.deps.video.currentTime;
        const current = () =>
            this.bound &&
            generation === this.generation &&
            this.account === account &&
            this.deps.metadata().episodeId === item.episodeId &&
            Math.abs(this.deps.video.currentTime - time) < 0.05;
        let screenshotDataUrl: string | undefined;
        if (this.deps.video.getBoundingClientRect().width > 0) {
            let expired = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                screenshotDataUrl = await Promise.race([
                    captureWatchScreenshot(this.deps.video, this.deps.send, () => !expired && current()),
                    new Promise<undefined>((resolve) => {
                        timer = setTimeout(() => {
                            expired = true;
                            resolve(undefined);
                        }, 2000);
                    }),
                ]);
            } finally {
                expired = true;
                clearTimeout(timer);
            }
        }
        // The chosen subtitle remains valid even if the player subsequently moves,
        // but account changes must never enqueue into another account.
        if (!this.bound || generation !== this.generation || this.account !== account) return { ok: false };
        return this.deps.send({
            command: 'savi-save-watch-interest',
            account,
            item: { ...item, ...(screenshotDataUrl ? { screenshotDataUrl } : {}) },
        });
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
            const r = await this.saveMoment(this.account, {
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
            void this.saveMoment(account, {
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
            })
                .then((result) => {
                    if (result?.ok && this.account === account) this.saved.add(key);
                })
                .catch(() => {});
        }, 1500);
    };
}
