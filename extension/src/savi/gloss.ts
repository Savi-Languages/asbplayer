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

export class SaviGlossController implements GlossProvider {
    private readonly _settings: Pick<SettingsProvider, 'get'>;
    private readonly _onGlossReady: () => void;

    private _enabled = false;
    private _targetLang = '';
    private _glossable = false;
    // lemma → 'known' means "already learned" (skip). Empty when signed out /
    // unfetched → every content word is glossed (SV-12 behaviour).
    private _known: Set<string> = new Set();
    // Final gloss HTML per line ('' = computed, nothing to gloss). Doubles as the
    // in-flight guard (a line is present once compute starts, value filled on done).
    private readonly _lineHtml = new Map<string, string | undefined>();

    constructor(settings: Pick<SettingsProvider, 'get'>, onGlossReady: () => void) {
        this._settings = settings;
        this._onGlossReady = onGlossReady;
    }

    /** Read the enabled flag + target language, then prefetch the known-word set.
     *  Called from the binding's bind(); safe to call again (re-reads). */
    async start(): Promise<void> {
        this._lineHtml.clear();
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
        }
    }

    stop(): void {
        this._lineHtml.clear();
        this._known = new Set();
        this._glossable = false;
    }

    glossHtmlFor(text: string, track?: number): string | undefined {
        if (!this._glossable || (track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return undefined;
        }
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return undefined;
        }
        if (this._lineHtml.has(text)) {
            return this._lineHtml.get(text) || undefined; // '' → undefined → plain text
        }
        // Not seen yet: reserve the slot (in-flight guard) and compute.
        this._lineHtml.set(text, undefined);
        void this._computeLine(text);
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

    private async _computeLine(text: string): Promise<void> {
        const segments = segmentLine(text);
        const lemmas = glossableLemmas(segments, this._known);
        if (lemmas.length === 0) {
            this._lineHtml.set(text, ''); // nothing glossable → stays plain, no re-render
            return;
        }
        // Translate every glossable word in parallel, each with the whole line as
        // context so DeepL resolves the in-sentence sense.
        const entries = await Promise.all(
            lemmas.map(async (lemma) => [lemma, await this._translate(lemma, text)] as const)
        );
        const glosses = new Map<string, string>();
        for (const [lemma, gloss] of entries) {
            if (gloss) {
                glosses.set(lemma, gloss);
            }
        }
        this._lineHtml.set(text, buildGlossHtml(segments, (lemma) => glosses.get(lemma)));
        // Ask the SubtitleController to re-render so the labels appear.
        this._onGlossReady();
    }

    private async _translate(word: string, context: string): Promise<string | undefined> {
        try {
            const response = await sendToBackground<SaviGlossTranslateResponse>({
                command: 'savi-gloss-translate',
                word,
                targetLang: this._targetLang,
                glossLang: GLOSS_LANGUAGE,
                context,
            });
            const gloss = response?.text?.trim();
            return gloss && gloss.length > 0 ? gloss : undefined;
        } catch {
            return undefined;
        }
    }
}
