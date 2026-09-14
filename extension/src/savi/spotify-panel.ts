import {
    readSpotifyPlayback,
    readSpotifyLines,
    parseSpotifyText,
    playbackDelta,
    spotifyIdentity,
    type SpotifyLine,
    type SpotifyPlayback,
    type PlaybackPoint,
} from './spotify';
import { Segmenter, type SegmenterOutput } from './segmenter';
import { serializeToSrt } from './subtitle-serializer';
import { finishNotice } from './capture-notice';
import type { SaviToken, SaviDictEntry } from './daemon-client';

export interface SpotifyPanelDeps {
    send(message: any): Promise<any>;
    settings(): Promise<{ lang: string; enabled: boolean; muted: boolean }>;
}
/** One controller owns this document. Reuses Savi's account, outbox and capture API. */
export class SpotifyPanel {
    private host = document.createElement('aside');
    private root = this.host.attachShadow({ mode: 'open' });
    private body = document.createElement('div');
    private heading = document.createElement('h2');
    private status = document.createElement('p');
    private playbackLabel = document.createElement('p');
    private textStatus = document.createElement('p');
    private list = document.createElement('div');
    private detail = document.createElement('div');
    private selectedText = document.createElement('div');
    private captureButton = document.createElement('button');
    private replayButton = document.createElement('button');
    private bookmarkButton = document.createElement('button');
    private modeSelect = document.createElement('select');
    private input = document.createElement('textarea');
    private state: SpotifyPlayback = { title: '', show: '', playing: false, local: false, rate: 1 };
    private lines: SpotifyLine[] = [];
    private provider = new Map<string, SpotifyLine[]>();
    private providerLanguages = new Map<string, string>();
    private confirmedLanguages = new Map<string, string>();
    private imported = new Map<string, SpotifyLine[]>();
    private selected?: SpotifyLine;
    private lang = '';
    private account = '';
    private enabled = false;
    private hoverEnabled = false;
    private mode = 'watch';
    private configGeneration = 0;
    private generation = 0;
    private disposed = false;
    private interval?: ReturnType<typeof setInterval>;
    private refresh?: ReturnType<typeof setInterval>;
    private dwell?: ReturnType<typeof setTimeout>;
    private mediaEvents = [
        'pause',
        'waiting',
        'seeking',
        'ratechange',
        'emptied',
        'loadstart',
        'volumechange',
        'ended',
    ];
    private mediaChanged = () => {
        this.enqueueOps(this.segmenter?.pause() ?? []);
        if (this.state.media)
            this.enqueueOps(
                this.segmenter?.rateChange(this.state.media.currentTime * 1000, this.state.media.playbackRate) ?? []
            );
        this.previous = undefined;
        this.verifiedMedia = undefined;
        this.verifiedId = '';
        this.stableSince = performance.now();
        this.exposureCoverage.clear();
        this.cancelDwell();
    };
    private replayUntil?: { id: string; end: number };
    private previousMedia?: HTMLMediaElement;
    private verifiedMedia?: HTMLMediaElement;
    private verifiedId = '';
    private stableSince = 0;
    private reassertedAt = 0;
    private previous?: PlaybackPoint;
    private engaged = 0;
    private startedAt = 0;
    private creditedId = '';
    private captureId = '';
    private segmenter?: Segmenter;
    private captureBusy = false;
    private captureChain = Promise.resolve();
    private seen = new Set<string>();
    private exposureCoverage = new Map<string, number>();
    private buttons: HTMLButtonElement[] = [];
    constructor(private deps: SpotifyPanelDeps) {}
    start() {
        this.host.dataset.saviSpotify = 'true';
        this.host.setAttribute('aria-label', 'Savi Spotify learning');
        const style = document.createElement('style');
        style.textContent = `:host{position:fixed;right:12px;bottom:100px;z-index:2147483500;width:min(370px,calc(100vw - 24px));font:14px/1.5 system-ui;color:#eef3f8}*{box-sizing:border-box}h2,p{margin:0 0 10px}h2{font-size:17px}button,select,textarea{font:inherit;color:inherit;background:#253443;border:1px solid #61748a;border-radius:8px;padding:8px;min-height:40px}button{cursor:pointer}button:hover,button:focus-visible{background:#35526b}button:disabled{opacity:.45;cursor:default}button[aria-pressed=true]{border-color:#84e6c1;background:#1c5348}section{background:#111d29;border:1px solid #536677;border-radius:12px;padding:12px;box-shadow:0 8px 35px #0008;max-height:70vh;overflow:auto}.row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.lines{max-height:190px;overflow:auto;display:grid;gap:6px;margin:8px 0}.lines button{text-align:left;width:100%;white-space:pre-wrap}.words{white-space:pre-wrap;margin:8px 0}.words button{border:0;padding:3px;min-height:32px}textarea{width:100%;height:100px;margin-top:8px}small,p{color:#bacbd8}summary{cursor:pointer;padding:8px 0}a{color:#91d4ff}.details{border-top:1px solid #536677;padding-top:8px;overflow-wrap:anywhere}@media(max-width:500px){:host{right:8px;width:calc(100vw - 16px);bottom:88px}section{max-height:65vh}.row{display:grid;grid-template-columns:1fr 1fr}.row>*{width:100%}}`;
        const section = document.createElement('section');
        const toggle = this.button('Savi · Spotify', () => {
            this.body.hidden = !this.body.hidden;
            toggle.setAttribute('aria-expanded', String(!this.body.hidden));
        });
        toggle.setAttribute('aria-expanded', 'true');
        this.heading.textContent = 'Start a song or podcast';
        this.status.setAttribute('role', 'status');
        const actions = document.createElement('div');
        actions.className = 'row';
        for (const mode of ['watch', 'explore', 'listen']) {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode[0].toUpperCase() + mode.slice(1);
            this.modeSelect.append(option);
        }
        this.modeSelect.setAttribute('aria-label', 'Savi immersion mode');
        this.modeSelect.onchange = () => void this.changeMode();
        this.bookmarkButton = this.button('Save selected line', () => void this.save('bookmark'));
        this.replayButton = this.button('Replay line', () => this.replay());
        this.captureButton = this.button('Record audio', () => void this.toggleCapture());
        actions.append(this.modeSelect, this.bookmarkButton, this.replayButton, this.captureButton);
        const reveal = this.button('Reveal / hide text', () => {
            this.list.hidden = !this.list.hidden;
            this.selectedText.hidden = this.list.hidden;
        });
        this.list.className = 'lines';
        this.selectedText.className = 'words';
        this.selectedText.onmouseenter = () => {
            if (this.selected) this.arm(this.selected);
        };
        this.selectedText.onmouseleave = this.cancelDwell;
        this.detail.className = 'details';
        const importer = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Add lyrics or a transcript';
        const help = document.createElement('p');
        help.textContent =
            'Open Lyrics or Read along in Spotify first. If unavailable, paste text or import a publisher’s SRT, VTT or LRC file. Plain text has no exact replay timing.';
        this.input.placeholder = 'Paste lyrics, transcript, SRT, VTT or LRC';
        this.input.setAttribute('aria-label', 'Lyrics or transcript');
        const upload = document.createElement('input');
        upload.type = 'file';
        upload.accept = '.srt,.vtt,.lrc,.txt';
        upload.setAttribute('aria-label', 'Import transcript file');
        upload.onchange = () => {
            const file = upload.files?.[0];
            if (file) {
                if (file.size > 500000) {
                    this.notice('Text file is too large (500 KB maximum).');
                    return;
                }
                const id = this.state.identity?.id;
                void file.text().then((text) => {
                    if (this.state.identity?.id === id) {
                        this.input.value = text;
                        this.importText();
                    }
                });
            }
        };
        importer.append(
            summary,
            help,
            this.button('Use visible Spotify text', () => {
                const lines = readSpotifyLines(document),
                    id = this.state.identity?.id;
                if (!id || !lines.length) {
                    this.notice('No visible lyrics or transcript found. Open the Spotify text panel or import a file.');
                    return;
                }
                this.imported.set(id, lines);
                this.confirmedLanguages.set(id, this.lang);
                this.refreshLines();
            }),
            this.input,
            this.button('Use this text', () => this.importText()),
            upload
        );
        const link = document.createElement('a');
        link.href = 'https://savi.tianxiaocao.com';
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'Open your Savi library and review';
        this.body.append(
            this.heading,
            this.playbackLabel,
            this.textStatus,
            actions,
            reveal,
            this.list,
            this.selectedText,
            this.detail,
            importer,
            this.status,
            link
        );
        section.append(toggle, this.body);
        this.root.append(style, section);
        document.body.append(this.host);
        window.addEventListener('message', this.onText);
        window.postMessage({ type: 'savi-spotify-text-request' }, 'https://open.spotify.com');
        window.addEventListener('pagehide', this.onPageHide);
        window.addEventListener('blur', this.cancelDwell);
        void this.configure();
        this.tick();
        this.interval = setInterval(() => this.tick(), 250);
        this.refresh = setInterval(() => void this.configure(), 60000);
    }
    stop() {
        this.disposed = true;
        this.generation++;
        this.configGeneration++;
        this.cancelDwell();
        clearInterval(this.interval);
        clearInterval(this.refresh);
        this.flush();
        void this.finishCapture();
        for (const event of this.mediaEvents) this.previousMedia?.removeEventListener(event, this.mediaChanged);
        this.host.remove();
        window.removeEventListener('message', this.onText);
        window.removeEventListener('pagehide', this.onPageHide);
        window.removeEventListener('blur', this.cancelDwell);
    }
    private button(label: string, action: () => void) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.onclick = action;
        return b;
    }
    private notice(text: string) {
        this.status.textContent = text;
    }
    private onPageHide = () => {
        this.flush();
        void this.finishCapture();
    };
    private cancelDwell = () => {
        clearTimeout(this.dwell);
        this.dwell = undefined;
    };
    private async configure() {
        const gen = ++this.configGeneration;
        try {
            const [settings, config] = await Promise.all([
                this.deps.settings(),
                this.deps.send({ command: 'savi-watch-interest-config' }),
            ]);
            if (this.disposed || gen !== this.configGeneration) return;
            if (this.account !== config.account || this.lang !== settings.lang) {
                this.engaged = 0;
                this.previous = undefined;
                this.seen.clear();
                this.cancelDwell();
                this.generation++;
            }
            this.account = config.account ?? '';
            this.lang = settings.lang;
            this.enabled = settings.enabled && Boolean(this.account) && Boolean(this.lang) && !settings.muted;
            this.hoverEnabled = config.enabled === true;
            this.mode = config.mode ?? 'watch';
            this.modeSelect.value = this.mode;
            this.host.hidden = settings.muted;
            this.list.hidden = this.mode === 'listen';
            this.selectedText.hidden = this.list.hidden;
            if (!this.account) this.notice('Sign in to the same Savi account in extension settings.');
            else if (!this.lang) this.notice('Choose your learning language in Savi settings.');
        } catch {
            this.enabled = false;
            this.notice('Savi connection unavailable. Text remains readable; retry shortly.');
        }
    }
    private async changeMode() {
        const mode = this.modeSelect.value;
        try {
            const r = await this.deps.send({ command: 'savi-set-immersion-mode', mode });
            if (!r?.ok) throw Error();
            this.mode = mode;
            this.cancelDwell();
            this.list.hidden = mode === 'listen';
            this.selectedText.hidden = this.list.hidden;
        } catch {
            this.modeSelect.value = this.mode;
            this.notice('Could not save mode. Try again.');
        }
    }
    private onText = (event: MessageEvent) => {
        if (
            event.source !== window ||
            event.origin !== 'https://open.spotify.com' ||
            event.data?.type !== 'savi-spotify-text'
        )
            return;
        const { id, lines } = event.data;
        if (!spotifyIdentity(id) || !Array.isArray(lines) || lines.length > 5000) return;
        const valid = lines.filter(
            (l: any) =>
                typeof l.text === 'string' &&
                l.text.length <= 4000 &&
                ((l.timing === 'untimed' && l.start === undefined && l.end === undefined) ||
                    (l.timing === 'timed' &&
                        Number.isSafeInteger(l.start) &&
                        Number.isSafeInteger(l.end) &&
                        l.start >= 0 &&
                        l.end > l.start &&
                        l.end - l.start <= 120000))
        );
        this.provider.set(id, valid);
        if (typeof event.data.language === 'string') this.providerLanguages.set(id, event.data.language);
        if (this.provider.size > 10) this.provider.delete(this.provider.keys().next().value!);
        this.refreshLines();
    };
    private importText() {
        const id = this.state.identity?.id;
        if (!id) {
            this.notice('Start a song or episode before attaching text.');
            return;
        }
        const lines = parseSpotifyText(this.input.value);
        if (!lines.length) {
            this.notice('No valid text found. Check the file and its timestamps.');
            return;
        }
        this.imported.set(id, lines);
        this.confirmedLanguages.set(id, this.lang);
        this.cancelDwell();
        this.refreshLines();
        this.notice('Text attached to this song or episode in this tab. Save selected lines to keep them in Savi.');
    }
    private refreshLines() {
        const id = this.state.identity?.id;
        const next = id ? (this.imported.get(id) ?? this.provider.get(id) ?? []) : [];
        if (JSON.stringify(next) === JSON.stringify(this.lines)) return;
        this.cancelDwell();
        this.lines = next;
        this.selected = undefined;
        this.selectedText.replaceChildren();
        this.detail.replaceChildren();
        this.renderLines();
    }
    private renderLines() {
        this.list.replaceChildren();
        this.buttons = [];
        for (const line of this.lines) {
            const b = this.button(line.text, () => void this.select(line));
            b.setAttribute('aria-label', `Select line: ${line.text}`);
            b.onmouseenter = () => {
                void this.select(line);
            };
            b.onmouseleave = this.cancelDwell;
            this.buttons.push(b);
            this.list.append(b);
        }
        this.textStatus.textContent = this.lines.length
            ? `${this.lines.length} lines · ${this.lines.filter((l) => l.timing === 'timed').length} timed · ${this.imported.has(this.state.identity?.id ?? '') ? 'imported text' : 'Spotify text'}`
            : 'No lyrics or transcript available yet. Open Spotify Lyrics / Read along, or add text below.';
    }
    private tick() {
        if (this.disposed) return;
        const next = readSpotifyPlayback(document);
        const changed = next.identity?.id !== this.state.identity?.id;
        if (changed) {
            this.flush();
            this.cancelDwell();
            void this.finishCapture();
            this.generation++;
            this.previous = undefined;
            this.replayUntil = undefined;
            this.exposureCoverage.clear();
            this.state = next;
            this.lines = [];
            this.selected = undefined;
            this.selectedText.replaceChildren();
            this.detail.replaceChildren();
            this.input.value = '';
            this.refreshLines();
            this.renderLines();
        } else this.state = next;
        if (changed || next.media !== this.previousMedia) {
            this.previous = undefined;
            this.verifiedMedia = undefined;
            this.verifiedId = '';
            this.stableSince = performance.now();
            this.enqueueOps(this.segmenter?.pause() ?? []);
        }
        if (this.previousMedia !== next.media) {
            for (const event of this.mediaEvents) {
                this.previousMedia?.removeEventListener(event, this.mediaChanged);
                next.media?.addEventListener(event, this.mediaChanged);
            }
        }
        this.previousMedia = next.media;
        const heading = next.identity
            ? `${next.title || next.identity.kind}${next.show ? ` · ${next.show}` : ''}`
            : 'Start a song or podcast in Spotify';
        if (this.heading.textContent !== heading) this.heading.textContent = heading;
        const playbackLabel = next.identity
            ? `${next.playing ? 'Playing' : 'Paused'}${next.positionMs !== undefined ? ` · ${Math.floor(next.positionMs / 1000)}s` : ''} · ${next.rate}×${next.local ? '' : ' · local playback clock unavailable'}`
            : 'Sign in to Spotify and play on this browser.';
        if (this.playbackLabel.textContent !== playbackLabel) this.playbackLabel.textContent = playbackLabel;
        if (
            this.replayUntil &&
            next.identity?.id === this.replayUntil.id &&
            next.positionMs !== undefined &&
            next.positionMs >= this.replayUntil.end
        ) {
            this.replayUntil = undefined;
            next.media?.pause();
        }
        const point =
            next.identity && next.positionMs !== undefined
                ? {
                      id: next.identity.id,
                      positionMs: next.positionMs,
                      at: performance.now(),
                      playing: next.playing,
                      local: next.local,
                      rate: next.rate,
                  }
                : undefined;
        const delta = point ? playbackDelta(this.previous, point) : 0;
        if (!delta) this.stableSince = performance.now();
        if (delta && performance.now() - this.stableSince >= 1000 && point && next.media) {
            this.verifiedMedia = next.media;
            this.verifiedId = point.id;
        }
        if (delta && this.enabled && point && this.verifiedId === point.id) {
            if (!this.engaged) {
                this.startedAt = Date.now() - delta;
                this.creditedId = point.id;
            }
            this.engaged += delta;
            if (this.engaged >= 30000) this.flush();
            this.heard(point, delta);
        }
        if (!delta) this.exposureCoverage.clear();
        this.updateCapture(point);
        this.previous = point;
        if (!next.playing && this.captureId) this.enqueueOps(this.segmenter?.pause() ?? []);
        if (next.playing || changed) this.cancelDwell();
        this.bookmarkButton.disabled = !this.selected || !this.account;
        this.replayButton.disabled = !this.selected || this.selected.timing !== 'timed' || !next.local;
        this.captureButton.disabled =
            this.captureBusy ||
            (!this.captureId &&
                (!next.local ||
                    this.verifiedMedia !== next.media ||
                    this.verifiedId !== next.identity?.id ||
                    !this.lines.some((l) => l.timing === 'timed')));
        if (!this.lines.length) this.refreshLines();
    }
    private heard(point: PlaybackPoint, wallMs: number) {
        const evidenceLang = this.confirmedLanguages.get(point.id) ?? this.providerLanguages.get(point.id);
        if (!evidenceLang || evidenceLang.split('-')[0] !== this.lang.split('-')[0]) return;
        const cue = this.lines.find(
            (l) => l.timing === 'timed' && l.start! <= point.positionMs && point.positionMs < l.end!
        );
        if (!cue) return;
        const key = `${point.id}:${cue.start}:${cue.text}`;
        if (this.seen.has(`heard:${key}`)) return;
        // Require one continuous interval covering 90%; seeks and pauses don't fill gaps.
        if (this.previous && this.previous.positionMs >= cue.start!) {
            const coverage = (this.exposureCoverage.get(key) ?? 0) + wallMs * point.rate;
            this.exposureCoverage.set(key, coverage);
            if (coverage >= (cue.end! - cue.start!) * 0.9) {
                this.seen.add(`heard:${key}`);
                void this.deps
                    .send({
                        command: 'savi-watched-line',
                        lang: this.lang,
                        text: cue.text,
                        episodeId: point.id,
                        lineStartMs: cue.start,
                        occurredAtMs: Date.now(),
                        glossedWords: [],
                        hoverGlossedWords: [],
                    })
                    .catch(() => {
                        this.seen.delete(`heard:${key}`);
                    });
            }
        }
    }
    private flush() {
        if (!this.engaged || !this.creditedId) return;
        const message = {
            command: 'savi-engagement-session',
            id: crypto.randomUUID(),
            kind: 'listen',
            lang: this.lang,
            source: `watch:${this.creditedId}`,
            engagedMs: Math.round(this.engaged),
            startedAtMs: Math.round(this.startedAt),
            endedAtMs: Date.now(),
            tzOffsetMin: -new Date().getTimezoneOffset(),
        };
        this.engaged = 0;
        void this.deps
            .send(message)
            .then((r) => {
                if (!r?.ok) return this.deps.send(message);
            })
            .catch(() => this.deps.send(message))
            .catch(() => this.notice('Listening time could not sync. Check Savi desktop.'));
    }
    private async select(line: SpotifyLine) {
        if (this.selected === line) {
            this.arm(line);
            return;
        }
        this.cancelDwell();
        this.selected = line;
        const gen = this.generation;
        this.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(this.lines[i] === line)));
        this.selectedText.textContent = line.text;
        this.detail.textContent = 'Select or hover a word for its dictionary entry.';
        this.arm(line);
        try {
            const r = await this.deps.send({ command: 'savi-tokenize', lang: this.lang, text: line.text });
            if (gen !== this.generation || this.selected !== line) return;
            const tokens = r?.tokens as SaviToken[];
            if (!tokens?.length || tokens.map((t) => t.text).join('') !== line.text) {
                this.detail.textContent =
                    'Dictionary tokenizer unavailable for this line. The text can still be saved.';
                return;
            }
            this.selectedText.replaceChildren();
            for (const token of tokens) {
                const b = this.button(token.text, () => void this.lookup(token));
                b.onmouseenter = () => void this.lookup(token);
                this.selectedText.append(b);
            }
        } catch {
            this.detail.textContent = 'Dictionary unavailable. Check Savi desktop.';
        }
    }
    private async lookup(token: SaviToken) {
        const gen = this.generation,
            selected = this.selected;
        try {
            const r = await this.deps.send({ command: 'savi-dict', term: token.lemma ?? token.text });
            if (gen !== this.generation || this.selected !== selected) return;
            const entries = (r?.entries ?? []) as SaviDictEntry[];
            this.detail.textContent = entries.length
                ? entries
                      .slice(0, 3)
                      .map((e) => `${e.readings.join(' / ')} · ${e.senses.flatMap((s) => s.glosses).join('; ')}`)
                      .join('\n')
                : 'No dictionary entry available.';
        } catch {
            this.detail.textContent = 'Dictionary unavailable. Try again.';
        }
    }
    private arm(line: SpotifyLine) {
        this.cancelDwell();
        if (
            this.mode !== 'explore' ||
            !this.hoverEnabled ||
            !this.account ||
            this.state.playing ||
            !document.hasFocus()
        )
            return;
        if (
            line.timing === 'timed' &&
            (this.state.positionMs === undefined ||
                this.state.positionMs < line.start! ||
                this.state.positionMs >= line.end!)
        )
            return;
        const textLang =
            this.confirmedLanguages.get(this.state.identity?.id ?? '') ??
            this.providerLanguages.get(this.state.identity?.id ?? '');
        if (textLang && textLang.split('-')[0] !== this.lang.split('-')[0]) return;
        const gen = this.generation,
            id = this.state.identity?.id,
            position = this.state.positionMs;
        this.dwell = setTimeout(() => {
            if (
                gen !== this.generation ||
                id !== this.state.identity?.id ||
                this.state.playing ||
                this.selected !== line ||
                this.state.positionMs !== position
            )
                return;
            void this.save('hover');
        }, 1500);
    }
    private async save(kind: 'hover' | 'bookmark') {
        const line = this.selected,
            identity = this.state.identity;
        if (!line || !identity || !this.account) return;
        const account = this.account,
            key = `${account}:${identity.id}:${line.timing}:${line.start ?? line.text}`;
        if (kind === 'hover' && this.seen.has(key)) return;
        const item = {
            lang: this.lang,
            episodeId: identity.id,
            show: this.state.show,
            episodeTitle: this.state.title,
            lineStartMs: line.start ?? 0,
            lineEndMs: line.end ?? 0,
            lineText: line.text,
            textTiming: line.timing,
            kind,
            dwellMs: kind === 'hover' ? 1500 : 0,
            context: this.lines
                .slice(Math.max(0, this.lines.indexOf(line) - 2), this.lines.indexOf(line) + 3)
                .filter((l) => l !== line)
                .slice(0, 4)
                .map((l) => l.text.slice(0, 1000)),
        };
        try {
            const result = await this.deps.send({ command: 'savi-save-watch-interest', account, item });
            if (result?.ok) {
                this.seen.add(key);
                this.notice(
                    kind === 'hover'
                        ? 'Interest saved locally; knowledge-aware selection will sync to Savi.'
                        : 'Line saved locally; open Savi to review it after sync.'
                );
            } else this.notice('Could not save. Check the Savi account and try again.');
        } catch {
            this.notice('Could not save. Try again.');
        }
    }
    private replay() {
        if (this.selected?.timing !== 'timed' || !this.state.media) return;
        try {
            this.replayUntil = { id: this.state.identity!.id, end: this.selected.end! };
            this.state.media.currentTime = this.selected.start! / 1000;
            void this.state.media
                .play()
                .catch(() => this.notice('Spotify could not replay. Use its playback controls.'));
        } catch {
            this.notice('Seeking is unavailable for this item.');
        }
    }
    private async toggleCapture() {
        if (this.captureId) {
            await this.finishCapture();
            return;
        }
        const state = this.state;
        if (
            !state.identity ||
            !state.local ||
            !state.media ||
            this.verifiedMedia !== state.media ||
            this.verifiedId !== state.identity.id
        )
            return;
        const lines = this.lines
            .filter((l) => l.timing === 'timed')
            .map((l) => ({ text: l.text, start: l.start!, end: l.end!, track: 0 }));
        if (!lines.length) {
            this.notice('Audio capture needs timed lyrics or a transcript. Import SRT/VTT/LRC first.');
            return;
        }
        this.captureBusy = true;
        try {
            const r = await this.deps.send({
                command: 'savi-start-capture',
                episodeId: state.identity.id,
                title: state.title,
                show: state.show,
                lang: this.lang,
                subtitles: serializeToSrt(lines),
                subtitleFormat: 'srt',
                src: state.identity.url,
                manuallyRequested: true,
            });
            if (!r?.started) {
                this.notice(r?.errorMessage ?? 'Audio could not start. Try again.');
                return;
            }
            this.captureId = state.identity.id;
            if (r.audio?.state !== 'recording') {
                this.notice(
                    `Audio unavailable: ${r.audio?.reason ?? r.audio?.state ?? 'unknown status'}. Stop and retry after checking Savi.`
                );
            } else
                this.notice(
                    `Recording audio from ${r.audio.sourceApp ?? 'this browser'}. Other audible tabs may be included.`
                );
            if (this.state.identity?.id !== state.identity.id) {
                await this.finishCapture();
                return;
            }
            this.segmenter = new Segmenter();
            this.enqueueOps(this.segmenter.begin(this.state.positionMs ?? 0, this.state.rate, true));
            this.captureButton.textContent = 'Stop and save audio';
        } catch {
            this.notice('Audio capture could not start. Check Savi and retry.');
        } finally {
            this.captureBusy = false;
        }
    }
    private updateCapture(point?: PlaybackPoint) {
        if (!this.segmenter || !this.captureId) return;
        if (
            !point ||
            !point.local ||
            point.id !== this.captureId ||
            !point.playing ||
            this.verifiedId !== point.id ||
            this.verifiedMedia !== this.state.media
        ) {
            this.enqueueOps(this.segmenter.pause());
            return;
        }
        const prev = this.previous;
        if (prev && Math.abs(point.positionMs - prev.positionMs - (point.at - prev.at) * point.rate) > 650) {
            this.enqueueOps(this.segmenter.pause());
            this.enqueueOps(this.segmenter.rateChange(point.positionMs, point.rate));
        }
        if (prev && prev.rate !== point.rate) this.enqueueOps(this.segmenter.rateChange(point.positionMs, point.rate));
        if (this.previous && playbackDelta(this.previous, point) === 0) {
            this.enqueueOps(this.segmenter.pause());
            return;
        }
        this.enqueueOps(this.segmenter.play(point.positionMs));
        if (point.at - this.reassertedAt >= 5000 && this.segmenter.currentSegment) {
            this.reassertedAt = point.at;
            this.enqueueOps([{ type: 'segment-start', segment: this.segmenter.currentSegment }]);
        }
    }
    private enqueueOps(outputs: SegmenterOutput[]) {
        if (outputs.some((o) => o.type === 'rate-unsupported'))
            this.notice('Audio capture supports 0.5×–2×. Choose a supported rate to resume.');
        const ops = outputs
            .filter((o) => o.type !== 'rate-unsupported')
            .map((o) => (o.type === 'segment-start' ? { type: o.type, ...o.segment } : { type: o.type }));
        if (!ops.length) return;
        const episodeId = this.captureId;
        this.captureChain = this.captureChain
            .then(async () => {
                const r = await this.deps.send({ command: 'savi-playback-state', episodeId, ops });
                if (!r?.ok || r.audio === 'off') this.notice('Audio capture interrupted. Stop and retry in Savi.');
            })
            .catch(() => this.notice('Audio connection interrupted. Stop and retry.'));
    }
    private async finishCapture() {
        if (!this.captureId) return;
        const episodeId = this.captureId;
        this.enqueueOps(this.segmenter?.pause() ?? []);
        this.segmenter = undefined;
        this.captureId = '';
        this.captureButton.textContent = 'Record audio';
        await this.captureChain;
        try {
            const r = await this.deps.send({ command: 'savi-stop-capture', episodeId });
            this.notice(
                r?.stopped
                    ? 'Saving recorded audio in Savi…'
                    : (r?.errorMessage ?? 'Could not finish audio. Retry in Savi.')
            );
        } catch {
            this.notice('Audio finish was not confirmed. Check Savi before restarting.');
        }
    }
    captureEnded(message: any) {
        if (message.command === 'savi-capture-ended' && spotifyIdentity(message.src)) {
            this.notice(
                message.ok
                    ? finishNotice(message.info ?? {}).text
                    : (message.errorMessage ?? 'Audio save failed; retry in Savi.')
            );
        }
    }
}
