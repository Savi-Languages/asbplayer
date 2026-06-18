// Live-subtitle hover dictionary: hover a word on the video's asbplayer
// subtitle overlay and see (a) the word boxed under the cursor, Language
// Reactor-style, and (b) its dictionary entry in a popup.
//
// asbplayer renders subtitles as plain text for savi users (its own per-word
// tokenization needs the Yomitan-based dictionary pipeline we don't use), so
// we locate the word under the cursor with caretRangeFromPoint + the daemon's
// tokenizer, draw our own outline over that word's DOM range, and show our own
// popup. Daemon calls go through the background (MV3 blocks cross-origin
// fetches from content scripts).

import { SaviDictEntry, SaviKanjiInfo, SaviToken } from './daemon-client';
import {
    SaviCommand,
    SaviDictMessage,
    SaviDictResponse,
    SaviMineLineMessage,
    SaviMineLineResponse,
    SaviTokenizeMessage,
    SaviTokenizeResponse,
} from './messages';
import { deriveEpisodeId } from './episode';
import { friendlySaviError } from './savi-errors';

// The overlay that stacks subtitle lines (the target language AND its
// translation). We never tokenize this whole thing — we resolve the single
// line under the cursor below — but we use it to confirm a [data-track] span is
// actually a subtitle line.
const SUBTITLE_CONTAINER = '.asbplayer-subtitles';
// The embedded dictionary is Japanese; lines without any Japanese (e.g. the
// English translation track) are skipped so we never box or tokenize them.
const LANG = 'ja';
// Hiragana, katakana, CJK (+ Ext. A), compatibility ideographs, halfwidth kana.
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
const HOVER_DEBOUNCE_MS = 0; // fire as good as immediately; tokenize/dict are cached
const TOKENIZE_CACHE_MAX = 64;
const DICT_CACHE_MAX = 300;

/** The token whose `[start, start+len)` range contains `offset`, plus that
 *  span — tokens concatenate back to the line (the daemon emits gap tokens for
 *  any whitespace it would otherwise drop), so a running sum of surface lengths
 *  locates the word under a character offset. Pure — unit-tested without the
 *  DOM. */
export function tokenSpanAtOffset(
    tokens: SaviToken[],
    offset: number
): { token: SaviToken; start: number; end: number } | null {
    let start = 0;
    for (const token of tokens) {
        const end = start + token.text.length;
        if (offset >= start && offset < end) {
            return { token, start, end };
        }
        start = end;
    }
    return null;
}

/** The token under `offset`, or null. Thin wrapper over {@link tokenSpanAtOffset}. */
export function tokenAtOffset(tokens: SaviToken[], offset: number): SaviToken | null {
    return tokenSpanAtOffset(tokens, offset)?.token ?? null;
}

/** The term to look up for a token: its dictionary form (lemma) when the
 *  analyzer supplied one — needed to un-inflect verbs/adjectives (続け → 続ける)
 *  — otherwise its surface. Crucial for the surface fallback: conjunctions,
 *  pronouns, and proper nouns (しかし, そこ, 東京) carry no lemma (they're not
 *  "reportable" content words for bucket coloring) but ARE in the dictionary,
 *  so looking up the surface defines them instead of silently skipping them. */
export function lookupTermFor(token: SaviToken): string {
    return token.lemma ?? token.text;
}

/** A DOM Range covering characters `[start, end)` of `root`'s text, walking
 *  across nested text nodes (asbplayer may wrap a line in inner spans). Null if
 *  the span runs past the available text. Used to box the hovered word. */
export function rangeForCharSpan(root: HTMLElement, start: number, end: number): Range | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let acc = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.textContent?.length ?? 0;
        if (!started && acc + len > start) {
            range.setStart(node, start - acc);
            started = true;
        }
        if (started && acc + len >= end) {
            range.setEnd(node, end - acc);
            return range;
        }
        acc += len;
    }
    return null;
}

const sendToBackground = <R>(message: SaviTokenizeMessage | SaviDictMessage | SaviMineLineMessage): Promise<R> => {
    const command: SaviCommand<SaviTokenizeMessage | SaviDictMessage | SaviMineLineMessage> = {
        sender: 'savi-video',
        message,
    };
    return browser.runtime.sendMessage(command) as Promise<R>;
};

