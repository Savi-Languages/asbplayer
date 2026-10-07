import { PauseOnHoverMode } from '@project/common/settings';
import { SaviHoverDictionary } from './hover-dict';
import {
    cleanProviderText,
    readSpotifyTranscriptEntries,
    spotifyIdentity,
    type SpotifyLine,
    type SpotifyPlayback,
    type SpotifyMedia,
} from './spotify';

export interface SpotifyReadingSnapshot {
    playback: SpotifyPlayback;
    lines: SpotifyLine[];
    lang: string;
    visible: boolean;
    pauseOnHoverMode: PauseOnHoverMode;
    account?: string;
    sourceLang?: string;
    translationEnabled?: boolean;
    nativeLanguage?: string;
}
const nativeSelector =
    '#transcript-panel[role="tabpanel"] [data-encore-id="text"][dir="auto"], [data-testid="transcript-segment"], [data-testid="transcript-line"], [data-testid="lyrics-line"]';
type Annotation = {
    cue: SpotifyLine;
    playbackCue?: SpotifyLine;
    native?: boolean;
    node?: Text;
    original?: string;
    normalized?: string;
    english?: HTMLElement;
};
type Translation = { state: 'pending' | 'ready' | 'failed'; text?: string };
type TranslateLine = (
    text: string,
    sourceLang: string,
    targetLang: string,
    context: string
) => Promise<string | undefined>;
const TRANSLATION_CACHE_PREFIX = 'saviSpotifyTranslation:';

export function translationLanguageLabel(code: string): string {
    const normalized = code.trim();
    if (!normalized) return 'your language';
    try {
        return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(normalized) ?? normalized;
    } catch {
        return normalized;
    }
}

/** Element bounds include Spotify's full-width rows and padding. Range fragments
 * follow the rendered text across wraps; separate runs exclude whitespace. */
export function pointOnSpotifyText(element: HTMLElement, x: number, y: number): boolean {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of (node.textContent ?? '').matchAll(/\S+/gu)) {
            range.setStart(node, match.index!);
            range.setEnd(node, match.index! + match[0].length);
            for (const rect of Array.from(range.getClientRects())) {
                if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return true;
            }
        }
    }
    return false;
}

/** Adds dictionary targets to Spotify-owned text. The caption is a fallback,
 * not a second transcript. Never creates timings or uses the browsed item as
 * the recording/study identity. */
export class SpotifyReadingSurface {
    private captions = document.createElement('div');
    private caption = document.createElement('span');
    private captionEnglish = document.createElement('span');
    private translations = new Map<string, Translation>();
    private translationScope = '';
    private translationRunning = 0;
    private translationRetryAt = 0;
    private back = document.createElement('button');
    private style = document.createElement('style');
    private annotations = new Map<HTMLElement, Annotation>();
    private dictionary: SaviHoverDictionary;
    private id?: string;
    private active?: SpotifyLine;
    private pointed?: HTMLElement;
    private pointer?: { x: number; y: number };
    private held = false;
    private browsing = false;
    private paused?: { id: string; media: SpotifyMedia; position: number };
    private disposed = false;
    private dictionaryStarted = false;
    private nativeWasVisible = false;

