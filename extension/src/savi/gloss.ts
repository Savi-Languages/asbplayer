// Glossing (SV-12 / SV-13): a small translation label above each not-yet-known
// target-language word in the on-screen subtitles.
//
// asbplayer renders a savi subtitle line as one plain text node. We reuse the
// same ruby engine the furigana feature uses — each glossed word becomes
// `<ruby class="asb-gloss">word<rt>gloss</rt></ruby>` (ruby-position: over, see
// video.css) — by handing that HTML to the SubtitleController as the line's
// `richText`. Nothing here touches the DOM directly; the controller owns render.
//
// The gloss of each word comes from the cloud DeepL proxy WITH the whole line as
// context (banco → "bank" vs "bench"); SV-13 skips words the learner already
// knows (cloud /v2/words/{lang}/buckets). Both cloud calls go through the
// background — MV3 blocks cross-origin fetches from content scripts.
//
// Scope: space-delimited languages only (client-side tokenization; Japanese needs
// the daemon tokenizer and is served by the hover dictionary instead — the two
// are language-disjoint, so gloss ruby never collides with the JA hover path).

import {
    SaviCommand,
    SaviGlossTranslateMessage,
    SaviGlossTranslateResponse,
    SaviWordBucketsMessage,
    SaviWordBucketsResponse,
} from './messages';
import { getCachedRoamingSettings } from './cloud-settings';
import type { WordBucket } from './cloud-client';
import type { SettingsProvider } from '@project/common/settings';

// The language to gloss INTO (the user's known language). English for the two
// dogfooders; a `glossLanguage` roaming setting is a later refinement.
const GLOSS_LANGUAGE = 'en';

// Only the primary subtitle track is glossed — SV-8 auto-loads the target
// language as track 0; a secondary (e.g. English) track is left alone.
const PRIMARY_TRACK = 0;

// Languages whose words are NOT whitespace/letter separable — they need a
// morphological analyzer (the daemon), so client-side glossing skips them. Keyed
// by BCP-47 primary subtag. (Japanese is covered by the hover dictionary.)
const NON_SPACE_DELIMITED = new Set(['ja', 'zh', 'yue', 'wuu', 'ko', 'th', 'lo', 'km', 'my', 'bo']);

// Spanish function words — ported from savi-core's `es` analyzer STOPWORDS so
// SV-12 (before the SV-13 known-word filter kicks in) doesn't gloss el/la/de/que.
// Kept in sync with crates/savi-core/src/analyzer.rs (`mod es`).
const SPANISH_STOPWORDS = new Set<string>([
    'a', 'al', 'algo', 'ante', 'aquel', 'aquella', 'aquello', 'aqui', 'aquí', 'así',
    'aunque', 'bajo', 'bien', 'como', 'cómo', 'con', 'contra', 'cual', 'cuál', 'cuando',
    'cuándo', 'de', 'del', 'desde', 'donde', 'dónde', 'e', 'el', 'él', 'ella', 'ellas',
    'ellos', 'en', 'entre', 'era', 'eran', 'eres', 'es', 'esa', 'ese', 'eso', 'esta',
    'está', 'estaba', 'estamos', 'están', 'estar', 'estas', 'este', 'esto', 'estos',
    'estoy', 'fue', 'fueron', 'ha', 'haber', 'había', 'han', 'has', 'hasta', 'hay',
    'he', 'la', 'las', 'le', 'les', 'lo', 'los', 'más', 'me', 'mi', 'mis', 'muy',
    'ni', 'no', 'nos', 'nosotros', 'nuestra', 'nuestro', 'o', 'os', 'para', 'pero',
    'por', 'porque', 'pues', 'que', 'qué', 'quien', 'quién', 'se', 'según', 'ser',
    'si', 'sí', 'sido', 'sin', 'sobre', 'somos', 'son', 'soy', 'su', 'sus', 'también',
    'tampoco', 'te', 'tras', 'tu', 'tú', 'tus', 'u', 'un', 'una', 'unas', 'unos',
    'usted', 'ustedes', 'vosotros', 'y', 'ya', 'yo',
]);

/** One piece of a subtitle line: a word token or the gap between words. The
 *  pieces concatenate back to the original line exactly. */