/** The single subtitle line under the event target — the inner text span when
 *  present (Yomitan rich-text path), else the per-track line span — NOT the
 *  container that stacks the line above its translation. Null off a subtitle. */
function lineElement(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) {
        return null;
    }
    const text = target.closest('.asbplayer-subtitle-text');
    if (text instanceof HTMLElement) {
        return text;
    }
    const line = target.closest('[data-track]');
    if (line instanceof HTMLElement && line.closest(SUBTITLE_CONTAINER)) {
        return line;
    }
    return null;
}

/** Char offset of (x,y) within `el`'s text, or null if the caret isn't inside. */
function caretOffsetWithin(el: HTMLElement, x: number, y: number): number | null {
    const range = caretRangeFromPoint(x, y);
    if (!range || !el.contains(range.startContainer)) {
        return null;
    }
    const measure = document.createRange();
    measure.setStart(el, 0);
    try {
        measure.setEnd(range.startContainer, range.startOffset);
    } catch {
        return null;
    }
    return measure.toString().length;
}

function caretRangeFromPoint(x: number, y: number): Range | null {
    const doc = document as unknown as {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof doc.caretRangeFromPoint === 'function') {
        return doc.caretRangeFromPoint(x, y);
    }
    if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(x, y);
        if (!pos) return null;
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        return range;
    }
    return null;
}

const POPUP_BG = '#171b22';
const ARROW_SIZE = 7; // px; the triangle that points from the popup to the word
const POPUP_GAP = 12; // px of clear space between the word and the popup body

const POPUP_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    zIndex: '2147483647',
    maxWidth: '360px',
    background: POPUP_BG,
    color: '#e8eaed',
    border: '1px solid #2a313c',
    borderRadius: '12px',
    padding: '15px 18px',
    boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
    font: '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif',
    pointerEvents: 'auto',
    display: 'none',
};

// A soft gray box that glides between words as the cursor moves, like Language
// Reactor. Non-interactive so it never eats the caret hit-test under it.
const HIGHLIGHT_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    zIndex: '2147483646', // just beneath the popup
    pointerEvents: 'none',
    boxSizing: 'border-box',
    border: '1.5px solid rgba(255, 255, 255, 0.7)',
    borderRadius: '5px',
    background: 'rgba(255, 255, 255, 0.12)',
    transition: 'left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear',
    display: 'none',
};

// The "+ Add to Anki" button at the bottom of the popup. The popup itself is
// interactive (pointer-events:auto) and stays alive while hovered, so the
// button is clickable without the popup vanishing.
const MINE_BTN_STYLE: Partial<CSSStyleDeclaration> = {
    display: 'block',
    width: '100%',
    marginTop: '10px',
    padding: '6px 12px',
    fontSize: '13px',
    fontWeight: '600',
    color: '#171b22',
    background: '#ffd166',
    border: 'none',
    borderRadius: '7px',
    cursor: 'pointer',
};

