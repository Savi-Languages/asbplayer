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

import { SaviDictEntry, SaviToken } from './daemon-client';
import { SaviCommand, SaviDictMessage, SaviDictResponse, SaviTokenizeMessage, SaviTokenizeResponse } from './messages';

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
const HOVER_DEBOUNCE_MS = 50;
const TOKENIZE_CACHE_MAX = 64;

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

const sendToBackground = <R>(message: SaviTokenizeMessage | SaviDictMessage): Promise<R> => {
    const command: SaviCommand<SaviTokenizeMessage | SaviDictMessage> = { sender: 'savi-video', message };
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

const POPUP_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    zIndex: '2147483647',
    maxWidth: '360px',
    maxHeight: '40vh',
    overflowY: 'auto',
    background: '#171b22',
    color: '#e8eaed',
    border: '1px solid #2a313c',
    borderRadius: '12px',
    padding: '10px 14px',
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

function renderEntry(term: string, token: SaviToken, entries: SaviDictEntry[]): HTMLElement {
    const root = document.createElement('div');

    const head = document.createElement('div');
    Object.assign(head.style, { fontSize: '20px', fontWeight: '650', marginBottom: '4px' });
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
    return root;
}

function positionPopup(popup: HTMLDivElement, x: number, y: number) {
    const rect = popup.getBoundingClientRect();
    const margin = 8;
    let left = x - rect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    let top = y - rect.height - 14; // prefer above the cursor (subtitles sit low)
    if (top < margin) {
        top = y + 18; // not enough room above → below
    }
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
}

/** Attaches a hover handler over subtitle text: boxes the word under the
 *  cursor and shows a daemon-backed dictionary popup for it. */
export class SaviHoverDictionary {
    private readonly _tokenizeCache = new Map<string, SaviToken[]>();
    private _popup: HTMLDivElement | null = null;
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
        if (!span || !span.token.text.trim()) {
            this._clear(); // between words / on whitespace
            return;
        }

        // Box the word under the cursor whether or not it resolves to an entry
        // — every word gets the outline, like Language Reactor.
        const range = rangeForCharSpan(line, span.start, span.end);
        if (range) {
            this._highlightRange(line, range);
        } else {
            this._hideHighlight();
        }

        const term = span.token.lemma; // only content words carry a lemma
        if (!term) {
            this._hidePopup(); // function word: keep the box, drop the definition
            return;
        }
        if (term === this._currentTerm) {
            return; // already showing this word's definition
        }
        const res = await sendToBackground<SaviDictResponse>({ command: 'savi-dict', lang: LANG, term });
        if (generation !== this._generation) {
            return;
        }
        if (!res.entries || res.entries.length === 0) {
            this._hidePopup();
            return;
        }
        this._currentTerm = term;
        const popup = this._ensurePopup();
        popup.replaceChildren(renderEntry(term, span.token, res.entries));
        popup.style.display = 'block';
        positionPopup(popup, x, y);
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

    private _highlightRange(line: HTMLElement, range: Range) {
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            this._hideHighlight();
            return;
        }
        const pad = 2;
        const el = this._ensureHighlight();
        el.style.left = `${rect.left - pad}px`;
        el.style.top = `${rect.top - pad}px`;
        el.style.width = `${rect.width + pad * 2}px`;
        el.style.height = `${rect.height + pad * 2}px`;
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
        document.body.appendChild(popup);
        this._popup = popup;
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