export interface GlossSegment {
    /** The exact substring of the line. */
    readonly text: string;
    /** True for a word (a run of Unicode letters), false for gaps/punctuation. */
    readonly word: boolean;
    /** Lowercased surface — the lemma key today (the `es` analyzer lowercases). */
    readonly lemma?: string;
    /** A glossable content word: not a stopword and ≥ 2 letters. */
    readonly content?: boolean;
}

/** Whether `lang` is glossed client-side (space-delimited; not a CJK/Thai-style
 *  script that needs a morphological analyzer). Keyed by BCP-47 primary subtag. */
export function isGlossableLanguage(lang: string): boolean {
    const primary = (lang ?? '').split('-')[0].toLowerCase();
    return primary.length > 0 && !NON_SPACE_DELIMITED.has(primary);
}

/** A content word iff it is not a function word and at least two letters —
 *  mirrors the `es` analyzer's noise policy (used before the SV-13 known filter). */
export function isContentWord(lemma: string): boolean {
    return lemma.length >= 2 && !SPANISH_STOPWORDS.has(lemma);
}

/** Split a line into word/gap segments (offset-preserving; concatenation
 *  reproduces the line). Words are runs of Unicode letters — covers á é í ó ú ü ñ
 *  and any Latin-script language — matching the `es` analyzer's tokenization. */
export function segmentLine(text: string): GlossSegment[] {
    const segments: GlossSegment[] = [];
    const re = /\p{L}+/gu;
    let last = 0;
    for (const match of text.matchAll(re)) {
        const index = match.index ?? 0;
        if (index > last) {
            segments.push({ text: text.slice(last, index), word: false });
        }
        const surface = match[0];
        const lemma = surface.toLowerCase();
        segments.push({ text: surface, word: true, lemma, content: isContentWord(lemma) });
        last = index + surface.length;
    }
    if (last < text.length) {
        segments.push({ text: text.slice(last), word: false });
    }
    return segments;
}

/** The distinct lemmas of a line that are candidates to gloss: content words
 *  whose lemma is not in `known`. Order-preserving, de-duplicated. */
export function glossableLemmas(segments: GlossSegment[], known: ReadonlySet<string>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const seg of segments) {
        if (seg.word && seg.content && seg.lemma && !known.has(seg.lemma) && !seen.has(seg.lemma)) {
            seen.add(seg.lemma);
            out.push(seg.lemma);
        }
    }
    return out;
}

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rebuild the line as HTML, wrapping each glossed word in a ruby whose `<rt>`
 *  carries its translation; everything else is escaped plain text. Returns `''`
 *  when nothing got a gloss (the caller then leaves the line as plain text).
 *  `glossFor(lemma)` returns the translation, or undefined if not (yet) resolved. */
export function buildGlossHtml(
    segments: GlossSegment[],
    glossFor: (lemma: string) => string | undefined
): string {
    let html = '';
    let glossed = false;
    for (const seg of segments) {
        if (seg.word && seg.content && seg.lemma) {
            const gloss = glossFor(seg.lemma);
            if (gloss && gloss.trim().length > 0) {
                html += `<ruby class="asb-gloss">${escapeHtml(seg.text)}<rt>${escapeHtml(gloss)}</rt></ruby>`;
                glossed = true;
                continue;
            }
        }
        html += escapeHtml(seg.text);
    }
    return glossed ? html : '';
}

// ── The controller ────────────────────────────────────────────────────────

const sendToBackground = <R>(message: SaviGlossTranslateMessage | SaviWordBucketsMessage): Promise<R> => {
    const command: SaviCommand<typeof message> = { sender: 'savi-video', message };
    return browser.runtime.sendMessage(command) as Promise<R>;
};

/** What the SubtitleController consumes: the gloss HTML for a line, or undefined
 *  (render it as plain text). Synchronous — it serves an in-memory cache and
 *  kicks off the async translate work, calling `onGlossReady` when a line lands. */
export interface GlossProvider {
    glossHtmlFor(text: string, track?: number): string | undefined;
}

// A subtitle cue, as much as prefetch needs (matches asbplayer's SubtitleModel).
export interface CueLike {
    readonly text: string;
    readonly start: number; // ms
    readonly track?: number;
}

/** Timing/limits for prefetch + retry. Prefetch translates cues starting within
 *  the lookahead window so a label is ready before its cue shows; the concurrency
 *  cap keeps that from becoming a rate-limit storm (which itself caused missing
 *  glosses). A fully-failed line is retried a bounded number of times. */
