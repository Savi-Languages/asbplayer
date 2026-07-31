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
    GlossedWordEntry,
    SaviCommand,
    SaviGlossLineMessage,
    SaviGlossLineResponse,
    SaviGlossTranslateMessage,
    SaviGlossTranslateResponse,
} from './messages';
import { getCachedRoamingSettings } from './cloud-settings';
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

// Spanish STRUCTURAL function words — ported from savi-core's `es` analyzer
// STOPWORDS so SV-12 (before the SV-13 known-word filter kicks in) doesn't
// gloss el/la/de/que. Kept in sync with crates/savi-core/src/analyzer.rs
// (`mod es`); this set must never be NARROWER than savi-core's, or we gloss a
// word that can never enter review.
//
// Nine words were removed from both lists after the founder found `más`
// unglossable AND absent from the word list: más, bien, muy, también, tampoco,
// algo, así, aunque, según. They are lexical items a beginner must learn, not
// grammatical glue, and they self-resolve — once known, proficiency ≥ the
// gloss threshold suppresses the label, which is the scheduler's job rather
// than a hardcoded list's.
const SPANISH_STOPWORDS = new Set<string>([
    'a', 'al', 'ante', 'aquel', 'aquella', 'aquello', 'aqui', 'aquí',
    'bajo', 'como', 'cómo', 'con', 'contra', 'cual', 'cuál', 'cuando',
    'cuándo', 'de', 'del', 'desde', 'donde', 'dónde', 'e', 'el', 'él', 'ella', 'ellas',
    'ellos', 'en', 'entre', 'era', 'eran', 'eres', 'es', 'esa', 'ese', 'eso', 'esta',
    'está', 'estaba', 'estamos', 'están', 'estar', 'estas', 'este', 'esto', 'estos',
    'estoy', 'fue', 'fueron', 'ha', 'haber', 'había', 'han', 'has', 'hasta', 'hay',
    'he', 'la', 'las', 'le', 'les', 'lo', 'los', 'me', 'mi', 'mis',
    'ni', 'no', 'nos', 'nosotros', 'nuestra', 'nuestro', 'o', 'os', 'para', 'pero',
    'por', 'porque', 'pues', 'que', 'qué', 'quien', 'quién', 'se', 'ser',
    'si', 'sí', 'sido', 'sin', 'sobre', 'somos', 'son', 'soy', 'su', 'sus',
    'te', 'tras', 'tu', 'tú', 'tus', 'u', 'un', 'una', 'unas', 'unos',
    'usted', 'ustedes', 'vosotros', 'y', 'ya', 'yo',
]);

