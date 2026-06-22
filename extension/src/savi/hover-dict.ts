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
    SaviCaptureFrameMessage,
    SaviCaptureFrameResponse,
    SaviCommand,
    SaviDictMessage,
    SaviDictResponse,
    SaviEpisodeTranscriptMessage,
    SaviEpisodeTranscriptResponse,
    SaviMineLineMessage,
    SaviMineLineResponse,
    SaviSegmentLineMessage,
    SaviSegmentLineResponse,
    SaviTokenizeMessage,
    SaviTokenizeResponse,
} from './messages';
import { serializeToSrt, SerializableSubtitle } from './subtitle-serializer';
import { deriveEpisodeId } from './episode';
import { SaviSegmentPanel } from './segment-panel';
import { friendlySaviError } from './savi-errors';
import { cropAndResize } from '@project/common/src/image-transformer';

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
const SHOT_MAX_WIDTH = 960; // cap the mined card's screenshot width (height scales)
// Grace period before hiding once the cursor leaves the subtitle line, so the
// visible gap between the word and the popup can be crossed to click a button.
const HIDE_GRACE_MS = 250;
const TOKENIZE_CACHE_MAX = 64;
const DICT_CACHE_MAX = 300;
// Wait this long before showing the "AI in-context definition" loading caption.
// A cached segmentation resolves well under this, so re-hovers never flash it.
const AI_LOADER_DELAY_MS = 140;

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

type SaviVideoMessage =
    | SaviTokenizeMessage
    | SaviSegmentLineMessage
    | SaviDictMessage
    | SaviMineLineMessage
    | SaviEpisodeTranscriptMessage
    | SaviCaptureFrameMessage;

const sendToBackground = <R>(message: SaviVideoMessage): Promise<R> => {
    const command: SaviCommand<SaviVideoMessage> = { sender: 'savi-video', message };
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

// Secondary button — opens the whole-line AI breakdown panel.
const BREAKDOWN_BTN_STYLE: Partial<CSSStyleDeclaration> = {
    display: 'block',
    width: '100%',
    marginTop: '6px',
    padding: '5px 12px',
    fontSize: '12.5px',
    fontWeight: '600',
    color: '#cfd6df',
    background: 'transparent',
    border: '1px solid #3a424e',
    borderRadius: '7px',
    cursor: 'pointer',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A tiny SMIL-animated spinner — no CSS/keyframes dependency, animates in any DOM. */
function aiSpinner(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.style.flex = '0 0 auto';

    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', '12');
    track.setAttribute('cy', '12');
    track.setAttribute('r', '9');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'currentColor');
    track.setAttribute('stroke-width', '3');
    track.setAttribute('stroke-opacity', '0.25');

    const arc = document.createElementNS(SVG_NS, 'path');
    arc.setAttribute('d', 'M12 3 a9 9 0 0 1 9 9');
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'currentColor');
    arc.setAttribute('stroke-width', '3');
    arc.setAttribute('stroke-linecap', 'round');

    const spin = document.createElementNS(SVG_NS, 'animateTransform');
    spin.setAttribute('attributeName', 'transform');
    spin.setAttribute('attributeType', 'XML');
    spin.setAttribute('type', 'rotate');
    spin.setAttribute('from', '0 12 12');
    spin.setAttribute('to', '360 12 12');
    spin.setAttribute('dur', '0.7s');
    spin.setAttribute('repeatCount', 'indefinite');
    arc.appendChild(spin);

    svg.appendChild(track);
    svg.appendChild(arc);
    return svg;
}

/** The "AI in-context definition" block shown above the dictionary senses. Three
 *  states: loading (spinner while the daemon segments the line), ready (the
 *  contextual gloss · grammar for THIS sentence), or absent (rule-based fallback). */