const PREFETCH_LOOKAHEAD_MS = 12000;
const PREFETCH_MAX_CUES = 8;
const PREFETCH_TICK_MS = 500;
const MAX_LINE_ATTEMPTS = 3;
const MAX_CONCURRENT_TRANSLATIONS = 6;

export interface GlossSources {
    /** The playing media element, for prefetch timing. */
    readonly video?: () => { currentTime: number } | null | undefined;
    /** All loaded cues, for looking ahead of the playhead. */
    readonly subtitles?: () => CueLike[];
}

export class SaviGlossController implements GlossProvider {
    private readonly _settings: Pick<SettingsProvider, 'get'>;
    private readonly _onGlossReady: () => void;
    private readonly _sources: GlossSources;

    private _enabled = false;
    private _targetLang = '';
    private _glossable = false;
    // lemma → 'known' means "already learned" (skip). Empty when signed out /
    // unfetched → every content word is glossed (SV-12 behaviour).
    private _known: Set<string> = new Set();
    // FINAL gloss HTML per line ('' = nothing to gloss). A line is present here
    // only once it has settled (success, empty, or gave-up).
    private _lineHtml = new Map<string, string>();
    // Lines currently being translated (dedup guard, separate from _lineHtml so a
    // retry is possible without a permanent empty entry).
    private _inFlight = new Set<string>();
    // Attempts per line — a fully-failed line retries up to MAX_LINE_ATTEMPTS
    // (transient rate-limit/hiccup) before we give up and settle it as ''.
    private _attempts = new Map<string, number>();
    // (lemma   line) → gloss, so a retry / re-render never re-translates a
    // word that already resolved (only failures are re-attempted).
    private _wordGloss = new Map<string, string>();
    private _prefetchTimer?: ReturnType<typeof setInterval>;
    // Simple concurrency gate over the per-word translate calls.
    private _active = 0;
    private _waiters: Array<{ run: () => void; priority: boolean }> = [];

    constructor(settings: Pick<SettingsProvider, 'get'>, onGlossReady: () => void, sources: GlossSources = {}) {
        this._settings = settings;
        this._onGlossReady = onGlossReady;
        this._sources = sources;
    }

    /** Read the enabled flag + target language, prefetch the known-word set, and
     *  start looking ahead. Called from the binding's bind(); safe to call again. */
    async start(): Promise<void> {
        this._reset();
        try {
            const { saviGlossing } = await this._settings.get(['saviGlossing']);
            this._enabled = saviGlossing;
            const { targetLanguage } = await getCachedRoamingSettings();
            this._targetLang = targetLanguage;
            this._glossable = saviGlossing && targetLanguage.length > 0 && isGlossableLanguage(targetLanguage);
        } catch {
            this._glossable = false;
        }
        if (this._glossable) {
            await this._loadKnown();
            this._prefetchTimer = setInterval(() => this._prefetchTick(), PREFETCH_TICK_MS);
        }
    }

    stop(): void {
        if (this._prefetchTimer !== undefined) {
            clearInterval(this._prefetchTimer);
            this._prefetchTimer = undefined;
        }
        this._reset();
        this._glossable = false;
    }

    private _reset(): void {
        this._lineHtml = new Map();
        this._inFlight = new Set();
        this._attempts = new Map();
        this._wordGloss = new Map();
        this._known = new Set();
    }