function renderEntry(
    term: string,
    token: SaviToken,
    entries: SaviDictEntry[],
    kanji: SaviKanjiInfo[],
    onMine: (button: HTMLButtonElement) => void
): HTMLElement {
    const root = document.createElement('div');

    const head = document.createElement('div');
    Object.assign(head.style, { fontSize: '20px', fontWeight: '650', lineHeight: '1.3', marginBottom: '6px' });
    head.textContent = term;
    if (token.reading && token.reading !== term) {
        const reading = document.createElement('span');
        Object.assign(reading.style, {
            fontSize: '13px',
            color: '#4cc2ff',
            marginLeft: '8px',
            fontWeight: '400',
        });
        reading.textContent = token.reading;
        head.appendChild(reading);
    }
    root.appendChild(head);

    for (const entry of entries.slice(0, 2)) {
        const ol = document.createElement('ol');
        Object.assign(ol.style, {
            margin: '4px 0 8px',
            paddingLeft: '18px',
            fontSize: '14px',
            lineHeight: '1.45',
        });
        for (const sense of entry.senses.slice(0, 4)) {
            const li = document.createElement('li');
            li.textContent = sense.glosses.join('; ');
            ol.appendChild(li);
        }
        if (ol.childElementCount > 0) {
            root.appendChild(ol);
        }
    }

    // Kanji breakdown — compact (char + Heisig keyword + components). The full
    // mnemonic story is reserved for the mined card so the popup stays small.
    if (kanji.length > 0) {
        const box = document.createElement('div');
        Object.assign(box.style, {
            marginTop: '6px',
            paddingTop: '6px',
            borderTop: '1px solid #2a313c',
            fontSize: '13px',
            lineHeight: '1.55',
        });
        for (const k of kanji) {
            const row = document.createElement('div');
            const ch = document.createElement('span');
            Object.assign(ch.style, { color: '#ffd166', fontSize: '15px', marginRight: '7px' });
            ch.textContent = k.kanji;
            row.appendChild(ch);
            const kw = document.createElement('span');
            kw.textContent = k.keyword;
            row.appendChild(kw);
            if (k.components && k.components.length > 0) {
                const comp = document.createElement('span');
                Object.assign(comp.style, { color: '#8a93a0', marginLeft: '6px' });
                comp.textContent = `(${k.components.join(', ')})`;
                row.appendChild(comp);
            }
            box.appendChild(row);
        }
        root.appendChild(box);
    }

    const mine = document.createElement('button');
    mine.className = 'savi-mine-btn';
    mine.textContent = '+ Add to Anki';
    Object.assign(mine.style, MINE_BTN_STYLE);
    mine.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        onMine(mine);
    });
    root.appendChild(mine);

    return root;
}

// Anchor the popup to the WORD (not the cursor), centered above it with a clear
// gap, and point the arrow at the word's center. Flips below when there's no
// room above.
function positionPopup(popup: HTMLDivElement, arrow: HTMLDivElement, word: DOMRect) {
    const pr = popup.getBoundingClientRect();
    const margin = 8;
    const wordCenterX = word.left + word.width / 2;

    let left = wordCenterX - pr.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pr.width - margin));

    let top = word.top - pr.height - POPUP_GAP - ARROW_SIZE; // prefer above
    const below = top < margin;
    if (below) {
        top = word.bottom + POPUP_GAP + ARROW_SIZE;
    }

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    // Arrow tracks the word's center even when the popup is clamped to an edge.
    const arrowLeft = Math.max(ARROW_SIZE + 6, Math.min(wordCenterX - left, pr.width - ARROW_SIZE - 6));
    arrow.style.left = `${arrowLeft}px`;
    arrow.style.transform = 'translateX(-50%)';
    if (below) {
        arrow.style.top = `-${ARROW_SIZE}px`;
        arrow.style.bottom = '';
        arrow.style.borderTop = '';
        arrow.style.borderBottom = `${ARROW_SIZE}px solid ${POPUP_BG}`;
    } else {
        arrow.style.bottom = `-${ARROW_SIZE}px`;
        arrow.style.top = '';
        arrow.style.borderBottom = '';
        arrow.style.borderTop = `${ARROW_SIZE}px solid ${POPUP_BG}`;
    }
}

/** Attaches a hover handler over subtitle text: boxes the word under the
 *  cursor and shows a daemon-backed dictionary popup for it. */
export class SaviHoverDictionary {
    private readonly _tokenizeCache = new Map<string, SaviToken[]>();
    private readonly _dictCache = new Map<string, SaviDictResponse>();
    private _popup: HTMLDivElement | null = null;
    private _popupContent: HTMLDivElement | null = null;
    private _arrow: HTMLDivElement | null = null;
    private _highlight: HTMLDivElement | null = null;
    private _cursorLine: HTMLElement | null = null; // line we set cursor:pointer on
    private _currentTerm: string | null = null;
    private _hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private _generation = 0; // bumps to cancel stale async work
    private _bound = false;

    start() {
        if (this._bound) return;
        this._bound = true;
        document.addEventListener('mousemove', this._onMouseMove, true);
    }