function aiContextCaption(loading: boolean, token: SaviToken): HTMLElement | null {
    const hasGloss = Boolean(token.gloss || token.grammar);
    if (!loading && !hasGloss) {
        return null; // pure rule-based — no AI line at all
    }
    const box = document.createElement('div');
    box.className = 'savi-ai-caption';
    Object.assign(box.style, { margin: '0 0 7px', lineHeight: '1.4' });

    const label = document.createElement('div');
    Object.assign(label.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '10px',
        fontWeight: '700',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: '#74c79a',
        marginBottom: '3px',
    });
    const spark = document.createElement('span');
    spark.textContent = '✦';
    label.appendChild(spark);
    const labelText = document.createElement('span');
    labelText.textContent = 'AI in-context definition';
    label.appendChild(labelText);
    box.appendChild(label);

    const body = document.createElement('div');
    if (loading) {
        Object.assign(body.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: '#93a0ad',
            fontStyle: 'italic',
        });
        body.appendChild(aiSpinner());
        const t = document.createElement('span');
        t.textContent = 'reading the sentence…';
        body.appendChild(t);
    } else {
        Object.assign(body.style, { fontSize: '12.5px', color: '#9fd1a0' });
        body.textContent = `▸ ${[token.gloss, token.grammar].filter(Boolean).join(' · ')}`;
    }
    box.appendChild(body);
    return box;
}