    constructor(
        private snapshot: () => SpotifyReadingSnapshot,
        private select: (cue: SpotifyLine) => void,
        private translate?: TranslateLine
    ) {
        this.dictionary = new SaviHoverDictionary(
            () => null,
            () =>
                this.snapshot()
                    .lines.filter((l) => l.timing === 'timed')
                    .map((l) => ({ text: l.text, start: l.start!, end: l.end!, track: 0 })),
            undefined,
            undefined,
            undefined,
            {
                resolveLine: (target, x, y) => this.resolveLine(target, x, y),
                episodeId: () => this.snapshot().playback.identity?.id,
                // The shared panel handles its own pause/resume; SpotifyMedia
                // validates the Now Playing identity again in the MAIN world.
                playback: () => (this.snapshot().playback.local ? (this.snapshot().playback.media ?? null) : null),
            }
        );
    }
    start() {
        this.captions.dataset.saviSpotifyCaptions = '';
        this.captions.setAttribute('aria-label', 'Savi current caption');
        this.caption.dataset.saviSpotifyCaption = '';
        this.caption.title = 'Hover a word for its meaning. Click for details.';
        this.captionEnglish.dataset.saviSpotifyTranslation = '';
        this.captionEnglish.hidden = true;
        this.captions.append(this.caption, this.captionEnglish);
        this.back.type = 'button';
        this.back.dataset.saviSpotifyFollow = '';
        this.back.textContent = 'Back to current line';
        this.back.hidden = true;
        this.back.onclick = () => {
            this.browsing = false;
            this.active = undefined;
            this.update();
        };
        this.style.textContent = `
            [data-savi-spotify-line]{cursor:text!important}
            [data-savi-spotify-line]:not([data-testid="lyrics-line"]){font-size:18px!important;line-height:1.65!important}
            [data-savi-spotify-line][data-savi-current="true"]{color:#b7f7ce!important;background:#1d5036!important;border-radius:6px;box-shadow:0 0 0 5px #1d5036}
            [data-savi-spotify-captions]{position:fixed;z-index:2147483490;left:50%;transform:translateX(-50%);bottom:108px;width:max-content;max-width:min(760px,calc(100vw - 210px));padding:12px 20px;background:#121a18f5;color:#f5faf7;border:1px solid #ffffff24;border-radius:12px;box-shadow:0 6px 24px #0007;font:500 clamp(20px,2.2vw,28px)/1.6 system-ui;text-align:center;max-height:28vh;overflow:auto;white-space:pre-wrap}
            [data-savi-spotify-caption]{cursor:text}
            [data-savi-spotify-line]:has(+[data-savi-spotify-translation]){padding-bottom:0!important;margin-bottom:0!important}
            [data-savi-spotify-translation]{display:block;font:400 16px/1.5 system-ui;color:#adbdb5;white-space:pre-wrap;margin:6px 0 12px;cursor:default}
            [data-savi-spotify-captions] [data-savi-spotify-translation]{font-size:19px;margin:5px 0 0}
            [data-savi-spotify-translation][hidden]{display:none!important}
            [data-savi-spotify-follow]{position:fixed;bottom:106px;left:50%;transform:translateX(-50%);z-index:2147483500;border:1px solid #ffffff40;border-radius:24px;padding:10px 18px;background:#183d2a;color:#eaffef;font:14px system-ui;cursor:pointer}
            [data-savi-spotify-captions][hidden],[data-savi-spotify-follow][hidden]{display:none!important}
            @media(max-width:600px){[data-savi-spotify-captions]{max-width:calc(100vw - 32px);bottom:150px;font-size:21px}}
        `;
        document.head.append(this.style);
        document.body.append(this.captions, this.back);
        document.addEventListener('mousemove', this.onMove, true);
        document.addEventListener('pointerdown', this.onUserControl, true);
        document.addEventListener('keydown', this.onUserControl, true);
        document.addEventListener('wheel', this.onBrowse, { capture: true, passive: true });
        document.addEventListener('touchmove', this.onBrowse, { capture: true, passive: true });
        window.addEventListener('blur', this.onBlur);
    }
    stop() {
        if (this.disposed) return;
        this.disposed = true;
        this.dictionary.stop();
        this.paused = undefined;
        this.restore();
        this.captions.remove();
        this.back.remove();
        this.style.remove();
        document.removeEventListener('mousemove', this.onMove, true);
        document.removeEventListener('pointerdown', this.onUserControl, true);
        document.removeEventListener('keydown', this.onUserControl, true);
        document.removeEventListener('wheel', this.onBrowse, true);
        document.removeEventListener('touchmove', this.onBrowse, true);
        window.removeEventListener('blur', this.onBlur);
    }
    private resolveLine(target: EventTarget | null, x: number, y: number): HTMLElement | null {
        if (!this.snapshot().visible || this.snapshot().lang.split('-')[0] !== 'ja') return null;
        const el =
            target instanceof Element
                ? target.closest<HTMLElement>('[data-savi-spotify-line],[data-savi-spotify-caption]')
                : null;
        if (!el || (el !== this.caption && !this.annotations.has(el)) || (el === this.caption && this.captions.hidden))
            return null;
        return pointOnSpotifyText(el, x, y) ? el : null;
    }
    private restore(el?: HTMLElement) {
        for (const [node, info] of this.annotations) {
            if (el && el !== node) continue;
            if (info.node && info.node.textContent === info.normalized) info.node.textContent = info.original!;
            node.removeAttribute('data-savi-spotify-line');
            node.removeAttribute('data-savi-current');
            info.english?.remove();
            this.annotations.delete(node);
        }
    }
    private visible(el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect();
        if (
            rect.width <= 0 ||
            rect.height <= 0 ||
            rect.bottom <= 0 ||
            rect.top >= innerHeight ||
            rect.right <= 0 ||
            rect.left >= innerWidth
        )
            return false;
        for (let p: HTMLElement | null = el; p; p = p.parentElement) {
            const css = getComputedStyle(p);
            if (
                p.hidden ||
                p.getAttribute('aria-hidden') === 'true' ||
                css.display === 'none' ||
                css.visibility === 'hidden'
            )
                return false;
            if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
                const r = p.getBoundingClientRect();
                if (rect.bottom <= r.top || rect.top >= r.bottom) return false;
            }
        }
        return true;
    }
    update(pageUrl = location.href) {
        if (this.disposed) return;
        const s = this.snapshot(),
            id = s.playback.identity?.id;
        const scope = this.scope(s);
        if (scope !== this.translationScope) {
            this.translationScope = scope;
            this.translations.clear();
            this.translationRetryAt = 0;
        }
        if (id !== this.id) {
            this.dictionary.stop();
            this.dictionaryStarted = false;
            this.restore();
            this.paused = undefined;
            this.held = false;
            this.pointed = undefined;
            this.active = undefined;
            this.browsing = false;
            this.id = id;
        }
        if (!s.visible || !id) {
            this.dictionary.stop();
            this.dictionaryStarted = false;
            this.restore();
            this.captions.hidden = true;
            this.back.hidden = true;
            this.release();
            this.pointed = undefined;
            this.held = false;
            return;
        }
        if (this.dictionaryStarted && s.lang.split('-')[0] !== 'ja') {
            this.dictionary.stop();
            this.dictionaryStarted = false;
        }
        if (!this.dictionaryStarted && s.lang.split('-')[0] === 'ja') {
            this.dictionary.start();
            this.dictionaryStarted = true;
        }
        const candidates = Array.from(document.querySelectorAll<HTMLElement>(nativeSelector)).filter((el) => {
            // Episode transcript belongs to the page. Lyrics belong to Now Playing.
            return el.matches('[data-testid="lyrics-line"]')
                ? s.playback.identity?.kind === 'track'
                : spotifyIdentity(pageUrl)?.id === id;
        });
        for (const [el, info] of this.annotations) {
            if (
                !candidates.includes(el) ||
                (!info.native && !s.lines.includes(info.cue)) ||
                cleanProviderText(el.textContent ?? '', s.lang) !== info.cue.text
            )
                this.restore(el);
        }
        // Sequential matching keeps repeated short phrases aligned. A virtualized
        // excerpt cannot disambiguate repeated text without provider timestamps.
        const nativeCounts = new Map<string, number>();
        const providerIndices = new Map<string, number[]>();
        s.lines.forEach((line, index) => {
            const indices = providerIndices.get(line.text) ?? [];
            indices.push(index);
            providerIndices.set(line.text, indices);
        });
        for (const el of candidates) {
            const text = cleanProviderText(el.textContent ?? '', s.lang);
            nativeCounts.set(text, (nativeCounts.get(text) ?? 0) + 1);
        }
        // Native timestamps apply to groups. Keep paragraph lookup/translation
        // separate, but highlight and scroll the paragraphs belonging to that group.
        const timedKey = (line: SpotifyLine) => JSON.stringify([line.start, line.end, line.text]);
        const timedLines = new Map(
            s.lines.filter((line) => line.timing === 'timed').map((line) => [timedKey(line), line])
        );
        const nativePlayback = new Map<Element, SpotifyLine>();
        if (spotifyIdentity(pageUrl)?.id === id) {
            for (const entry of readSpotifyTranscriptEntries(document)) {
                const line = timedLines.get(timedKey(entry.line));
                if (line) for (const el of entry.elements) nativePlayback.set(el, line);
            }
        }
        let after = 0;
        for (const el of candidates) {
            const text = cleanProviderText(el.textContent ?? '', s.lang);
            const indices = providerIndices.get(text) ?? [];
            const occurrences = indices.length;
            if (!text) continue;
            const ambiguous = occurrences > 1 && occurrences !== nativeCounts.get(text);
            const index = ambiguous ? undefined : indices.find((i) => i >= after);
            if (index !== undefined) after = index + 1;
            const existing = this.annotations.get(el);
            // Native paragraphs can combine provider cues. They remain readable
            // and translatable without assigning an invented playback interval.
            const cue =
                index !== undefined
                    ? s.lines[index]
                    : existing?.native && existing.cue.text === text
                      ? existing.cue
                      : { text, timing: 'untimed' as const };
            if (existing && existing.node === el.firstChild && existing.node?.textContent === text) {
                existing.cue = cue;
                existing.playbackCue = nativePlayback.get(el);
                existing.native = index === undefined;
                if (existing.english?.previousSibling !== el && existing.english) el.after(existing.english);
                continue;
            }
            if (existing) this.restore(el);
            const info: Annotation = { cue, playbackCue: nativePlayback.get(el), native: index === undefined };
            if (el.childNodes.length === 1 && el.firstChild instanceof Text) {
                info.node = el.firstChild;
                info.original = info.node.textContent ?? '';
                info.normalized = text;
                info.node.textContent = text;
            }
            el.dataset.saviSpotifyLine = '';
            this.annotations.set(el, info);
        }
        const overPopup = !!this.pointer && this.dictionary.isOverHoverSurface(this.pointer.x, this.pointer.y);
        if (
            !this.pointed?.isConnected ||
            (this.pointed === this.caption && this.captions.hidden) ||
            (this.pointer && !pointOnSpotifyText(this.pointed, this.pointer.x, this.pointer.y))
        )
            this.pointed = undefined;
        this.held = !!this.pointed || overPopup;
        if (!this.held) this.release();
        if (
            this.paused &&
            (this.paused.id !== id ||
                this.paused.media !== s.playback.media ||
                Math.abs(this.paused.position - (s.playback.positionMs ?? this.paused.position)) > 1500)
        )
            this.paused = undefined;
        const cue = s.lines.find(
            (l) =>
                l.timing === 'timed' &&
                s.playback.positionMs !== undefined &&
                l.start! <= s.playback.positionMs &&
                s.playback.positionMs < l.end!
        );
        const nativeVisible = Array.from(this.annotations.keys()).some((el) => this.visible(el));
        const moved = cue !== this.active || (nativeVisible && !this.nativeWasVisible);
        this.nativeWasVisible = nativeVisible;
        // Keep the text under the pointer stable, even with hover-pause disabled.
        if (!this.held) {
            this.active = cue;
            for (const [el, info] of this.annotations)
                el.dataset.saviCurrent = String((info.playbackCue ?? info.cue) === cue);
            if (cue && moved && nativeVisible && !this.browsing) this.followNative(cue);
            if (this.caption.textContent !== (cue?.text ?? '')) this.caption.textContent = cue?.text ?? '';
        }
        this.captions.hidden = !this.active || (nativeVisible && this.pointed !== this.caption);
        this.updateEnglish(s);
        this.back.hidden = !this.browsing || !nativeVisible || !cue;
        const player = document.querySelector<HTMLElement>('[data-testid="now-playing-bar"]');
        const top = player?.getBoundingClientRect().top;
        const bottom = top && top > 0 ? Math.max(100, innerHeight - top + 12) : 108;
        this.captions.style.bottom = `${bottom}px`;
        this.back.style.bottom = `${bottom}px`;
    }
    private scope(s: SpotifyReadingSnapshot) {
        return JSON.stringify([s.account, s.playback.identity?.id, s.sourceLang ?? s.lang, s.nativeLanguage]);
    }
    private translationKey(cue: SpotifyLine, s = this.snapshot()) {
        const index = s.lines.indexOf(cue);
        if (index < 0) return JSON.stringify([cue.text]);
        return JSON.stringify([cue.text, s.lines[index - 1]?.text, s.lines[index + 1]?.text]);
    }
    translationFor(cue: SpotifyLine): string | undefined {
        if (this.scope(this.snapshot()) !== this.translationScope) return undefined;
        return this.translations.get(this.translationKey(cue))?.text;
    }
    private updateEnglish(s: SpotifyReadingSnapshot) {
        const targetLang = s.nativeLanguage?.trim() ?? '';
        const sourceLang = (s.sourceLang ?? s.lang).trim();
        const enabled =
            this.translate !== undefined &&
            s.translationEnabled === true &&
            targetLang.length > 0 &&
            targetLang.split('-')[0] !== sourceLang.split('-')[0];
        this.captionEnglish.hidden = !enabled;
        for (const [element, info] of this.annotations) {
            if (!enabled) {
                info.english?.remove();
                info.english = undefined;
            } else if (!info.english) {
                info.english = document.createElement('span');
                info.english.dataset.saviSpotifyTranslation = '';
                element.after(info.english);
            }
            if (info.english) info.english.lang = targetLang;
        }
        if (!enabled || !this.translate) return;
        this.captionEnglish.lang = targetLang;
        const language = translationLanguageLabel(targetLang);
        const label = (cue?: SpotifyLine) => {
            if (!cue) return '';
            if (!s.account) return `Sign in to Savi for ${language} subtitles.`;
            const result = this.translations.get(this.translationKey(cue, s));
            if (result?.text) return result.text;
            return this.translationRetryAt > Date.now()
                ? `${language} translation unavailable. Retrying shortly…`
                : `Translating to ${language}…`;
        };
        const render = (element: HTMLElement, cue?: SpotifyLine) => {
            const text = label(cue);
            if (element.textContent !== text) element.textContent = text;
        };
        for (const info of this.annotations.values()) if (info.english) render(info.english, info.cue);
        render(this.captionEnglish, this.active);
        if (!s.account || !s.playback.identity || !s.visible || !s.lang || this.translationRetryAt > Date.now()) return;
        const current = this.active ? s.lines.indexOf(this.active) : 0;
        const priority = Array.from(
            new Set([
                this.active,
                ...Array.from(this.annotations)
                    .filter(([el]) => this.visible(el))
                    .map(([, info]) => info.cue),
                ...s.lines.slice(Math.max(0, current), Math.max(0, current) + 4),
            ])
        );
        for (const cue of priority) {
            if (this.translationRunning >= 2) break;
            if (!cue) continue;
            const key = this.translationKey(cue, s);
            const cached = this.translations.get(key);
            if (cached && cached.state !== 'failed') continue;
            const index = s.lines.indexOf(cue);
            const context =
                index < 0
                    ? cue.text
                    : s.lines
                          .slice(Math.max(0, index - 1), index + 2)
                          .map((l) => l.text)
                          .join('\n')
                          .slice(0, 8000);
            const scope = this.translationScope;
            this.translations.set(key, { state: 'pending' });
            this.translationRunning++;
            const persistentKey = TRANSLATION_CACHE_PREFIX + JSON.stringify([s.playback.identity.id, targetLang, key]);
            void this._translateOrLoad(persistentKey, cue.text, sourceLang, targetLang, context)
                .then((text) => {
                    if (this.disposed || scope !== this.scope(this.snapshot()) || scope !== this.translationScope)
                        return;
                    if (typeof text !== 'string' || !text.trim() || text.length > 12000)
                        throw Error('Translation unavailable');
                    this.translations.set(key, { state: 'ready', text: text.trim() });
                })
                .catch(() => {
                    if (this.disposed || scope !== this.scope(this.snapshot()) || scope !== this.translationScope)
                        return;
                    this.translations.set(key, { state: 'failed' });
                    this.translationRetryAt = Date.now() + 30000;
                })
                .finally(() => {
                    this.translationRunning--;
                    if (!this.disposed) this.update();
                });
        }
    }
    private async _translateOrLoad(
        persistentKey: string,
        text: string,
        sourceLang: string,
        targetLang: string,
        context: string
    ): Promise<string | undefined> {
        try {
            if (typeof browser !== 'undefined') {
                const stored = (await browser.storage.local.get(persistentKey))[persistentKey] as
                    | { text?: unknown }
                    | undefined;
                if (typeof stored?.text === 'string' && stored.text.trim() && stored.text.length <= 12000) {
                    return stored.text;
                }
            }
        } catch {
            // Storage is an optimization; translation can continue without it.
        }
        const translated = await this.translate?.(text, sourceLang, targetLang, context);
        if (typeof translated === 'string' && translated.trim() && translated.length <= 12000) {
            try {
                if (typeof browser !== 'undefined') {
                    await browser.storage.local.set({ [persistentKey]: { text: translated.trim(), at: Date.now() } });
                }
            } catch {
                // Keep the in-memory result when storage is unavailable/full.
            }
        }
        return translated;
    }
    private followNative(cue: SpotifyLine) {
        const el = Array.from(this.annotations).find(([, info]) => (info.playbackCue ?? info.cue) === cue)?.[0];
        if (!el) return;
        // Scroll Spotify's internal pane, never the document or browser window.
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
                const r = el.getBoundingClientRect(),
                    box = p.getBoundingClientRect();
                p.scrollTop += r.top - box.top - p.clientHeight / 2 + r.height / 2;
                break;
            }
        }
    }
    private onMove = (event: MouseEvent) => {
        this.pointer = { x: event.clientX, y: event.clientY };
        this.pointed = this.resolveLine(event.target, event.clientX, event.clientY) ?? undefined;
        this.held = !!this.pointed || this.dictionary.isOverHoverSurface(event.clientX, event.clientY);
        if (this.pointed) {
            const cue = this.pointed === this.caption ? this.active : this.annotations.get(this.pointed)?.cue;
            if (cue) this.select(cue);
            const s = this.snapshot(),
                p = s.playback;
            if (
                s.pauseOnHoverMode !== PauseOnHoverMode.disabled &&
                !this.paused &&
                p.local &&
                p.playing &&
                p.media &&
                !p.media.paused &&
                p.identity
            ) {
                this.paused = { id: p.identity.id, media: p.media, position: p.positionMs ?? 0 };
                p.media.pause();
            }
        } else if (!this.held) this.release();
    };
    private release() {
        const paused = this.paused;
        this.paused = undefined;
        if (!paused) return;
        const s = this.snapshot(),
            p = s.playback;
        if (
            s.pauseOnHoverMode === PauseOnHoverMode.inAndOut &&
            p.identity?.id === paused.id &&
            p.media === paused.media &&
            p.local &&
            p.media.paused &&
            Math.abs((p.positionMs ?? paused.position) - paused.position) < 1500
        )
            void p.media.play().catch(() => {});
    }
    private onUserControl = (event: Event) => {
        // A deliberate play/pause/seek supersedes our hover pause ownership.
        const playerControl =
            event.target instanceof Element && event.target.closest('[data-testid="now-playing-bar"],audio,video');
        const playbackKey = event instanceof KeyboardEvent && [' ', 'k', 'ArrowLeft', 'ArrowRight'].includes(event.key);
        if (playerControl || playbackKey) {
            this.paused = undefined;
            this.dictionary.cancelPlaybackResume();
        }
        if (
            event instanceof KeyboardEvent &&
            ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
        )
            this.onBrowse(event);
    };
    private onBrowse = (event: Event) => {
        if (
            event.target instanceof Element &&
            event.target.closest('#transcript-panel,[data-testid*="lyrics"],[data-testid*="transcript"]')
        )
            this.browsing = true;
    };
    private onBlur = () => {
        this.pointed = undefined;
        this.pointer = undefined;
        this.paused = undefined;
        this.held = false;
    };
}
