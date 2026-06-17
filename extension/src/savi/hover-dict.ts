// Live-subtitle hover dictionary: hover a word on the video's asbplayer
// subtitle overlay and see its dictionary entry in a popup.
//
// asbplayer renders subtitles as plain text for savi users (its own per-word
// tokenization needs the Yomitan-based dictionary pipeline we don't use), so
// we locate the word under the cursor with caretRangeFromPoint + the daemon's
// tokenizer, then draw our own popup. Daemon calls go through the background
// (MV3 blocks cross-origin fetches from content scripts).

import { SaviDictEntry, SaviToken } from './daemon-client';
import { SaviCommand, SaviDictMessage, SaviDictResponse, SaviTokenizeMessage, SaviTokenizeResponse } from './messages';

const SUBTITLE_SELECTOR = '.asbplayer-subtitles';
// The embedded dictionary is Japanese; other languages tokenize to nothing
// usable and simply show no popup.
const LANG = 'ja';
const HOVER_DEBOUNCE_MS = 50;
const TOKENIZE_CACHE_MAX = 64;

/**
 * The token whose `[start, start+len)` range contains `offset`, or null. Tokens
 * concatenate back to the line, so a running sum of surface lengths locates the
 * word under a character offset. Pure — unit-tested without the DOM.
 */
export function tokenAtOffset(tokens: SaviToken[], offset: number): SaviToken | null {
    let start = 0;
    for (const token of tokens) {
        const end = start + token.text.length;
        if (offset >= start && offset < end) {
            return token;
        }
        start = end;
    }
    return null;
}

const sendToBackground = <R>(message: SaviTokenizeMessage | SaviDictMessage): Promise<R> => {
    const command: SaviCommand<SaviTokenizeMessage | SaviDictMessage> = { sender: 'savi-video', message };
    return browser.runtime.sendMessage(command) as Promise<R>;
};

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

function position(popup: HTMLDivElement, x: number, y: number) {
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

/** Attaches a hover handler over subtitle text and shows a daemon-backed
 *  dictionary popup for the word under the cursor. */
export class SaviHoverDictionary {
    private readonly _tokenizeCache = new Map<string, SaviToken[]>();
    private _popup: HTMLDivElement | null = null;
    private _currentTerm: string | null = null;
    private _hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private _generation = 0; // bumps to cancel stale async lookups
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
        this._hide();
    }

    private _onMouseMove = (event: MouseEvent) => {
        const target = event.target;
        const subtitle = target instanceof Element ? target.closest(SUBTITLE_SELECTOR) : null;
        if (!(subtitle instanceof HTMLElement)) {
            // Off the subtitle: drop the popup unless the cursor is on it.
            if (this._popup && !(target instanceof Node && this._popup.contains(target))) {
                this._hide();
            }
            return;
        }
        const { clientX, clientY } = event;
        clearTimeout(this._hoverTimer);
        this._hoverTimer = setTimeout(() => void this._handleHover(subtitle, clientX, clientY), HOVER_DEBOUNCE_MS);
    };

    private async _handleHover(subtitle: HTMLElement, x: number, y: number) {
        const offset = caretOffsetWithin(subtitle, x, y);
        const text = (subtitle.textContent ?? '').replace(/\s+$/, '');
        if (offset === null || !text) {
            this._hide();
            return;
        }
        const tokens = await this._tokenize(text);
        const token = tokenAtOffset(tokens, offset);
        const term = token?.lemma; // only content words carry a lemma
        if (!term || !token) {
            this._hide();
            return;
        }
        if (term === this._currentTerm) {
            return; // already showing this word
        }
        const generation = ++this._generation;
        const res = await sendToBackground<SaviDictResponse>({ command: 'savi-dict', lang: LANG, term });
        if (generation !== this._generation) {
            return; // a newer hover superseded this lookup
        }
        if (!res.entries || res.entries.length === 0) {
            this._hide();
            return;
        }
        this._currentTerm = term;
        const popup = this._ensurePopup();
        popup.replaceChildren(renderEntry(term, token, res.entries));
        popup.style.display = 'block';
        position(popup, x, y);
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

    private _hide() {
        this._currentTerm = null;
        this._generation++;
        if (this._popup) this._popup.style.display = 'none';
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
}