function renderEntry(
    term: string,
    token: SaviToken,
    entries: SaviDictEntry[],
    kanji: SaviKanjiInfo[],
    loading: boolean,
    onMine: (button: HTMLButtonElement) => void,
    onBreakdown: () => void
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

    // AI in-context definition — a labeled block that shows a spinner while the
    // daemon segments the line, then the contextual gloss · grammar for THIS
    // sentence (でも → "but/however"). Absent on rule-based fallback.
    const caption = aiContextCaption(loading, token);
    if (caption) {
        root.appendChild(caption);
    }

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
    const trigger = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        onMine(mine);
    };
    // pointerdown fires on press, so it survives the cursor dragging off the
    // button before release (which cancels a `click`). `click` stays as a
    // fallback (keyboard/non-pointer); the in-flight guard prevents a double.
    mine.addEventListener('pointerdown', trigger);
    mine.addEventListener('click', trigger);
    root.appendChild(mine);

    // "Breakdown" — opens the whole-line AI segmentation panel.
    const breakdown = document.createElement('button');
    breakdown.textContent = '🔍 Breakdown';
    Object.assign(breakdown.style, BREAKDOWN_BTN_STYLE);
    const bdTrigger = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        onBreakdown();
    };
    breakdown.addEventListener('pointerdown', bdTrigger);
    breakdown.addEventListener('click', bdTrigger);
    root.appendChild(breakdown);

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
    // null = the daemon returned no AI segmentation for this line → use rule-based.
    private readonly _segmentCache = new Map<string, SaviToken[] | null>();
    private _segmentPanel: SaviSegmentPanel | null = null;
    private readonly _dictCache = new Map<string, SaviDictResponse>();
    private _popup: HTMLDivElement | null = null;
    private _popupContent: HTMLDivElement | null = null;
    private _arrow: HTMLDivElement | null = null;
    private _highlight: HTMLDivElement | null = null;
    private _bridge: HTMLDivElement | null = null; // transparent gap-cover from word up to popup
    private _toastEl: HTMLDivElement | null = null; // standalone mine-result toast (outlives the popup)
    private _toastTimer: number | null = null;
    private _cursorLine: HTMLElement | null = null; // line we set cursor:pointer on
    private _currentTerm: string | null = null;
    private _currentLoading = false; // the popup is showing the AI "thinking" caption
    private _hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private _hideTimer: ReturnType<typeof setTimeout> | undefined; // delayed hide, cancellable
    private _generation = 0; // bumps to cancel stale async work
    private _bound = false;

    // Episodes whose full transcript we've already uploaded this session, so we
    // send it at most once per episode (it's the whole subtitle file).
    private readonly _transcriptSentFor = new Set<string>();

    /** @param _videoProvider returns the bound media element, so a mined card
     *  can screenshot the current frame. Defaults to none (no screenshot). */
    constructor(
        private readonly _videoProvider: () => HTMLMediaElement | null = () => null,
        private readonly _subtitleProvider: () => SerializableSubtitle[] = () => []
    ) {}

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
        this._segmentPanel?.destroy();
        this._segmentPanel = null;
    }

    /** True when (x, y) is over savi's own hover surfaces — the dictionary popup
     *  or the transparent word→popup bridge. The binding uses this to keep the
     *  video paused while the cursor moves from a subtitle word onto the popup
     *  (so reaching "+ Add to Anki" doesn't resume playback). */
    isOverHoverSurface(x: number, y: number): boolean {
        const el = document.elementFromPoint(x, y);
        if (!(el instanceof Node)) return false;
        return (!!this._popup && this._popup.contains(el)) || (!!this._bridge && this._bridge.contains(el));
    }

    private _onMouseMove = (event: MouseEvent) => {
        const line = lineElement(event.target);
        if (!line) {
            const target = event.target;
            const onPopup = !!this._popup && target instanceof Node && this._popup.contains(target);
            const onBridge = target === this._bridge;
            if (onPopup || onBridge) {
                // On the popup, or the invisible bridge spanning the gap up to it
                // — keep things up so the buttons stay reachable. Travelling the
                // bridge is what stops the OTHER subtitle line (which sits in that
                // gap for a bottom-line word) from stealing the hover.
                this._cancelHide();
                return;
            }
            // Off the line and not on the popup/bridge: give the cursor a beat to
            // reach the popup before hiding.
            this._scheduleHide();
            return;
        }
        // Back on a subtitle line — cancel any pending hide.
        this._cancelHide();
        const { clientX, clientY } = event;
        clearTimeout(this._hoverTimer);
        this._hoverTimer = setTimeout(() => void this._handleHover(line, clientX, clientY), HOVER_DEBOUNCE_MS);
    };

    private _scheduleHide() {
        if (this._hideTimer !== undefined) return; // already counting down
        this._hideTimer = setTimeout(() => {
            this._hideTimer = undefined;
            this._clear();
        }, HIDE_GRACE_MS);
    }

    private _cancelHide() {
        if (this._hideTimer !== undefined) {
            clearTimeout(this._hideTimer);
            this._hideTimer = undefined;
        }
    }

    private async _handleHover(line: HTMLElement, x: number, y: number) {
        const generation = ++this._generation;
        const text = (line.textContent ?? '').replace(/\s+$/, '');
        const offset = caretOffsetWithin(line, x, y);
        if (offset === null || !text || !JAPANESE.test(text)) {
            this._clear();
            return;
        }
        // Render instantly with the rule-based tokens — no added latency.
        const tokens = await this._tokenize(text);
        if (generation !== this._generation) {
            return; // a newer hover (or a clear) superseded this one
        }
        await this._applyTokens(line, text, offset, x, y, tokens, generation, false, false);

        // Progressive upgrade: ask the daemon for an AI segmentation (cached after
        // the first hover of a line). When it lands and this hover is still current,
        // re-box + re-resolve with the context-aware chunks (でも → "but", not で).
        // While that call is in flight — and only if it's slow enough to notice (a
        // cache hit settles first) — show the labeled "AI thinking" caption.
        let settled = false;
        const loaderTimer = setTimeout(() => {
            if (!settled && generation === this._generation) {
                void this._applyTokens(line, text, offset, x, y, tokens, generation, false, true);
            }
        }, AI_LOADER_DELAY_MS);
        this._segment(text)
            .then((aiTokens) => {
                settled = true;
                clearTimeout(loaderTimer);
                if (generation !== this._generation) {
                    return;
                }
                if (aiTokens) {
                    void this._applyTokens(line, text, offset, x, y, aiTokens, generation, true, false);
                } else {
                    // No AI upgrade (fallback / no provider) — drop the loader if shown.
                    void this._applyTokens(line, text, offset, x, y, tokens, generation, false, false);
                }
            })
            .catch(() => {
                settled = true;
                clearTimeout(loaderTimer);
                if (generation === this._generation) {
                    void this._applyTokens(line, text, offset, x, y, tokens, generation, false, false);
                }
            });
    }

    /** Box the token at `offset` and show its popup. `ai` forces a re-render even
     *  when the term is unchanged (so the AI upgrade can add the contextual gloss),
     *  and never clears the existing render if the AI mapping lands oddly. */
    private async _applyTokens(
        line: HTMLElement,
        text: string,
        offset: number,
        x: number,
        y: number,
        tokens: SaviToken[],
        generation: number,
        ai: boolean,
        loading: boolean
    ) {
        const span = tokenSpanAtOffset(tokens, offset);
        if (!span || !JAPANESE.test(span.token.text)) {
            if (!ai && !loading) {
                this._clear(); // between words / on whitespace / punctuation
            }
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

        // Look up the dictionary form — fall back to the surface so words without
        // a lemma (しかし, そこ, 東京) get defined instead of skipped.
        const term = lookupTermFor(span.token);
        if (!ai && !loading && term === this._currentTerm && !this._currentLoading) {
            return; // already showing this word's definition in the same state
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
        this._currentLoading = loading;
        const popup = this._ensurePopup();
        this._popupContent!.replaceChildren(
            renderEntry(
                term,
                span.token,
                result.entries,
                result.kanji,
                loading,
                (button) => void this._mine(text, span.token, term, button),
                () => void this._openBreakdown(text)
            )
        );
        popup.style.display = 'block';
        // Anchor to the word so the arrow points at it; fall back to the cursor.
        const anchor = wordRect ?? new DOMRect(x, y, 0, 0);
        positionPopup(popup, this._arrow!, anchor);
        // Lay the invisible bridge over the gap so the path to the popup never
        // crosses (and triggers) the other subtitle line.
        this._positionBridge(anchor);
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

    /** AI segmentation for a line (cached). `null` when the daemon falls back to
     *  rule-based (feature off / no provider / offline / a split that wouldn't
     *  reconcile) — the caller then keeps the rule-based render. */
    private async _segment(text: string): Promise<SaviToken[] | null> {
        const cached = this._segmentCache.get(text);
        if (cached !== undefined) {
            return cached;
        }
        const { prevLines, nextLines } = this._neighborsOf(text);
        const res = await sendToBackground<SaviSegmentLineResponse>({
            command: 'savi-segment-line',
            lang: LANG,
            text,
            prevLines,
            nextLines,
            episodeId: deriveEpisodeId(location.href, document.title),
        });
        const tokens = res.ai && res.tokens.length > 0 ? res.tokens : null;
        if (this._segmentCache.size >= TOKENIZE_CACHE_MAX) {
            const oldest = this._segmentCache.keys().next().value;
            if (oldest !== undefined) this._segmentCache.delete(oldest);
        }
        this._segmentCache.set(text, tokens);
        return tokens;
    }

    /** The ±2 subtitle lines around `text` (best-effort), for segmentation context. */
    private _neighborsOf(text: string): { prevLines: string[]; nextLines: string[] } {
        const subs = this._subtitleProvider();
        const idx = subs.findIndex((s) => (s.text ?? '').replace(/\s+$/, '') === text);
        if (idx < 0) {
            return { prevLines: [], nextLines: [] };
        }
        return {
            prevLines: subs.slice(Math.max(0, idx - 2), idx).map((s) => s.text),
            nextLines: subs.slice(idx + 1, idx + 3).map((s) => s.text),
        };
    }

    /** Open the whole-line breakdown panel (AI chunks, else rule-based tokens). */
    private async _openBreakdown(text: string) {
        const aiTokens = await this._segment(text).catch(() => null);
        const tokens = aiTokens ?? (await this._tokenize(text));
        this._ensureSegmentPanel().show(text, tokens);
    }

    private _ensureSegmentPanel(): SaviSegmentPanel {
        if (!this._segmentPanel) {
            this._segmentPanel = new SaviSegmentPanel();
        }
        return this._segmentPanel;
    }

    /** Mine the hovered line + word into Anki. The daemon derives the episode
     *  from the same platform-stable id the capture used, clips the line's
     *  audio, and writes the note. Feedback lives on the button itself so the
     *  popup stays put. */
    private async _mine(lineText: string, token: SaviToken, term: string, button: HTMLButtonElement) {
        if (button.disabled || button.dataset.saviMined === 'true') {
            return; // mine in flight or already added — don't double-fire
        }
        button.disabled = true;
        button.textContent = 'Adding…';
        try {
            const episodeId = deriveEpisodeId(location.href, document.title);
            // Make sure the daemon has the whole-episode transcript (once per
            // episode) so the card's scene-level context gets an episode gist,
            // even on an episode the user never recorded. Best-effort, awaited so
            // the FIRST mine of an episode already benefits.
            await this._maybeSendTranscript(episodeId);
            const imageBase64 = await this._captureScreenshot();
            const res = await sendToBackground<SaviMineLineResponse>({
                command: 'savi-mine-line',
                episodeId,
                lineText,
                surface: token.text,
                term,
                reading: token.reading,
                imageBase64,
            });
            if (res.ok) {
                button.dataset.saviMined = 'true';
                // Two pieces can silently miss and leave a thinner card: the line's
                // audio (mined at the bleeding edge of a live recording, before its
                // audio is captured) and the AI enrichment — pitch, meaning, and the
                // in-context lenses (every provider failed, or none configured, so the
                // card falls back to dictionary-only). Call either out explicitly so
                // the user knows to re-mine. `enriched === false` is a strict check:
                // an older daemon omits the field, so we don't cry wolf.
                const gaps: string[] = [];
                if (!res.hadAudio) gaps.push('no audio');
                if (res.enriched === false) gaps.push('no AI details');
                const degraded = gaps.length > 0;
                const suffix = degraded ? ` (${gaps.join(', ')})` : '';
                button.textContent = `✓ Added${suffix}`;
                button.style.background = degraded ? '#b8860b' : '#3fb950';
                button.style.color = '#fff';
                // The mine can take seconds (AI enrichment), by which point the
                // cursor has often moved on and the popup closed — so confirm with
                // a standalone toast that doesn't depend on the button still showing.
                // Amber when something's missing, so the gap is noticed.
                this._toast(`✓ Added to Anki${suffix}`, degraded ? 'warn' : 'success');
            } else {
                button.disabled = false;
                const msg = friendlySaviError(res.errorMessage);
                button.textContent = msg;
                this._toast(`✗ ${msg}`, 'error');
            }
        } catch (e) {
            button.disabled = false;
            button.textContent = 'Failed — click to retry';
            this._toast('✗ Couldn’t reach savi — try again', 'error');
        }
    }

    /** Send the episode's FULL subtitle track to the daemon once per episode, so
     *  the card's scene-level context can draw on a whole-episode gist — even on
     *  an episode the user only hover-mines and never records. Best-effort: a
     *  failure (or subtitles not yet loaded) leaves it to retry on the next mine,
     *  and never blocks mining. */
    private async _maybeSendTranscript(episodeId: string): Promise<void> {
        if (this._transcriptSentFor.has(episodeId)) {
            return;
        }
        const subtitles = this._subtitleProvider();
        if (subtitles.length === 0) {
            return; // track not loaded yet — try again on the next mine
        }
        this._transcriptSentFor.add(episodeId); // optimistic — avoid duplicate uploads
        try {
            await sendToBackground<SaviEpisodeTranscriptResponse>({
                command: 'savi-episode-transcript',
                episodeId,
                subtitles: serializeToSrt(subtitles),
                subtitleFormat: 'srt',
            });
        } catch (e) {
            this._transcriptSentFor.delete(episodeId); // let a later mine retry
        }
    }

    /** A base64 JPEG of the current video frame cropped to the player, or
     *  undefined when there's no video or capture fails — the screenshot is a
     *  bonus, never a blocker for the mine. */
    private async _captureScreenshot(): Promise<string | undefined> {
        const video = this._videoProvider();
        if (!video) return undefined;
        const rect = video.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return undefined;
        // Hide savi's own overlays (popup, highlight, bridge) so they're not in
        // the captured frame, and wait a paint before the background grabs it.
        const restore = this._hideForCapture();
        try {
            await new Promise((r) => requestAnimationFrame(() => r(null)));
            const res = await sendToBackground<SaviCaptureFrameResponse>({ command: 'savi-capture-frame' });
            if (!res?.dataUrl) return undefined;
            const cropped = await cropAndResize(
                SHOT_MAX_WIDTH,
                0,
                { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                res.dataUrl
            );
            return cropped.substring(cropped.indexOf(',') + 1); // strip the data: prefix
        } catch (e) {
            return undefined;
        } finally {
            restore();
        }
    }

    /** Hide the popup / highlight / bridge for a clean screenshot; returns a
     *  restore fn. Uses `visibility` (no reflow) so positions are preserved. */
    private _hideForCapture(): () => void {
        const els = [this._popup, this._highlight, this._bridge].filter(
            (e): e is HTMLDivElement => e !== null
        );
        const prev = els.map((e) => e.style.visibility);
        els.forEach((e) => {
            e.style.visibility = 'hidden';
        });
        return () => els.forEach((e, i) => (e.style.visibility = prev[i] ?? ''));
    }

    /** A standalone success/error toast, independent of the hover popup, so the
     *  mine result is visible even after the cursor moved on and the popup closed.
     *  Green for success, red for failure; auto-dismisses (errors linger longer). */
    private _toast(message: string, kind: 'success' | 'warn' | 'error') {
        const el = this._ensureToast();
        el.textContent = message;
        const [bg, border] =
            kind === 'success'
                ? ['#1f7a33', '#3fb950']
                : kind === 'warn'
                  ? ['#7a5b16', '#d9a441']
                  : ['#b3261e', '#f85149'];
        el.style.background = bg;
        el.style.borderColor = border;
        el.style.opacity = '1';
        el.style.transform = 'translateX(-50%) translateY(0)';
        if (this._toastTimer !== null) {
            clearTimeout(this._toastTimer);
        }
        // Success auto-dismisses quickly; warn/error linger so they get noticed.
        this._toastTimer = window.setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(-50%) translateY(-8px)';
        }, kind === 'success' ? 2600 : 4200);
    }

    private _ensureToast(): HTMLDivElement {
        if (this._toastEl) return this._toastEl;
        const el = document.createElement('div');
        el.className = 'savi-toast';
        Object.assign(el.style, {
            position: 'fixed',
            left: '50%',
            top: '48px',
            transform: 'translateX(-50%) translateY(-8px)',
            zIndex: '2147483647',
            padding: '10px 16px',
            borderRadius: '10px',
            border: '1px solid',
            color: '#fff',
            font: '600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
            pointerEvents: 'none',
            opacity: '0',
            transition: 'opacity .18s ease, transform .18s ease',
            maxWidth: '80vw',
            textAlign: 'center',
        });
        document.body.appendChild(el);
        this._toastEl = el;
        return el;
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
        this._cancelHide();
        this._hidePopup();
        this._hideHighlight();
    }

    private _hidePopup() {
        this._currentTerm = null;
        this._currentLoading = false;
        this._generation++;
        if (this._popup) this._popup.style.display = 'none';
        if (this._bridge) this._bridge.style.display = 'none';
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
        popup.addEventListener('mouseenter', () => {
            clearTimeout(this._hoverTimer);
            this._cancelHide();
        });

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

    private _ensureBridge(): HTMLDivElement {
        if (this._bridge) return this._bridge;
        const el = document.createElement('div');
        el.className = 'savi-dict-bridge';
        Object.assign(el.style, {
            position: 'fixed',
            zIndex: '2147483646', // just below the popup, above the subtitles
            pointerEvents: 'auto',
            background: 'transparent',
            display: 'none',
        });
        document.body.appendChild(el);
        this._bridge = el;
        return el;
    }

    // Cover the gap between the hovered word and its popup with a transparent,
    // interactive strip. The cursor travels over this on its way to the popup,
    // and `_onMouseMove` treats the bridge as "on the popup" — so reaching the
    // buttons never crosses the OTHER subtitle line that sits in that gap for a
    // bottom-line word. Geometry-driven, so it needs no hover timing.
    private _positionBridge(word: DOMRect) {
        const popup = this._popup;
        const bridge = this._ensureBridge();
        if (!popup) return;
        const pr = popup.getBoundingClientRect();
        const left = Math.min(word.left, pr.left);
        const right = Math.max(word.right, pr.right);
        let top: number;
        let height: number;
        if (pr.top >= word.bottom) {
            top = word.bottom; // popup sits below the word
            height = pr.top - word.bottom;
        } else {
            top = pr.bottom; // popup sits above the word (the usual case)
            height = word.top - pr.bottom;
        }
        const pad = 2; // overlap the word + popup so there's no 1px dead seam
        bridge.style.left = `${left}px`;
        bridge.style.top = `${top - pad}px`;
        bridge.style.width = `${Math.max(0, right - left)}px`;
        bridge.style.height = `${Math.max(0, height) + pad * 2}px`;
        bridge.style.display = 'block';
    }
}