    stop() {
        if (!this._bound) return;
        this._bound = false;
        document.removeEventListener('mousemove', this._onMouseMove, true);
        this._clear();
    }

    private _onMouseMove = (event: MouseEvent) => {
        const line = lineElement(event.target);
        if (!line) {
            // Off any subtitle line: keep things up only while the cursor is on
            // the popup itself (so it stays readable); otherwise clear.
            const target = event.target;
            if (this._popup && target instanceof Node && this._popup.contains(target)) {
                return;
            }
            this._clear();
            return;
        }
        const { clientX, clientY } = event;
        clearTimeout(this._hoverTimer);
        this._hoverTimer = setTimeout(() => void this._handleHover(line, clientX, clientY), HOVER_DEBOUNCE_MS);
    };

    private async _handleHover(line: HTMLElement, x: number, y: number) {
        const generation = ++this._generation;
        const text = (line.textContent ?? '').replace(/\s+$/, '');
        const offset = caretOffsetWithin(line, x, y);
        if (offset === null || !text || !JAPANESE.test(text)) {
            this._clear();
            return;
        }
        const tokens = await this._tokenize(text);
        if (generation !== this._generation) {
            return; // a newer hover (or a clear) superseded this one
        }
        const span = tokenSpanAtOffset(tokens, offset);
        if (!span || !JAPANESE.test(span.token.text)) {
            this._clear(); // between words / on whitespace / punctuation
            return;
        }

        // Box the word under the cursor whether or not it resolves to an entry
        // — every word gets the outline, like Language Reactor.
        const range = rangeForCharSpan(line, span.start, span.end);
        const wordRect = range ? range.getBoundingClientRect() : null;
        if (wordRect && (wordRect.width > 0 || wordRect.height > 0)) {
            this._highlightRect(line, wordRect);
        } else {
            this._hideHighlight();
        }

        // Look up the dictionary form — and fall back to the surface so words
        // without a lemma (しかし, そこ, 東京) get defined instead of skipped.
        const term = lookupTermFor(span.token);
        if (term === this._currentTerm) {
            return; // already showing this word's definition
        }
        const result = await this._lookupDict(term);
        if (generation !== this._generation) {
            return;
        }
        // Show the popup when there's anything useful — a definition OR just a
        // kanji breakdown (so even an unknown compound still teaches its kanji).
        if (result.entries.length === 0 && result.kanji.length === 0) {
            this._hidePopup();
            return;
        }
        this._currentTerm = term;
        const popup = this._ensurePopup();
        this._popupContent!.replaceChildren(
            renderEntry(
                term,
                span.token,
                result.entries,
                result.kanji,
                (button) => void this._mine(text, span.token, term, button)
            )
        );
        popup.style.display = 'block';
        // Anchor to the word so the arrow points at it; fall back to the cursor.
        positionPopup(popup, this._arrow!, wordRect ?? new DOMRect(x, y, 0, 0));
    }

    private async _tokenize(text: string): Promise<SaviToken[]> {
        const cached = this._tokenizeCache.get(text);
        if (cached) return cached;
        const res = await sendToBackground<SaviTokenizeResponse>({ command: 'savi-tokenize', lang: LANG, text });
        const tokens = res.tokens ?? [];
        if (this._tokenizeCache.size >= TOKENIZE_CACHE_MAX) {
            const oldest = this._tokenizeCache.keys().next().value;
            if (oldest !== undefined) this._tokenizeCache.delete(oldest);
        }
        this._tokenizeCache.set(text, tokens);
        return tokens;
    }