// Conjugations whose LEMMA is a function word (ser/estar/haber/…), which the
// surface list above cannot see.
//
// This closes a real hole the founder asked about: savi-core drops a token when
// its *lemma* is a stopword, so "seré" and "estuvieron" never become encounters
// and can never enter review — but they are not in the surface list, so the
// extension glossed them anyway. The result was a word labelled on screen
// forever with no path to ever learning it, since the SV-13 known-word filter
// reads proficiency 0 for a word that is not in the deck at all.
//
// Generated from crates/savi-core/data/lemmatization-es.txt ∩ the analyzer's
// STOPWORDS. Only forms whose EVERY lemma is a function word are listed:
// "fuimos" maps to both `ir` (a real verb) and `ser`, so it stays glossable —
// dropping it would hide a word the learner genuinely can review.
//
// ("voy" → `ir` is NOT here, and correctly so: it is reviewable.)
const SPANISH_AUXILIARY_FORMS = new Set<string>([
    'aes', 'aquellas', 'aquellos', 'aquél', 'aquélla', 'aquéllas', 'aquéllos', 'asina',
    'asín', 'bajos', 'bienes', 'contras', 'cuales', 'cuáles', 'ello', 'erais', 'esas',
    'esos', 'estabais', 'estaban', 'estabas', 'estad', 'estada', 'estadas', 'estado',
    'estando', 'estaremos', 'estará', 'estarán', 'estarás', 'estaré', 'estaréis', 'estaría',
    'estaríais', 'estaríamos', 'estarían', 'estarías', 'estemos', 'estes', 'estuve',
    'estuviera', 'estuvierais', 'estuvieran', 'estuvieras', 'estuviere', 'estuviereis',
    'estuvieren', 'estuvieres', 'estuvieron', 'estuviese', 'estuvieseis', 'estuviesen',
    'estuvieses', 'estuvimos', 'estuviste', 'estuvisteis', 'estuviéramos', 'estuviéremos',
    'estuviésemos', 'estuvo', 'estábamos', 'estáis', 'estás', 'esté', 'estéis', 'estén',
    'estés', 'haberes', 'habida', 'habidas', 'habido', 'habidos', 'habiendo', 'habremos',
    'habrá', 'habrán', 'habrás', 'habré', 'habréis', 'habría', 'habríais', 'habríamos',
    'habrían', 'habrías', 'habéis', 'habíais', 'habíamos', 'habían', 'habías', 'haya',
    'hayamos', 'hayan', 'hayáis', 'hube', 'hubiera', 'hubierais', 'hubieran', 'hubieras',
    'hubiere', 'hubiereis', 'hubieren', 'hubieres', 'hubieron', 'hubiese', 'hubieseis',
    'hubiesen', 'hubieses', 'hubimos', 'hubiste', 'hubisteis', 'hubiéramos', 'hubiéremos',
    'hubiésemos', 'hubo', 'noes', 'nosotras', 'nuestras', 'nuestros', 'oes', 'peros',
    'quienes', 'quiénes', 'sea', 'seamos', 'sean', 'seas', 'sed', 'seremos', 'seres',
    'será', 'serán', 'serás', 'seré', 'seréis', 'sería', 'seríais', 'seríamos', 'serían',
    'serías', 'seáis', 'siendo', 'sis', 'sois', 'sones', 'sons', 'síes', 'vos', 'vosotras',
    'éramos', 'ésa', 'ésas', 'ése', 'ésos', 'ésta', 'éstas', 'éste', 'éstos', 'úes',
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
    /** A glossable content word: not a stopword, ≥ 2 letters, not a proper noun. */
    readonly content?: boolean;
    /** A likely proper noun (capitalized, not at a sentence start) — never glossed. */
    readonly properNoun?: boolean;
}

/** Whether `lang` is glossed client-side (space-delimited; not a CJK/Thai-style
 *  script that needs a morphological analyzer). Keyed by BCP-47 primary subtag. */
export function isGlossableLanguage(lang: string): boolean {
    const primary = (lang ?? '').split('-')[0].toLowerCase();
    return primary.length > 0 && !NON_SPACE_DELIMITED.has(primary);
}

/** A content word iff it is not a function word and at least two letters —
 *  mirrors the `es` analyzer's noise policy (used before the SV-13 known filter).
 *
 *  Both lists matter: the surface stoplist catches `de`/`que`, and the
 *  auxiliary list catches conjugations like `seré` whose LEMMA is a function
 *  word. Without the second, savi-core would refuse to make them encounters
 *  while this kept labelling them — glossed forever, never reviewable. */
export function isContentWord(lemma: string): boolean {
    return (
        lemma.length >= 2 && !SPANISH_STOPWORDS.has(lemma) && !SPANISH_AUXILIARY_FORMS.has(lemma)
    );
}

// After one of these, the next capitalized word starts a new sentence (so it is
// an ordinary word, not a proper noun). Includes Spanish inverted marks.
const SENTENCE_BOUNDARY = /[.!?…:;¿¡\n]/;

/** True if `surface` begins with an uppercase letter (accent-aware). */
export function startsUppercase(surface: string): boolean {
    return /^\p{Lu}/u.test(surface);
}

/** Split a line into word/gap segments (offset-preserving; concatenation
 *  reproduces the line). Words are runs of Unicode letters — covers á é í ó ú ü ñ
 *  and any Latin-script language — matching the `es` analyzer's tokenization.
 *  A capitalized word that is NOT at a sentence start is flagged a proper noun
 *  (Spanish/Romance capitalize proper nouns, not common nouns) so names like
 *  "Elena" or "Madrid" aren't glossed; sentence-initial capitals stay ordinary. */
export function segmentLine(text: string): GlossSegment[] {
    const segments: GlossSegment[] = [];
    const re = /\p{L}+/gu;
    let last = 0;
    let atSentenceStart = true; // the first word of the line is sentence-initial
    for (const match of text.matchAll(re)) {
        const index = match.index ?? 0;
        if (index > last) {
            const gap = text.slice(last, index);
            segments.push({ text: gap, word: false });
            if (SENTENCE_BOUNDARY.test(gap)) {
                atSentenceStart = true;
            }
        }
        const surface = match[0];
        const lemma = surface.toLowerCase();
        const properNoun = !atSentenceStart && startsUppercase(surface);
        const content = isContentWord(lemma) && !properNoun;
        segments.push({ text: surface, word: true, lemma, content, properNoun });
        atSentenceStart = false;
        last = index + surface.length;
    }
    if (last < text.length) {
        segments.push({ text: text.slice(last), word: false });
    }
    return segments;
}

/** One word's verdict from `POST /v2/gloss` — the server lemmatized it and
 *  decided. `skip` absent ⇒ render `gloss` above it. */
export interface GlossDecision {
    /** The surface we sent, echoed back (lowercased on our side). */
    readonly word: string;
    /** The dictionary form it resolved to — server-side truth, unavailable here. */
    readonly lemma?: string;
    readonly skip?: 'known' | 'function-word' | 'untokenized';
    readonly proficiency?: number;
    readonly gloss?: string;
}

/** The surfaces of a line worth asking the server about: content words, in
 *  order, de-duplicated, lowercased.
 *
 *  This is a cheap PRE-filter, not the decision — the server makes that, and it
 *  is the only side that can, since it owns the lemmatizer. All this avoids is
 *  shipping punctuation, one-letter tokens, obvious structural words and
 *  proper nouns across the wire. Being too generous here costs a little
 *  payload; being too STRICT silently un-glosses a word forever, so when in
 *  doubt, send it. */
export function glossCandidates(segments: GlossSegment[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const seg of segments) {
        if (seg.word && seg.content && seg.lemma && !seen.has(seg.lemma)) {
            seen.add(seg.lemma);
            out.push(seg.lemma);
        }
    }
    return out;
}

/** Why a line's words were skipped, as counts BY REASON — never word by word.
 *
 *  The candidates are exactly the line's content words, so listing them would
 *  reconstruct what the user is watching. Hard constraint #2 tiers transcript
 *  text separately from aggregates and keeps snippets independently
 *  toggleable; a debug log that emits them by default sits on the wrong side
 *  of that line, however local the console feels.
 *
 *  Counts answer the only question the log exists to answer — "was this line
 *  suppressed, or is the pipeline broken?" — and carry no content. Exported so
 *  the property is TESTED rather than asserted in a comment (the first version
 *  of this logged every word while its commit message claimed it did not). */
export function skipSummary(decisions: readonly GlossDecision[]): string {
    const byReason = new Map<string, number>();
    for (const d of decisions) {
        if (d.skip) {
            byReason.set(d.skip, (byReason.get(d.skip) ?? 0) + 1);
        }
    }
    return [...byReason].map(([reason, count]) => `${reason}: ${count}`).join(', ');
}

/** Fold a `/v2/gloss` response into the surface → label map [`buildGlossHtml`]
 *  wants. Skipped words are absent (no label), as are rambling labels — an LLM
 *  fallback that returns a paragraph of senses must not be painted over a word. */
export function labelsFrom(decisions: readonly GlossDecision[]): Map<string, string> {
    const labels = new Map<string, string>();
    for (const d of decisions) {
        if (d.skip) {
            continue;
        }
        const gloss = d.gloss?.trim();
        if (gloss && isReasonableGloss(gloss)) {
            labels.set(d.word.toLowerCase(), gloss);
        }
    }
    return labels;
}

/** The distinct lemmas of a line that are candidates to gloss: content words
 *  whose lemma is not in `known`. Order-preserving, de-duplicated.
 *
 *  @deprecated SV-40 — the known-set filter moved to the server, because THIS
 *  is where the bug lived: `known` is keyed by real lemmas but `seg.lemma` is a
 *  lowercased surface, so `sabía` never matched a known `saber` and stayed
 *  labelled forever. Use [`glossCandidates`] + `POST /v2/gloss`. */
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

/** Undo `escapeHtml` on extracted `<rt>` label text (labels may legitimately
 *  contain &, <, etc. after DeepL — they were escaped at render time). */
const unescapeHtml = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The words a settled gloss-HTML line actually wraps in gloss ruby, each with
 *  the LABEL it displays (SV-20: the daemon persists the label so the reviewer
 *  can key sense pairs off it) — the exact render truth. Safe to extract with a
 *  pattern because WE generated the markup and word segments are pure letter
 *  runs (no entities possible inside them). De-duplicated by word. */
export function glossedEntriesFromHtml(html: string): GlossedWordEntry[] {
    const out: GlossedWordEntry[] = [];
    const seen = new Set<string>();
    for (const match of html.matchAll(/<ruby class="asb-gloss">([^<]+)<rt>([^<]*)<\/rt>/g)) {
        const word = match[1].toLowerCase();
        if (!seen.has(word)) {
            seen.add(word);
            out.push({ word, gloss: unescapeHtml(match[2]).trim() });
        }
    }
    return out;
}

/** The lowercased glossed words only (legacy shape — see
 *  [`glossedEntriesFromHtml`] for the labeled SV-20 form). */
export function glossedLemmasFromHtml(html: string): string[] {
    return glossedEntriesFromHtml(html).map((e) => e.word);
}

// A gloss LABEL must be short — a word or a short phrase. A long, sentence-like
// response is a misbehaving LLM fallback (rambling about senses/alternatives),
// not a usable label; the caller drops it rather than render a paragraph.
const MAX_GLOSS_CHARS = 60;
const MAX_GLOSS_WORDS = 8;

/** Whether `gloss` is short enough to be a usable label (vs. an LLM ramble). */
export function isReasonableGloss(gloss: string): boolean {
    const trimmed = gloss.trim();
    return (
        trimmed.length > 0 &&
        trimmed.length <= MAX_GLOSS_CHARS &&
        trimmed.split(/\s+/).filter(Boolean).length <= MAX_GLOSS_WORDS
    );
}

// ── The controller ────────────────────────────────────────────────────────

const sendToBackground = <R>(
    message: SaviGlossLineMessage | SaviGlossTranslateMessage
): Promise<R> => {
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
 *  cap AND the min dispatch interval keep that from becoming a rate-limit storm
 *  (which caused DeepL to fall through to the LLM chain and 429). A fully-failed
 *  line is retried a bounded number of times. */
const PREFETCH_LOOKAHEAD_MS = 10000;
const PREFETCH_MAX_CUES = 6;
const PREFETCH_TICK_MS = 500;
const MAX_LINE_ATTEMPTS = 3;
const MAX_CONCURRENT_TRANSLATIONS = 4;
// Space successive translate dispatches so bursts stay under provider rate limits
// (~500 requests/min at 120ms). Cache hits and already-settled lines don't dispatch.
// PRIORITY calls (the on-screen line, hover) skip this gate — it exists to tame
// prefetch bursts, and a cumulative FIFO gate would make user-facing calls wait
// behind the whole prefetch backlog.
const MIN_DISPATCH_INTERVAL_MS = 120;
// Hard ceiling on one translate round-trip. Without it, a hung background request
// (an MV3 worker restart, a fetch that never settles) leaks a concurrency slot
// FOREVER — four leaks and all glossing starves for the rest of the page session.
const TRANSLATE_TIMEOUT_MS = 10000;

/** `promise`, or a rejection after `ms` — so a hung await can't hold resources
 *  forever. The underlying work may still settle later; its result is discarded. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
    ]);

export interface GlossSources {
    /** The playing media element, for prefetch timing. */
    readonly video?: () => { currentTime: number } | null | undefined;
    /** All loaded cues, for looking ahead of the playhead. */
    readonly subtitles?: () => CueLike[];
}

export class SaviGlossController implements GlossProvider {
    private readonly _settings: Pick<SettingsProvider, 'get'>;
    private readonly _onGlossReady: (text: string) => void;
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
    // Rate gate: the earliest time the next dispatch may start (min-interval spacing).
    private _nextDispatchMs = 0;

    /** Why a line got no labels.
     *
     *  EVERY reason glossing produces nothing looks identical on screen —
     *  plain subtitles, no error. Track mismatch, no candidate words, a failed
     *  call, and "you already know every word here" are indistinguishable, and
     *  the last one is the common case, so a genuinely broken pipeline reads as
     *  normal operation. That is the same shape as the fallback that hid the
     *  surface-vs-lemma bug for so long, and it cost three rounds of
     *  archaeology to re-learn.
     *
     *  Filter the service-worker console on `savi: gloss` to see the reason.
     *  (The line's own text is deliberately not logged — it is the user's
     *  viewing history.) */
    private _why(reason: string): void {
        console.debug(`savi: gloss — ${reason}`);
    }

    constructor(
        settings: Pick<SettingsProvider, 'get'>,
        onGlossReady: (text: string) => void,
        sources: GlossSources = {}
    ) {
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
            if (!this._glossable) {
                this._why(
                    `off — saviGlossing=${saviGlossing}, targetLanguage=${JSON.stringify(targetLanguage)}`
                );
            }
        } catch {
            this._glossable = false;
        }
        if (this._glossable) {
            // SV-40: nothing to preload. The known-set fetch is gone — every
            // decision now comes back with its line, which also means the first
            // labels no longer wait on a whole-history projection.
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
        if (!this._glossable) {
            return undefined; // already explained once, at start()
        }
        if ((track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            // Only the target-language track is glossed. Worth saying out loud:
            // hover glossing has NO track gate, so a subtitle in another slot
            // gives working hover and dead inline labels — which reads as a
            // broken feature rather than a configuration.
            this._why(`skipped — track ${track} is not the primary track`);
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

    /** Whether glossing is active for the current language (enabled + a
     *  space-delimited target language). On-demand hover glossing gates on this. */
    get glossable(): boolean {
        return this._glossable;
    }

    /** The lowercased words of `text` currently DISPLAYED with a gloss label
     *  (from the settled line HTML — exact render truth). Empty when the line
     *  hasn't settled yet, nothing was glossed, glossing is off, or the track
     *  isn't the primary one. The encounter reporter samples this at
     *  line-start; a gloss landing later counts as bare exposure, which
     *  matches what the user saw at that moment. */
    glossedLemmasFor(text: string, track?: number): string[] {
        if (!this._glossable || (track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return [];
        }
        const settled = this._lineHtml.get(text);
        return settled ? glossedLemmasFromHtml(settled) : [];
    }

    /** Like [`glossedLemmasFor`] but each word carries the LABEL it displays
     *  (SV-20) — what the encounter reporter sends so the daemon can persist
     *  the shown translation on the encounter. */
    glossedEntriesFor(text: string, track?: number): GlossedWordEntry[] {
        if (!this._glossable || (track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return [];
        }
        const settled = this._lineHtml.get(text);
        return settled ? glossedEntriesFromHtml(settled) : [];
    }

    /** The target (learning) language, for the hover module's context. */
    get targetLang(): string {
        return this._targetLang;
    }

    /** Translate ONE word (including one the learner already knows) for on-demand
     *  hover glossing — reuses the always-on per-word cache + rate gate, so a word
     *  already translated for a line resolves instantly. */
    async glossForHover(word: string, lineText: string): Promise<string | undefined> {
        if (!this._glossable) {
            return undefined;
        }
        return this._translate(word.toLowerCase(), lineText, true);
    }

    // (SV-40 removed `_loadKnown`. It fetched every known LEMMA once per bind
    // and filtered locally by lowercased SURFACE — a comparison that could
    // never match a conjugation, so `sabía` stayed labelled no matter how well
    // the learner knew `saber`. The decision now travels with each line, made
    // by the only party that owns a lemmatizer. See `_glossLine`.)

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
            const candidates = glossCandidates(segments);
            if (candidates.length === 0) {
                this._why('no candidates — every word was punctuation, a function word, or a name');
                this._lineHtml.set(text, ''); // nothing to ask about → settle empty, no retry
                return;
            }
            // ONE round trip for the whole line: the server lemmatizes, decides
            // against the learner's proficiency, and labels the survivors.
            const glosses = await this._glossLine(text, candidates, priority);
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
            // Re-render whenever a gloss resolves — not just for the on-screen line:
            // a prefetch that lands while its cue is only upcoming must still
            // invalidate that cue's (plain) cached HTML so its labels show when it
            // appears. notifyGlossReady invalidates by this exact text.
            if (html.length > 0) {
                this._onGlossReady(text);
            }
        } finally {
            this._inFlight.delete(text);
        }
    }

    /** Ask the cloud to decide + label one line. Returns surface → label for
     *  the words that should be glossed; empty when the call failed (the caller
     *  then retries a bounded number of times, then settles plain).
     *
     *  A failure must NOT fall back to "gloss every candidate". The old client
     *  did exactly that when its known-set fetch failed, and combined with the
     *  surface-vs-lemma bug the fallback was indistinguishable from working
     *  normally — which is a large part of why this shipped unnoticed. */
    private async _glossLine(
        line: string,
        words: string[],
        priority: boolean
    ): Promise<Map<string, string>> {
        const cached = words
            .map((w) => [w, this._wordGloss.get(`${w} ${line}`)] as const)
            .filter(([, g]) => g !== undefined) as [string, string][];
        if (cached.length === words.length) {
            return new Map(cached); // fully served from the per-line cache
        }
        if (!priority) {
            await this._rateGate();
        }
        await this._acquire(priority);
        try {
            const response = await withTimeout(
                sendToBackground<SaviGlossLineResponse>({
                    command: 'savi-gloss-line',
                    lang: this._targetLang,
                    glossLang: GLOSS_LANGUAGE,
                    line,
                    words,
                }),
                TRANSLATE_TIMEOUT_MS
            );
            if (!response?.words) {
                // Signed out, cloud unreachable, or a deployment predating
                // /v2/gloss. Distinct from "you know these words" — that case
                // returns decisions, all skipped.
                this._why(`call returned no decisions for ${words.length} word(s)`);
                return new Map();
            }
            // The common, healthy reason for a bare line: the learner already
            // knows every word on it. Said explicitly so it can never again be
            // confused with a broken pipeline.
            //
            // Counted BY REASON, never word by word. The candidates are exactly
            // the line's content words, so listing them would reconstruct what
            // the user is watching — the transcript-snippet tier that hard
            // constraint #2 keeps independently toggleable rather than emitting
            // by default. "known: 4" answers the diagnostic question ("was it
            // suppressed or broken?") without carrying any of the content.
            const skipped = response.words.filter((w) => w.skip);
            if (skipped.length === response.words.length) {
                this._why(`all ${skipped.length} word(s) skipped — ${skipSummary(response.words)}`);
            }
            const labels = labelsFrom(response.words);
            for (const [word, gloss] of labels) {
                this._wordGloss.set(`${word} ${line}`, gloss);
            }
            return labels;
        } catch {
            return new Map();
        } finally {
            this._release();
        }
    }

    private async _translate(word: string, context: string, priority: boolean): Promise<string | undefined> {
        const key = `${word} ${context}`;
        const cached = this._wordGloss.get(key);
        if (cached !== undefined) {
            return cached; // a previously-resolved word never re-hits the network
        }
        if (!priority) {
            await this._rateGate(); // prefetch only — user-facing calls must not queue behind it
        }
        await this._acquire(priority);
        try {
            const response = await withTimeout(
                sendToBackground<SaviGlossTranslateResponse>({
                    command: 'savi-gloss-translate',
                    word,
                    targetLang: this._targetLang,
                    glossLang: GLOSS_LANGUAGE,
                    context,
                }),
                TRANSLATE_TIMEOUT_MS
            );
            const gloss = response?.text?.trim();
            // Keep it only if it's a plausible LABEL — drop an LLM ramble (a
            // paragraph of senses/alternatives) rather than render it over a word.
            if (gloss && isReasonableGloss(gloss)) {
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

    // Space successive dispatches so bursts stay under provider rate limits.
    private _rateGate(): Promise<void> {
        const now = Date.now();
        const at = Math.max(now, this._nextDispatchMs);
        this._nextDispatchMs = at + MIN_DISPATCH_INTERVAL_MS;
        const wait = at - now;
        return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
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
