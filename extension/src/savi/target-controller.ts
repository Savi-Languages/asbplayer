import { TargetHeardCoverage } from './target-heard';
import { subtitleTokens } from './token-cache';
import type { SaviWatchedLineMessage } from './messages';
import type { HeardTargetMine } from './target-types';
import { SaviTargetDecorator } from './target-decorator';
import { feedback, type TargetDecision, type TargetPreparation } from './target-types';

interface Sources {
    video: HTMLMediaElement;
    metadata(): { episodeId: string | undefined; title: string; show?: string };
    subtitles(): readonly { text: string; start: number; end: number; track?: number }[];
    pause(): void;
    play(): void;
    send(message: unknown): Promise<any>;
}
/** Episode attention state. Preparation is detached from capture and playback;
 *  only a subsequent play gesture can open/pause for the already-ready card. */
export class SaviTargetController {
    private readonly decorator: SaviTargetDecorator;
    private readonly coverage = new TargetHeardCoverage();
    private readonly frames = new Map<number, string>();
    private readonly sampledFrames = new Set<number>();
    private lang = '';
    private generation = 0;
    private attempted = '';
    private retryAt = 0;
    private episode = '';
    private prepared: TargetPreparation | null = null;
    private cardShown = false;
    private host?: HTMLElement;
    private bound = false;
    private readonly onPlay = () => {
        this.checkEpisode();
        this.sample();
        if (!this.prepared || this.cardShown || !this.prepared.cardEnabled || !this.prepared.targets.length) return;
        this.cardShown = true;
        this.deps.pause();
        this.showCard();
    };
    private readonly onTime = () => {
        this.checkEpisode();
        this.sample();
    };
    private readonly onAccount = (changes: Record<string, any>) => {
        if ('saviAccount' in changes && changes.saviAccount.oldValue?.userId !== changes.saviAccount.newValue?.userId) {
            this.clearEpisode();
            this.checkEpisode();
        }
    };
    constructor(private readonly deps: Sources) {
        this.decorator = new SaviTargetDecorator(deps.subtitles);
    }
    start(lang: string): void {
        lang = lang.toLowerCase().split(/[-_]/)[0];
        if (this.bound && this.lang === lang) {
            this.checkEpisode();
            return;
        }
        this.stop();
        this.lang = lang;
        if (!lang) return;
        this.bound = true;
        this.deps.video.addEventListener('play', this.onPlay);
        this.deps.video.addEventListener('timeupdate', this.onTime);
        for (const name of ['pause', 'seeking', 'volumechange']) this.deps.video.addEventListener(name, this.onTime);
        browser.storage.onChanged.addListener(this.onAccount);
        this.checkEpisode();
    }
    stop(): void {
        this.bound = false;
        this.deps.video.removeEventListener('play', this.onPlay);
        this.deps.video.removeEventListener('timeupdate', this.onTime);
        for (const name of ['pause', 'seeking', 'volumechange']) this.deps.video.removeEventListener(name, this.onTime);
        browser.storage.onChanged.removeListener(this.onAccount);
        this.clearEpisode();
    }
    private clearEpisode(): void {
        this.coverage.clear();
        this.frames.clear();
        this.sampledFrames.clear();
        this.generation++;
        this.attempted = '';
        this.retryAt = 0;
        this.episode = '';
        this.prepared = null;
        this.cardShown = false;
        this.host?.remove();
        this.host = undefined;
        this.decorator.stop();
    }
    private checkEpisode(): void {
        if (!this.bound) return;
        const meta = this.deps.metadata();
        if (!meta.episodeId) {
            if (this.episode) this.clearEpisode();
            return;
        }
        if (this.episode && meta.episodeId !== this.episode) this.clearEpisode();
        const key = JSON.stringify([meta.episodeId, meta.show, meta.title, this.lang]);
        if ((key === this.attempted && Date.now() < this.retryAt) || this.prepared) return;
        this.attempted = key;
        this.retryAt = Infinity;
        this.episode = meta.episodeId;
        const generation = ++this.generation;
        void this.deps
            .send({ command: 'savi-episode-targets', ...meta, lang: this.lang })
            .then((result: TargetPreparation | null) => {
                if (generation !== this.generation || this.deps.metadata().episodeId !== this.episode) return;
                if (!result) {
                    this.retryAt = Date.now() + 30_000;
                    return;
                }
                this.prepared = result;
                this.decorator.setTargets(
                    this.lang,
                    result.targets.map((t) => t.lemma)
                );
                // A slow request never pauses playback after the user's gesture.
            })
            .catch(() => {
                if (generation === this.generation) this.retryAt = Date.now() + 30_000;
            });
    }
    private sample(): void {
        if (!this.bound) return;
        const video = this.deps.video,
            position = video.currentTime * 1000;
        const lines = this.deps.subtitles();
        this.coverage.tick(
            position,
            Date.now(),
            !video.paused && !video.seeking && !video.muted && video.volume > 0,
            video.playbackRate,
            lines
        );
        if (!this.prepared) return;
        for (const line of lines) {
            if (
                (line.track ?? 0) !== 0 ||
                position < line.start ||
                position > line.end ||
                this.sampledFrames.has(line.start) ||
                !this.coverage.heard(line.start, line.end)
            )
                continue;
            this.sampledFrames.add(line.start);
            const generation = this.generation;
            void subtitleTokens
                .getRaw(this.lang, line.text)
                .then((tokens) => {
                    if (
                        generation !== this.generation ||
                        !this.prepared ||
                        !tokens.some((t) => this.prepared!.targets.some((w) => w.lemma === t.lemma)) ||
                        video.currentTime * 1000 > line.end ||
                        video.currentTime * 1000 < line.start
                    )
                        return;
                    if (!(video instanceof HTMLVideoElement) || !video.videoWidth) return;
                    try {
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.min(640, video.videoWidth);
                        canvas.height = Math.round((canvas.width * video.videoHeight) / video.videoWidth);
                        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
                        this.frames.set(line.start, canvas.toDataURL('image/jpeg', 0.75).split(',')[1]);
                        while (this.frames.size > 128) this.frames.delete(this.frames.keys().next().value!);
                    } catch {
                        /* Protected video frames simply have no screenshot. */
                    }
                })
                .catch(() => {});
        }
    }
    onHeardAcknowledged(message: SaviWatchedLineMessage): void {
        // The acknowledgement can precede the next timeupdate at a cue boundary.
        this.checkEpisode();
        this.sample();
        const prepared = this.prepared,
            generation = this.generation;
        if (
            !prepared ||
            message.episodeId !== this.episode ||
            message.lang.toLowerCase().split(/[-_]/)[0] !== this.lang
        )
            return;
        const line = this.deps
            .subtitles()
            .find(
                (l) =>
                    (l.track ?? 0) === 0 &&
                    Math.round(l.start) === message.lineStartMs &&
                    l.text.trim() === message.text.trim()
            );
        if (!line || !this.coverage.heard(line.start, line.end)) return;
        void subtitleTokens
            .getRaw(this.lang, message.text)
            .then(async (tokens) => {
                if (generation !== this.generation || this.prepared !== prepared) return;
                const mines: HeardTargetMine[] = [];
                const seen = new Set<string>();
                for (const token of tokens) {
                    const word = prepared.targets.find((t) => t.lemma === token.lemma);
                    if (!word || seen.has(word.lemma)) continue;
                    seen.add(word.lemma);
                    mines.push({
                        account: prepared.account,
                        episodeId: message.episodeId,
                        tmdb: prepared.identity.tmdbId,
                        lineStartMs: message.lineStartMs,
                        occurredAtMs: message.occurredAtMs,
                        lang: this.lang,
                        lineText: message.text,
                        surface: token.text,
                        lemma: word.lemma,
                        reading: word.reading,
                        gloss: word.gloss,
                        imageBase64: this.frames.get(line.start),
                        exportToAnki: prepared.autoMineToAnki,
                    });
                }
                if (mines.length)
                    await this.deps.send({ command: 'savi-mine-targets', account: prepared.account, mines });
            })
            .catch(() => {});
    }
    private showCard(): void {
        const prepared = this.prepared;
        if (!prepared) return;
        const generation = this.generation;
        const host = document.createElement('div');
        host.dataset.saviTargetCard = '';
        this.host = host;
        host.style.cssText =
            'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:#0008;padding:20px;box-sizing:border-box;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent =
            ':host{font:14px/1.5 system-ui,sans-serif;color:#f2f2f3}section{width:min(520px,100%);max-height:80vh;overflow:auto;box-sizing:border-box;background:#191c24;border:1px solid #3c414d;border-radius:16px;padding:20px}h2{font-size:18px;margin:0}p{margin:6px 0;color:#c0c4ce}.heading,footer,.actions{display:flex;justify-content:space-between;gap:12px;align-items:center}button{min-height:44px;padding:8px 12px;cursor:pointer;color:inherit;background:transparent;border:1px solid #49505d;border-radius:8px;font:inherit}button:disabled{opacity:.5}ul{padding:0;list-style:none}li{border-top:1px solid #353a45;padding:12px 0}.actions{justify-content:flex-start;flex-wrap:wrap;font-size:12px}.start{background:#b8a5dc;color:#14121a;border:0}.error{color:#ffb7b7}';
        shadow.appendChild(style);
        const section = document.createElement('section');
        section.setAttribute('role', 'dialog');
        section.setAttribute('aria-label', 'Words to listen for');
        section.setAttribute('aria-modal', 'true');
        const heading = document.createElement('div');
        heading.className = 'heading';
        const title = document.createElement('h2');
        title.textContent = 'Words to listen for';
        heading.appendChild(title);
        const close = document.createElement('button');
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close target words');
        close.onclick = () => {
            host.remove();
            this.host = undefined;
            this.deps.play();
        };
        heading.appendChild(close);
        section.appendChild(heading);
        const subtitle = document.createElement('p');
        subtitle.textContent = `${prepared.identity.title} · S${prepared.identity.season}E${prepared.identity.episode}`;
        section.appendChild(subtitle);
        const note = document.createElement('p');
        note.textContent = 'Listen for these words. Examples may differ from your subtitles.';
        section.appendChild(note);
        const list = document.createElement('ul');
        section.appendChild(list);
        const error = document.createElement('p');
        error.className = 'error';
        error.setAttribute('role', 'status');
        section.appendChild(error);
        const dismiss = async (lemma: string, kind: TargetDecision, row: HTMLElement) => {
            const buttons = [...row.querySelectorAll('button')];
            buttons.forEach((b) => (b.disabled = true));
            try {
                const response = await this.deps.send({
                    command: 'savi-target-feedback',
                    account: prepared.account,
                    actions: [feedback(prepared.identity, this.lang, lemma, kind)],
                });
                if (generation !== this.generation) return;
                if (!response?.ok) throw new Error('Could not save. Try again, or close the card to continue.');
                prepared.targets = prepared.targets.filter((t) => t.lemma !== lemma);
                row.remove();
                this.decorator.setTargets(
                    this.lang,
                    prepared.targets.map((t) => t.lemma)
                );
            } catch (e) {
                if (generation === this.generation) error.textContent = String(e instanceof Error ? e.message : e);
            } finally {
                buttons.forEach((b) => (b.disabled = false));
            }
        };
        for (const target of prepared.targets) {
            const row = document.createElement('li');
            const word = document.createElement('strong');
            word.textContent = `${target.lemma}${target.reading && target.reading !== target.lemma ? ` (${target.reading})` : ''} · ${target.count}×`;
            row.appendChild(word);
            for (const text of [target.gloss ?? 'Gloss unavailable', target.reason, target.exampleCue]) {
                const p = document.createElement('p');
                p.textContent = text;
                row.appendChild(p);
            }
            const actions = document.createElement('div');
            actions.className = 'actions';
            for (const [label, kind] of [
                ['I know this', 'target_dismissed_known'],
                ['Not for this show', 'target_dismissed_not_this'],
            ] as const) {
                const b = document.createElement('button');
                b.textContent = label;
                b.onclick = () => void dismiss(target.lemma, kind, row);
                actions.appendChild(b);
            }
            row.appendChild(actions);
            list.appendChild(row);
        }
        const start = document.createElement('button');
        start.className = 'start';
        start.textContent = 'Start watching';
        start.onclick = async () => {
            start.disabled = true;
            try {
                const actions = prepared.targets.map((t) =>
                    feedback(prepared.identity, this.lang, t.lemma, 'target_accepted')
                );
                const result = actions.length
                    ? await this.deps.send({ command: 'savi-target-feedback', account: prepared.account, actions })
                    : { ok: true };
                if (generation !== this.generation) return;
                if (!result?.ok) throw new Error('Could not save. Try again, or close the card to continue.');
                host.remove();
                this.host = undefined;
                this.deps.play();
            } catch (e) {
                if (generation === this.generation) error.textContent = String(e instanceof Error ? e.message : e);
            } finally {
                start.disabled = false;
            }
        };
        section.appendChild(start);
        shadow.appendChild(section);
        const fullscreen = document.fullscreenElement;
        (fullscreen && !(fullscreen instanceof HTMLVideoElement) ? fullscreen : document.body).appendChild(host);
        start.focus();
        shadow.addEventListener('keydown', (event) => {
            const key = event as KeyboardEvent;
            if (key.key === 'Escape') {
                key.stopPropagation();
                close.click();
            }
            if (key.key === 'Tab') {
                const buttons = [...shadow.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.disabled);
                const at = buttons.indexOf(shadow.activeElement as HTMLButtonElement);
                const next = (at + (key.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
                key.preventDefault();
                buttons[next]?.focus();
            }
        });
    }
}