    /** Mine the hovered line + word into Anki. The daemon derives the episode
     *  from the same platform-stable id the capture used, clips the line's
     *  audio, and writes the note. Feedback lives on the button itself so the
     *  popup stays put. */
    private async _mine(lineText: string, token: SaviToken, term: string, button: HTMLButtonElement) {
        if (button.dataset.saviMined === 'true') {
            return; // already added — don't create a duplicate on a second click
        }
        button.disabled = true;
        button.textContent = 'Adding…';
        try {
            const episodeId = deriveEpisodeId(location.href, document.title);
            const res = await sendToBackground<SaviMineLineResponse>({
                command: 'savi-mine-line',
                episodeId,
                lineText,
                surface: token.text,
                term,
                reading: token.reading,
            });
            if (res.ok) {
                button.dataset.saviMined = 'true';
                button.textContent = res.hadAudio ? '✓ Added (with audio)' : '✓ Added';
                button.style.background = '#3fb950';
                button.style.color = '#fff';
            } else {
                button.disabled = false;
                button.textContent = friendlySaviError(res.errorMessage);
            }
        } catch (e) {
            button.disabled = false;
            button.textContent = 'Failed — click to retry';
        }
    }

    private async _lookupDict(term: string): Promise<SaviDictResponse> {
        const cached = this._dictCache.get(term);
        if (cached) return cached; // re-hovers / common words are instant
        const res = await sendToBackground<SaviDictResponse>({ command: 'savi-dict', lang: LANG, term });
        const result: SaviDictResponse = { entries: res.entries ?? [], kanji: res.kanji ?? [] };
        if (this._dictCache.size >= DICT_CACHE_MAX) {
            const oldest = this._dictCache.keys().next().value;
            if (oldest !== undefined) this._dictCache.delete(oldest);
        }
        this._dictCache.set(term, result);
        return result;
    }

    private _highlightRect(line: HTMLElement, rect: DOMRect) {
        // Japanese cues carry letter-spacing, which the word's rect includes as
        // trailing space on the right — drop it so the box ends at the last
        // glyph instead of reaching into the next word. Small horizontal room,
        // a touch more vertical.
        const trailing = parseFloat(getComputedStyle(line).letterSpacing) || 0;
        const padX = 1;
        const padY = 3;
        const el = this._ensureHighlight();
        el.style.left = `${rect.left - padX}px`;
        el.style.top = `${rect.top - padY}px`;
        el.style.width = `${Math.max(0, rect.width - trailing + padX * 2)}px`;
        el.style.height = `${rect.height + padY * 2}px`;
        el.style.display = 'block';
        // The subtitle container forces cursor:text; signal the word is
        // clickable with a pointer while it's boxed.
        if (this._cursorLine !== line) {
            if (this._cursorLine) this._cursorLine.style.cursor = '';
            line.style.cursor = 'pointer';
            this._cursorLine = line;
        }
    }

    private _clear() {
        this._hidePopup();
        this._hideHighlight();
    }

    private _hidePopup() {
        this._currentTerm = null;
        this._generation++;
        if (this._popup) this._popup.style.display = 'none';
    }

    private _hideHighlight() {
        if (this._highlight) this._highlight.style.display = 'none';
        if (this._cursorLine) {
            this._cursorLine.style.cursor = '';
            this._cursorLine = null;
        }
    }

    private _ensurePopup(): HTMLDivElement {
        if (this._popup) return this._popup;
        const popup = document.createElement('div');
        popup.className = 'savi-dict-popup';
        Object.assign(popup.style, POPUP_STYLE);
        // Keep it alive while the cursor is on the popup itself.
        popup.addEventListener('mouseenter', () => clearTimeout(this._hoverTimer));

        const content = document.createElement('div');
        popup.appendChild(content);

        // Triangle that points from the popup to the word (border colors set in
        // positionPopup depending on whether the popup sits above or below).
        const arrow = document.createElement('div');
        Object.assign(arrow.style, {
            position: 'absolute',
            width: '0',
            height: '0',
            borderLeft: `${ARROW_SIZE}px solid transparent`,
            borderRight: `${ARROW_SIZE}px solid transparent`,
        });
        popup.appendChild(arrow);

        document.body.appendChild(popup);
        this._popup = popup;
        this._popupContent = content;
        this._arrow = arrow;
        return popup;
    }

    private _ensureHighlight(): HTMLDivElement {
        if (this._highlight) return this._highlight;
        const el = document.createElement('div');
        el.className = 'savi-dict-highlight';
        Object.assign(el.style, HIGHLIGHT_STYLE);
        document.body.appendChild(el);
        this._highlight = el;
        return el;
    }
}