    glossHtmlFor(text: string, track?: number): string | undefined {
        if (!this._glossable || (track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return undefined;
        }
        if (text.trim().length === 0) {
            return undefined;
        }
        const settled = this._lineHtml.get(text);
        if (settled !== undefined) {
            return settled || undefined; // '' → undefined → plain text
        }
        // The showing line takes priority in the translate queue.
        this._maybeCompute(text, true);
        return undefined;
    }

    // SV-13: the Known-inclusive buckets for the target language; a lemma marked
    // `known` is skipped. Best-effort — a failure just leaves _known empty.
    private async _loadKnown(): Promise<void> {
        try {
            const response = await sendToBackground<SaviWordBucketsResponse>({
                command: 'savi-word-buckets',
                lang: this._targetLang,
            });
            const buckets = response?.buckets ?? {};
            this._known = new Set(
                Object.entries(buckets)
                    .filter(([, bucket]) => (bucket as WordBucket) === 'known')
                    .map(([lemma]) => lemma)
            );
        } catch {
            this._known = new Set();
        }
    }

    // Translate cues starting within the lookahead window so they're cached before
    // they show (hides the per-word DeepL latency). Runs off a timer; no-ops while
    // paused (the upcoming set is unchanged → already computed).
    private _prefetchTick(): void {
        const video = this._sources.video?.();
        const cues = this._sources.subtitles?.();
        if (!video || !cues) {
            return;
        }
        const nowMs = video.currentTime * 1000;
        const upcoming = cues
            .filter(
                (c) =>
                    (c.track ?? PRIMARY_TRACK) === PRIMARY_TRACK &&
                    c.start > nowMs &&
                    c.start <= nowMs + PREFETCH_LOOKAHEAD_MS &&
                    c.text.trim().length > 0
            )
            .sort((a, b) => a.start - b.start)
            .slice(0, PREFETCH_MAX_CUES);
        for (const cue of upcoming) {
            this._maybeCompute(cue.text, false);
        }
    }

    /** Kick off a line's translation unless it's already settled, in flight, or
     *  has exhausted its retries. `priority` marks the on-screen line. */
    private _maybeCompute(text: string, priority: boolean): void {
        if (this._lineHtml.has(text) || this._inFlight.has(text)) {
            return;
        }
        if ((this._attempts.get(text) ?? 0) >= MAX_LINE_ATTEMPTS) {
            return; // gave up after repeated failures
        }
        void this._computeLine(text, priority);
    }

    private async _computeLine(text: string, priority: boolean): Promise<void> {
        this._inFlight.add(text);
        try {
            const segments = segmentLine(text);
            const lemmas = glossableLemmas(segments, this._known);
            if (lemmas.length === 0) {
                this._lineHtml.set(text, ''); // nothing glossable → settle empty, no retry
                return;
            }
            const entries = await Promise.all(
                lemmas.map(async (lemma) => [lemma, await this._translate(lemma, text, priority)] as const)
            );
            const glosses = new Map<string, string>();
            for (const [lemma, gloss] of entries) {
                if (gloss) {
                    glosses.set(lemma, gloss);
                }
            }
            if (glosses.size === 0) {
                // Every translation failed — almost always transient (rate limit /
                // provider hiccup). Don't settle '' permanently; allow a bounded
                // retry on the next show/prefetch so the labels can still appear.
                const attempts = (this._attempts.get(text) ?? 0) + 1;
                this._attempts.set(text, attempts);
                if (attempts >= MAX_LINE_ATTEMPTS) {
                    this._lineHtml.set(text, ''); // give up → plain text
                }
                return;
            }
            const html = buildGlossHtml(segments, (lemma) => glosses.get(lemma));
            this._lineHtml.set(text, html);
            if (priority && html.length > 0) {
                this._onGlossReady(); // re-render the showing line so labels appear now
            }
        } finally {
            this._inFlight.delete(text);
        }
    }

    private async _translate(word: string, context: string, priority: boolean): Promise<string | undefined> {
        const key = `${word} ${context}`;
        const cached = this._wordGloss.get(key);
        if (cached !== undefined) {
            return cached; // a previously-resolved word never re-hits the network
        }
        await this._acquire(priority);
        try {
            const response = await sendToBackground<SaviGlossTranslateResponse>({
                command: 'savi-gloss-translate',
                word,
                targetLang: this._targetLang,
                glossLang: GLOSS_LANGUAGE,
                context,
            });
            const gloss = response?.text?.trim();
            if (gloss && gloss.length > 0) {
                this._wordGloss.set(key, gloss);
                return gloss;
            }
            return undefined;
        } catch {
            return undefined;
        } finally {
            this._release();
        }
    }

    // Bound the number of concurrent translate calls so prefetch doesn't storm the
    // provider. On-screen (priority) words jump ahead of prefetch in the queue.
    private _acquire(priority: boolean): Promise<void> {
        if (this._active < MAX_CONCURRENT_TRANSLATIONS) {
            this._active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const waiter = {
                run: () => {
                    this._active++;
                    resolve();
                },
                priority,
            };
            if (priority) {
                this._waiters.unshift(waiter);
            } else {
                this._waiters.push(waiter);
            }
        });
    }

    private _release(): void {
        this._active = Math.max(0, this._active - 1);
        const next = this._waiters.shift();
        if (next) {
            next.run();
        }
    }
}
