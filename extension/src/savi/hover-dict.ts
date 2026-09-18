import { subtitleTokens } from './token-cache';
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

import { SaviDictEntry, SaviKanjiFull, SaviKanjiInfo, SaviToken } from './daemon-client';
import { headwordReading } from './headword';
import {
    Box,
    boxBottom,
    boxRight,
    HitPad,
    highlightBoxes,
    popupAnchor,
    textExtent,
    TokenSpan,
    boxesEqual,
    fragmentBoxes,
    tokenSpanAtOffset,
    tokenSpanAtPoint,
} from './hit-test';
// The offset-based helpers live in hit-test.ts now; still exported from here
// for their existing importers.
export { rangeForCharSpan, tokenAtOffset, tokenSpanAtOffset } from './hit-test';
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
    SaviExplainWordMessage,
    SaviExplainWordResponse,
    SaviKanjiMessage,
    SaviKanjiResponse,
    SaviTokenizeMessage,
    SaviTokenizeResponse,
    SaviAiUnavailable,
} from './messages';
import { serializeToSrt, SerializableSubtitle } from './subtitle-serializer';
import { deriveEpisodeId } from './episode';
import { SaviWordPanel, WordContext } from './word-panel';
import { friendlySaviError } from './savi-errors';
import { cropAndResize } from '@project/common/src/image-transformer';
import { hostOverlay } from '@/services/top-layer';

// The overlay that stacks subtitle lines (the target language AND its
// translation). We never tokenize this whole thing — we resolve the single
// line under the cursor below — but we use it to confirm a [data-track] span is
// actually a subtitle line. The overlay uses a DIFFERENT content class in
// fullscreen ('asbplayer-fullscreen-subtitles', see subtitle-controller's
// _elementOverlayParams) — both must match, or hover dies the moment the
// player goes fullscreen (it did).
/** The subtitle containers a line can live in. Exported so gloss-hover can
 *  ENUMERATE lines when hit-testing cannot find them (SV-44). */
export const SUBTITLE_CONTAINER = '.asbplayer-subtitles, .asbplayer-fullscreen-subtitles';
// The embedded dictionary is Japanese; lines without any Japanese (e.g. the
// English translation track) are skipped so we never box or tokenize them.
const LANG = 'ja';
// Hiragana, katakana, CJK (+ Ext. A), compatibility ideographs, halfwidth kana.
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
const SHOT_MAX_WIDTH = 960; // cap the mined card's screenshot width (height scales)
// Grace period before hiding once the cursor leaves the subtitle line, so the
// visible gap between the word and the popup can be crossed to click a button.
const HIDE_GRACE_MS = 250;
const TOKENIZE_CACHE_MAX = 64;
const DICT_CACHE_MAX = 300;

/** The term to look up for a token: its dictionary form (lemma) when the
 *  analyzer supplied one — needed to un-inflect verbs/adjectives (続け → 続ける)
 *  — otherwise its surface. Crucial for the surface fallback: conjunctions,
 *  pronouns, and proper nouns (しかし, そこ, 東京) carry no lemma (they're not
 *  "reportable" content words for bucket coloring) but ARE in the dictionary,
 *  so looking up the surface defines them instead of silently skipping them. */
export function lookupTermFor(token: SaviToken): string {
    return token.lemma ?? token.text;
}

type SaviVideoMessage =
    | SaviTokenizeMessage
    | SaviSegmentLineMessage
    | SaviExplainWordMessage
    | SaviKanjiMessage
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
 *  container that stacks the line above its translation. Null off a subtitle.
 *  Exported so the Spanish gloss-hover module can reuse the same line detection. */
export function lineElement(target: EventTarget | null): HTMLElement | null {
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

export function caretRangeFromPoint(x: number, y: number): Range | null {
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
const POPUP_MIN_GAP = 48; // leave the neighboring text row accessible

const POPUP_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    zIndex: '2147483647',
    maxWidth: '360px',
    background: POPUP_BG,
    color: '#e8eaed',
    border: '1px solid #2a313c',
    borderRadius: '14px',
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
    padding: '0', // inline, so the popover UA padding never applies in the top layer
    border: '1.5px solid rgba(76, 194, 255, 0.8)',
    borderRadius: '5px',
    background: 'rgba(76, 194, 255, 0.14)',
    transition: 'left 60ms linear, top 60ms linear, width 60ms linear, height 60ms linear',
    display: 'none',
};

// What lifting an overlay into the top layer must not take away: the popover
// UA reset drops an overlay's own border (see hostOverlay).
const POPUP_KEEP: Partial<CSSStyleDeclaration> = { border: POPUP_STYLE.border };
const HIGHLIGHT_KEEP: Partial<CSSStyleDeclaration> = { border: HIGHLIGHT_STYLE.border };
const TOAST_KEEP: Partial<CSSStyleDeclaration> = { border: '1px solid' };

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
    background: '#4cc2ff',
    border: 'none',
    borderRadius: '10px',
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
    borderRadius: '10px',
    cursor: 'pointer',
};

function renderEntry(
    term: string,
    token: SaviToken,
    entries: SaviDictEntry[],
    kanji: SaviKanjiInfo[],
    onMine: (button: HTMLButtonElement) => void,
    onDetails: () => void
): HTMLElement {
    const root = document.createElement('div');

    const head = document.createElement('div');
    Object.assign(head.style, { fontSize: '20px', fontWeight: '650', lineHeight: '1.3', marginBottom: '6px' });
    head.textContent = term;
    const headReading = headwordReading(term, token, entries);
    if (headReading) {
        const reading = document.createElement('span');
        Object.assign(reading.style, {
            fontSize: '13px',
            color: '#4cc2ff',
            marginLeft: '8px',
            fontWeight: '400',
        });
        reading.textContent = headReading;
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

    // "Details & context" — opens the tap panel: the full dictionary entry plus
    // the on-demand AI in-context reading. (Tapping the word itself does the same.)
    const details = document.createElement('button');
    details.textContent = '✦ Details & context';
    Object.assign(details.style, BREAKDOWN_BTN_STYLE);
    const detailsTrigger = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        onDetails();
    };
    details.addEventListener('pointerdown', detailsTrigger);
    details.addEventListener('click', detailsTrigger);
    root.appendChild(details);

    return root;
}

// Anchor the popup to the hovered word's row fragment horizontally and to the
// whole cue vertically: centered above the cue with a clear gap, arrow pointing
// at the fragment's center. Above the CUE rather than the fragment, because a
// word on a wrapped cue's second row would otherwise get the popup sitting on
// top of the first row. The gap scales with the ROW height (`rowHeight`, the
// hovered fragment's) so a neighboring text row stays accessible; a popup
// taller than the space scrolls internally instead of covering that row or
// leaving the viewport; and it flips below when there is more room there.
export function positionPopup(
    popup: HTMLDivElement,
    arrow: HTMLDivElement,
    anchor: Box,
    rowHeight: number = anchor.height
) {
    const content = popup.querySelector<HTMLElement>('[data-savi-popup-content]');
    if (content) content.style.maxHeight = '';
    let pr = popup.getBoundingClientRect();
    const margin = 8;
    const wordCenterX = anchor.left + anchor.width / 2;

    let left = wordCenterX - pr.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pr.width - margin));

    const anchorBottom = boxBottom(anchor);
    const gap = Math.max(POPUP_MIN_GAP, Math.ceil(rowHeight * 1.8));
    const aboveSpace = Math.max(0, anchor.top - gap - ARROW_SIZE - margin);
    const belowSpace = Math.max(0, window.innerHeight - anchorBottom - gap - ARROW_SIZE - margin);
    const below = pr.height > aboveSpace && belowSpace > aboveSpace;
    const available = below ? belowSpace : aboveSpace;
    if (content && pr.height > available) {
        const chrome = pr.height - content.getBoundingClientRect().height;
        content.style.maxHeight = `${Math.max(0, available - chrome)}px`;
        content.style.overflowY = 'auto';
        pr = popup.getBoundingClientRect();
    }
    const top = below ? anchorBottom + gap + ARROW_SIZE : anchor.top - pr.height - gap - ARROW_SIZE;

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

/** Hit-test slack for a subtitle line: 2px sideways, and vertically half the
 *  row's leading (from the line's computed line-height), so the gap between two
 *  wrapped rows still lands on the nearer row — as the old caret snap did. */
function hitPadFor(line: HTMLElement): HitPad {
    const lineHeight = parseFloat(getComputedStyle(line).lineHeight);
    return { x: 2, y: 3, lineHeight: Number.isFinite(lineHeight) ? lineHeight : undefined };
}

/** Attaches a hover handler over subtitle text: boxes the word under the
 *  cursor and shows a daemon-backed dictionary popup for it. */
/** The headline label of a dictionary result — the first gloss of the first
 *  sense (what the popup shows most prominently). '' when there's none (a
 *  kanji-only result still teaches, but there is no label to persist). */
const firstDictGloss = (entries: SaviDictEntry[]): string => entries[0]?.senses?.[0]?.glosses?.[0] ?? '';

export interface SaviHoverAdapter {
    resolveLine(target: EventTarget | null, x: number, y: number): HTMLElement | null;
    episodeId(): string | undefined;
    playback(): Pick<HTMLMediaElement, 'paused' | 'pause' | 'play'> | null;
}

export class SaviHoverDictionary {
    // AI segmentations only — a rule-based fallback is never cached (see _segment).
    private readonly _segmentCache = new Map<string, SaviToken[]>();
    private readonly _explainCache = new Map<string, string | null>();
    private readonly _kanjiCache = new Map<string, SaviKanjiFull[]>();
    private _wordPanel: SaviWordPanel | null = null;
    private _panelOpen = false; // the tap study panel is up → keep the video paused
    private _pausedForPanel = false; // WE paused the video for the panel, so WE resume
    private readonly _dictCache = new Map<string, { result: SaviDictResponse; expiresAt: number }>();
    private readonly _dictFlights = new Map<string, Promise<SaviDictResponse>>();
    private _prefetchTimer: ReturnType<typeof setInterval> | undefined;
    private _prefetching = false;
    private _prefetchRetryAt = 0;
    private _panelPlayback: Pick<HTMLMediaElement, 'paused' | 'pause' | 'play'> | null = null;
    private _panelEpisode: string | undefined;
    private _lifecycle = 0;
    private _popup: HTMLDivElement | null = null;
    private _popupContent: HTMLDivElement | null = null;
    private _arrow: HTMLDivElement | null = null;
    /** One outline per row the boxed word occupies (a wrapped word has two);
     *  extras beyond the current word stay hidden. */
    private _highlights: HTMLDivElement[] = [];
    /** The subtitle line element the highlight box currently sits on, and the
     *  row (top edge) it is on. Moves along that row glide; a move to any other
     *  row or line snaps. See _highlightBoxes. */
    private _highlightLine: HTMLElement | null = null;
    /** The WORD the visuals are anchored to (line element + char span + which
     *  of its row fragments the cursor was on), so the boxes and popup can
     *  follow it when the page moves it. The geometry measured at hover time
     *  goes stale in seconds on Netflix: hovering pauses the video, the player
     *  chrome fades a beat later, and the bottom-anchored subtitle block shifts
     *  back down — leaving fixed-position boxes ringing empty pixels above the
     *  word. The word's IDENTITY is stable; its position isn't. */
    private _anchor: { line: HTMLElement; start: number; end: number; text: string; hitIndex: number } | null = null;
    private _trackRaf: number | null = null;
    /** The last glyph boxes applied to the visuals, to skip no-op writes per frame. */
    private _lastBoxes: Box[] | null = null;
    private _highlightTop: number | null = null;
    private _bridge: HTMLDivElement | null = null; // transparent gap-cover from word up to popup
    /** Every body-level overlay and its top-layer bookkeeping, so all of them
     *  can be re-hosted when fullscreen toggles (SV-44). */
    private readonly _hosted = new Map<HTMLElement, { promoted: boolean; keep: Partial<CSSStyleDeclaration> }>();
    /** The last mousemove landed on the popup or the bridge. */
    private _pointerOnSurface = false;
    private _toastEl: HTMLDivElement | null = null; // standalone mine-result toast (outlives the popup)
    private _toastTimer: number | null = null;
    private _cursorLine: HTMLElement | null = null; // line we set cursor:pointer on
    private _currentTerm: string | null = null;
    private _hideTimer: ReturnType<typeof setTimeout> | undefined; // delayed hide, cancellable
    private _generation = 0; // bumps to cancel stale async work
    private _bound = false;

    // Episodes whose full transcript we've already uploaded this session, so we
    // send it at most once per episode (it's the whole subtitle file).
    private readonly _transcriptSentFor = new Set<string>();

    /** @param _videoProvider returns the bound media element, so a mined card
     *  can screenshot the current frame. Defaults to none (no screenshot).
     *  @param _onReveal called when a word's meaning was actually SHOWN to the
     *  user (hover popup / tap panel), with the line, the word surface, and
     *  the displayed gloss — the encounter reporter records it as a
     *  hover_glossed encounter carrying the label (SV-20). This is what makes
     *  the JA path feed the reviewer at all.
     *  @param _onRevealEnd the meaning stopped showing — closes the dwell the
     *  reporter started at `_onReveal`. Level 2 needs to know how long a word
     *  was READ to tell a lookup from a cursor passing through.
     *  @param _onRetract the user MINED this word (added a card, or opened the
     *  study panel). That makes the reveal collection rather than failed
     *  recall, so no dwell is claimed for it and the card is never lapsed. */
    constructor(
        private readonly _videoProvider: () => HTMLMediaElement | null = () => null,
        private readonly _subtitleProvider: () => SerializableSubtitle[] = () => [],
        private readonly _onReveal?: (lineText: string, word: string, gloss: string) => void,
        private readonly _onRevealEnd?: (lineText: string, word: string) => void,
        private readonly _onRetract?: (lineText: string, word: string) => void,
        private readonly _adapter?: SaviHoverAdapter
    ) {}

    private _episodeId() {
        return this._adapter ? this._adapter.episodeId() : deriveEpisodeId(location.href, document.title);
    }
    private _playback() {
        return this._adapter ? this._adapter.playback() : this._videoProvider();
    }
    private _resolveLine(target: EventTarget | null, x: number, y: number) {
        return this._adapter ? this._adapter.resolveLine(target, x, y) : lineElement(target);
    }

    /** A platform control superseded Savi's pause ownership. */
    cancelPlaybackResume() {
        this._pausedForPanel = false;
        this._panelPlayback = null;
    }

    /** The reveal currently on screen, so its dwell can be closed when the
     *  popup or panel goes away. */
    private _revealed: { line: string; word: string } | null = null;

    /** Record that `word`'s meaning is on screen, closing any previous one. */
    private _noteReveal(line: string, word: string, gloss: string): void {
        if (this._revealed && this._revealed.word !== word) {
            this._endReveal();
        }
        this._revealed = { line, word };
        this._onReveal?.(line, word, gloss);
    }

    /** Close the on-screen reveal's dwell, if any. Idempotent. */
    private _endReveal(): void {
        if (this._revealed) {
            this._onRevealEnd?.(this._revealed.line, this._revealed.word);
            this._revealed = null;
        }
    }

    start() {
        if (this._bound) return;
        this._bound = true;
        document.addEventListener('mousemove', this._onMouseMove, true);
        document.addEventListener('click', this._onClick, true);
        this._prefetchTimer = setInterval(() => void this._prefetch(), 500);
        void this._prefetch();
        document.addEventListener('fullscreenchange', this._onFullscreenChange);
    }

    stop() {
        this._lifecycle++;
        this._endReveal();
        if (!this._bound) return;
        this._bound = false;
        clearInterval(this._prefetchTimer);
        this._prefetchTimer = undefined;
        document.removeEventListener('mousemove', this._onMouseMove, true);
        document.removeEventListener('click', this._onClick, true);
        document.removeEventListener('fullscreenchange', this._onFullscreenChange);
        this._clear();
        this._panelOpen = false;
        this._pausedForPanel = false;
        this._panelPlayback = null;
        this._wordPanel?.destroy();
        this._wordPanel = null;
    }

    /** True when (x, y) is over savi's own hover surfaces — the dictionary popup
     *  or the transparent word→popup bridge. The binding uses this to keep the
     *  video paused while the cursor moves from a subtitle word onto the popup
     *  (so reaching "+ Add to Anki" doesn't resume playback). */
    isOverHoverSurface(x: number, y: number): boolean {
        if (this._panelOpen) {
            return true; // study panel up — tell the binding to keep the video paused
        }
        if (this._pointerOnSurface) {
            // What the last mousemove actually targeted. elementFromPoint below
            // does not report top-layer elements, which is where the popup lives
            // over a bare fullscreen video (SV-44).
            return true;
        }
        const el = document.elementFromPoint(x, y);
        if (!(el instanceof Node)) return false;
        return (!!this._popup && this._popup.contains(el)) || this._isOverBridge(x, y);
    }

    private _isOverBridge(x: number, y: number): boolean {
        if (!this._bridge || this._bridge.style.display === 'none') return false;
        const rect = this._bridge.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    private _onMouseMove = (event: MouseEvent) => {
        const line = this._resolveLine(event.target, event.clientX, event.clientY);
        if (!line) {
            const target = event.target;
            const onPopup = !!this._popup && target instanceof Node && this._popup.contains(target);
            const onBridge = this._isOverBridge(event.clientX, event.clientY);
            this._pointerOnSurface = onPopup || onBridge;
            if (onPopup || onBridge) {
                // Empty space in the gap keeps the popup reachable. Actual text
                // resolves above and takes priority, allowing direct line-to-line hover.
                this._cancelHide();
                return;
            }
            // Off the line and not on the popup/bridge: give the cursor a beat to
            // reach the popup before hiding.
            this._scheduleHide();
            return;
        }
        // On a subtitle line. A pending hide is cancelled only once a word is
        // actually hit (_applyTokens): roaming the translation line or a cue's
        // punctuation is leaving, as far as the popup is concerned.
        this._pointerOnSurface = false;
        const { clientX, clientY } = event;
        void this._handleHover(line, clientX, clientY);
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
        if (!text || !JAPANESE.test(text)) {
            // The translation line: leaving, as far as the popup is concerned —
            // the same grace as leaving into the video, not an instant blink-off.
            this._scheduleHide();
            return;
        }
        // Prepared words render in this event. Cold lookups use the local
        // tokenizer/dictionary; the hover path never calls an LLM.
        try {
            const available = this._tokenize(text);
            const tokens = Array.isArray(available) ? available : await available;
            if (generation !== this._generation) return;
            await this._applyTokens(line, text, x, y, tokens, generation);
        } catch {
            if (generation === this._generation) this._clear();
        }
    }

    /** Box the word under (x, y) and show its rule-based dictionary popup. */
    private async _applyTokens(
        line: HTMLElement,
        text: string,
        x: number,
        y: number,
        tokens: SaviToken[],
        generation: number
    ) {
        // By geometry, not by caret: the word whose glyph boxes contain the
        // cursor (hit-test.ts says what the caret got wrong).
        const span = tokenSpanAtPoint(line, tokens, x, y, hitPadFor(line));
        if (!span || !JAPANESE.test(span.token.text)) {
            // Between words, on punctuation, in a row's padding: the cursor is
            // usually on its way to the next word or up to the popup, so the last
            // word's box and popup linger through the grace instead of blinking
            // off at every 「(」 — the same grace as leaving the line.
            this._scheduleHide();
            return;
        }
        this._cancelHide();

        // Box the word under the cursor whether or not it resolves to an entry
        // — every word gets the outline, like Language Reactor. One box per row
        // the word occupies, so a word that wraps is boxed on both rows rather
        // than by one box spanning them. Anchor by identity and keep following
        // it: if the page moves the word (chrome fade, subtitle reflow), the
        // visuals move WITH it.
        const hitIndex = Math.max(0, span.boxes.indexOf(span.hit));
        this._anchor = { line, start: span.start, end: span.end, text: line.textContent ?? '', hitIndex };
        this._highlightBoxes(line, span.boxes);
        this._startTracking();

        // Look up the dictionary form — fall back to the surface so words without
        // a lemma (しかし, そこ, 東京) get defined instead of skipped.
        const term = lookupTermFor(span.token);
        if (term === this._currentTerm) {
            // The same word can occur elsewhere in the cue — or this one moved.
            // Its definition is already on screen; re-aim the popup and bridge
            // at where it is now.
            this._aimPopup(line, span.boxes, hitIndex);
            return;
        }
        const available = this._lookupDict(term);
        const result = available instanceof Promise ? await available : available;
        if (generation !== this._generation) {
            return;
        }
        // Layout can change while the dictionary request is in flight.
        const current = this._anchorBoxes();
        if (!current) {
            this._clear();
            return;
        }
        if (!boxesEqual(current, this._lastBoxes)) {
            this._placeHighlight(line, current, true);
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
                (button) => void this._mine(text, span.token, term, button),
                () => void this._openWordDetail(text, span)
            )
        );
        popup.style.display = 'block';
        // The word's meaning is now on screen — a hover_glossed encounter with
        // the shown label (SV-20). Kanji-only results reveal no label ('').
        this._noteReveal(text, span.token.text, firstDictGloss(result.entries));
        this._aimPopup(line, current, hitIndex);
    }

    /** Aim the popup and its bridge at row fragment `hitIndex` of `boxes` — the
     *  one the cursor is on — above or below the whole cue (see positionPopup).
     *  A no-op while the popup is hidden. */
    private _aimPopup(line: HTMLElement, boxes: Box[], hitIndex: number) {
        if (!this._popup || this._popup.style.display === 'none') return;
        const hit = boxes[Math.min(hitIndex, boxes.length - 1)];
        const anchor = popupAnchor(hit, textExtent(line));
        positionPopup(this._popup, this._arrow!, anchor, hit.height);
        this._positionBridge(anchor);
    }

    private _tokenize(text: string): SaviToken[] | Promise<SaviToken[]> {
        return subtitleTokens.peek(LANG, text) ?? subtitleTokens.get(LANG, text);
    }

    /** Warm at most two primary cues within five seconds of the playhead.
     *  Sequential requests bound background load; hover shares their cache and
     *  in-flight requests. Preparation never displays or records a reveal. */
    private async _prefetch() {
        if (!this._bound || this._prefetching || Date.now() < this._prefetchRetryAt) return;
        const video = this._videoProvider();
        if (!video || !Number.isFinite(video.currentTime)) return;
        const now = video.currentTime * 1000;
        const cues = this._subtitleProvider()
            .filter((cue) => cue.track === 0 && cue.end >= now && cue.start <= now + 5000 && JAPANESE.test(cue.text))
            .sort((a, b) => a.start - b.start)
            .slice(0, 2);
        this._prefetching = true;
        try {
            for (const cue of cues) {
                if (!this._bound) return;
                const tokens = await this._tokenize(cue.text.replace(/\s+$/, ''));
                const terms = new Set(tokens.filter((token) => JAPANESE.test(token.text)).map(lookupTermFor));
                for (const term of terms) {
                    if (!this._bound) return;
                    await this._lookupDict(term);
                }
            }
        } catch {
            // Offline/unavailable: hover can retry, background work backs off.
            this._prefetchRetryAt = Date.now() + 5000;
        } finally {
            this._prefetching = false;
        }
    }

    /** AI segmentation for a line (cached). `tokens` is null when the daemon fell
     *  back to rule-based (feature off / no account / offline / a split that
     *  wouldn't reconcile) — the caller then keeps the rule-based render — and
     *  `unavailable` says why, so the panel can name the reason honestly.
     *
     *  ONLY successes are cached, for the same reason as `_explainWord`: a cached
     *  fallback would outlive its cause AND its reason. Signed out → the note says
     *  to sign in → the user does → the retap of the same line would be served the
     *  cached null and keep telling them to sign in, right under an explanation
     *  section that just succeeded. */
    private async _segment(text: string): Promise<{ tokens: SaviToken[] | null; unavailable?: SaviAiUnavailable }> {
        const cacheKey = this._adapter ? `${this._episodeId() ?? ''}\u0000${text}` : text;
        const cached = this._segmentCache.get(cacheKey);
        if (cached !== undefined) {
            return { tokens: cached };
        }
        const { prevLines, nextLines } = this._neighborsOf(text);
        const res = await sendToBackground<SaviSegmentLineResponse>({
            command: 'savi-segment-line',
            lang: LANG,
            text,
            prevLines,
            nextLines,
            episodeId: this._episodeId(),
        });
        if (!res.ai || res.tokens.length === 0) {
            return { tokens: null, unavailable: res.unavailable };
        }
        if (this._segmentCache.size >= TOKENIZE_CACHE_MAX) {
            const oldest = this._segmentCache.keys().next().value;
            if (oldest !== undefined) this._segmentCache.delete(oldest);
        }
        this._segmentCache.set(cacheKey, res.tokens);
        return { tokens: res.tokens };
    }

    /** Focused professor-style explanation of a word in its sentence (cached).
     *  `explanation` is null when there is nothing to show; `unavailable` says why,
     *  so the panel can name the actual fix instead of blaming a provider.
     *
     *  ONLY successes are cached. Caching a failure would outlive its cause: the
     *  common one is "signed out", the panel then says to sign in, and the retap
     *  that should prove it worked would be served the cached null instead. */
    private async _explainWord(
        text: string,
        term: string,
        reading?: string
    ): Promise<{ explanation: string | null; unavailable?: SaviAiUnavailable }> {
        const cacheKey = `${this._adapter ? (this._episodeId() ?? '') : ''}\u0000${term}\u0000${text}`;
        const cached = this._explainCache.get(cacheKey);
        if (cached !== undefined) {
            return { explanation: cached };
        }
        const { prevLines, nextLines } = this._neighborsOf(text);
        const res = await sendToBackground<SaviExplainWordResponse>({
            command: 'savi-explain-word',
            lang: LANG,
            term,
            reading,
            text,
            prevLines,
            nextLines,
            episodeId: this._episodeId(),
        });
        const explanation = res.explanation ?? null;
        if (explanation === null) {
            return { explanation: null, unavailable: res.unavailable };
        }
        if (this._explainCache.size >= TOKENIZE_CACHE_MAX) {
            const oldest = this._explainCache.keys().next().value;
            if (oldest !== undefined) this._explainCache.delete(oldest);
        }
        this._explainCache.set(cacheKey, explanation);
        return { explanation };
    }

    /** Full kanji breakdown for a word's kanji (cached). Offline RTK/KANJIDIC data
     *  — empty on no-daemon/error. */
    private async _lookupKanji(term: string): Promise<SaviKanjiFull[]> {
        const cached = this._kanjiCache.get(term);
        if (cached !== undefined) {
            return cached;
        }
        const res = await sendToBackground<SaviKanjiResponse>({ command: 'savi-kanji', lang: LANG, term });
        const kanji = res.kanji ?? [];
        if (this._kanjiCache.size >= TOKENIZE_CACHE_MAX) {
            const oldest = this._kanjiCache.keys().next().value;
            if (oldest !== undefined) this._kanjiCache.delete(oldest);
        }
        this._kanjiCache.set(term, kanji);
        return kanji;
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

    /** Tap handler: open the study panel for a Japanese subtitle word. */
    private _onClick = (event: MouseEvent) => {
        const line = this._resolveLine(event.target, event.clientX, event.clientY);
        if (!line) {
            return; // not on a subtitle — let the click through (video controls, etc.)
        }
        const text = (line.textContent ?? '').replace(/\s+$/, '');
        if (!text || !JAPANESE.test(text)) {
            return;
        }
        // Swallow the tap so it doesn't also toggle the video's play/pause.
        event.preventDefault();
        event.stopPropagation();
        void this._openWordDetailAt(line, text, event.clientX, event.clientY);
    };

    /** The study panel for the word under (x, y) — the same geometric hit-test
     *  as the hover, so a tap opens the word the box is on. Nothing opens on
     *  punctuation or in the line's padding. */
    private async _openWordDetailAt(line: HTMLElement, text: string, x: number, y: number) {
        const lifecycle = this._lifecycle;
        const episode = this._episodeId();
        const tokens = await this._tokenize(text);
        if (lifecycle !== this._lifecycle || episode !== this._episodeId()) return;
        const span = tokenSpanAtPoint(line, tokens, x, y, hitPadFor(line));
        if (span) {
            await this._openWordDetail(text, span);
        }
    }

    /** Open the tap panel for `span`'s word: full dictionary entry + kanji
     *  immediately, then the AI in-context reading + whole-line breakdown fetched
     *  on demand. This is the ONLY place the segmentation LLM runs, so a slow or
     *  failed call only ever affects this panel — never the hover popup. */
    private async _openWordDetail(text: string, span: TokenSpan) {
        const lifecycle = this._lifecycle;
        const episode = this._episodeId();
        if (!JAPANESE.test(span.token.text)) {
            return;
        }
        const term = lookupTermFor(span.token);
        const dict = await this._lookupDict(term);
        if (lifecycle !== this._lifecycle || episode !== this._episodeId()) return;
        this._hidePopup(); // the small hover popup gives way to the full panel
        // Opening the study panel is MINING intent, not a failure to recall —
        // the panel is where the "+ Add to Anki" button lives. Retract before
        // the reveals below so neither the dictionary headline nor the AI
        // in-context gloss can claim a dwell for this word (the retraction is
        // sticky across later reveals of the same word, by design).
        this._onRetract?.(text, span.token.text);
        const panel = this._ensureWordPanel();
        panel.show({
            term,
            token: span.token,
            entries: dict.entries,
            kanji: dict.kanji,
            onMine: (button) => void this._mine(text, span.token, term, button),
        });
        // A deliberate tap-open study of the word — record the reveal with the
        // dictionary headline (upgraded below if the AI in-context gloss lands).
        this._noteReveal(text, span.token.text, firstDictGloss(dict.entries));
        // Pause the video while the study panel is up and KEEP it paused until the
        // user dismisses it — independent of the cursor or the hover-pause setting.
        // (isOverHoverSurface returns true while _panelOpen, so the binding's
        // hover-resume can't fire; we resume on close only when WE were the pauser.)
        this._panelOpen = true;
        const video = this._playback();
        if (video && !video.paused) {
            video.pause();
            this._pausedForPanel = true;
            this._panelPlayback = video;
            this._panelEpisode = episode;
        }
        // Make sure the daemon has the whole-episode transcript (once per episode) so
        // the AI explanation + segmentation can ground in the episode gist — not just
        // the ±2 neighbouring lines — even when you only ever tap (never mine). Awaited
        // so the FIRST tap of an episode already benefits; a no-op on later taps.
        // Skipped entirely when the page has no stable id yet — grounding the
        // AI in an episode we cannot name would file the transcript under a
        // throwaway id.
        const transcriptEpisodeId = this._episodeId();
        if (transcriptEpisodeId !== undefined) {
            await this._maybeSendTranscript(transcriptEpisodeId).catch(() => {});
        }
        if (lifecycle !== this._lifecycle || episode !== this._episodeId()) return;
        // AI in-context — fired ONLY here, on a deliberate tap. Far fewer calls than
        // per-hover (so the providers stop rate-limiting), and a slow/failed call
        // degrades to a graceful "unavailable" inside the panel.
        this._segment(text)
            .then(({ tokens: aiTokens, unavailable }) => {
                let featured: WordContext | null = null;
                if (aiTokens) {
                    const aiSpan = tokenSpanAtOffset(aiTokens, span.start);
                    if (aiSpan) {
                        featured = { gloss: aiSpan.token.gloss, grammar: aiSpan.token.grammar };
                    }
                }
                panel.setContext(featured, aiTokens, unavailable);
                // The AI in-context gloss is the best label for this exact
                // sentence — overwrite the dictionary headline on the pending
                // encounter (the line is still open: the panel pauses playback).
                if (featured?.gloss) {
                    this._noteReveal(text, span.token.text, featured.gloss);
                }
            })
            .catch(() => panel.setContext(null, null));
        // In parallel, fetch the detailed "explain like a sensei" note for the
        // tapped word and fill the panel's teaching section when it lands.
        this._explainWord(text, term, span.token.reading)
            .then(({ explanation, unavailable }) => panel.setExplanation(explanation, unavailable))
            .catch(() => panel.setExplanation(null));
        // Full RTK/KANJIDIC kanji breakdown (readings, components, mnemonic stories,
        // example compounds) — upgrades the panel's compact kanji section.
        this._lookupKanji(term)
            .then((kanji) => panel.setKanji(kanji))
            .catch(() => {});
    }

    private _ensureWordPanel(): SaviWordPanel {
        if (!this._wordPanel) {
            this._wordPanel = new SaviWordPanel(() => this._onPanelClosed());
        }
        return this._wordPanel;
    }

    /** The study panel was dismissed. If WE paused the video for it, resume; if the
     *  hover-pause feature paused it, clearing _panelOpen lets the binding resume on
     *  the next mouse move (or stay paused, per the user's hover-pause mode). */
    private _onPanelClosed() {
        this._endReveal();
        this._panelOpen = false;
        if (this._pausedForPanel) {
            this._pausedForPanel = false;
            const video = this._playback();
            if (video && video === this._panelPlayback && this._episodeId() === this._panelEpisode && video.paused) {
                void video.play().catch(() => {});
            }
            this._panelPlayback = null;
        }
    }

    /** Mine the hovered line + word into Anki. The daemon derives the episode
     *  from the same platform-stable id the capture used, clips the line's
     *  audio, and writes the note. Feedback lives on the button itself so the
     *  popup stays put. */
    private async _mine(lineText: string, token: SaviToken, term: string, button: HTMLButtonElement) {
        if (button.disabled || button.dataset.saviMined === 'true') {
            return; // mine in flight or already added — don't double-fire
        }
        // Collection, not failed recall: a mined word must never lapse its own
        // card. Retracted here rather than on success, because the INTENT is
        // what distinguishes the gesture — a mine that fails on a daemon error
        // was still not a lookup.
        this._onRetract?.(lineText, token.text);
        button.disabled = true;
        button.textContent = 'Adding…';
        try {
            const episodeId = this._episodeId();
            if (episodeId === undefined) {
                button.textContent = 'Not ready';
                return;
            }
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
        const els = [this._popup, ...this._highlights, this._bridge].filter((e): e is HTMLDivElement => e !== null);
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
        this._toastTimer = window.setTimeout(
            () => {
                el.style.opacity = '0';
                el.style.transform = 'translateX(-50%) translateY(-8px)';
            },
            kind === 'success' ? 2600 : 4200
        );
    }

    private _ensureToast(): HTMLDivElement {
        if (this._toastEl) {
            this._host(this._toastEl, TOAST_KEEP);
            return this._toastEl;
        }
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
        this._toastEl = el;
        this._host(el, TOAST_KEEP);
        return el;
    }

    private _lookupDict(term: string): SaviDictResponse | Promise<SaviDictResponse> {
        const cached = this._dictCache.get(term);
        if (cached && cached.expiresAt > Date.now()) return cached.result;
        const flight = this._dictFlights.get(term);
        if (flight) return flight;
        const pending = sendToBackground<SaviDictResponse>({ command: 'savi-dict', lang: LANG, term })
            .then((res) => {
                const result: SaviDictResponse = { entries: res.entries ?? [], kanji: res.kanji ?? [] };
                if (this._dictCache.size >= DICT_CACHE_MAX) {
                    const oldest = this._dictCache.keys().next().value;
                    if (oldest !== undefined) this._dictCache.delete(oldest);
                }
                // The background also returns an empty result when offline.
                // Retry misses shortly instead of caching an outage indefinitely.
                const expiresAt = result.entries.length || result.kanji.length ? Infinity : Date.now() + 5000;
                this._dictCache.set(term, { result, expiresAt });
                return result;
            })
            .finally(() => this._dictFlights.delete(term));
        this._dictFlights.set(term, pending);
        return pending;
    }

    /** Outline the word's glyph rows — one box per row it occupies. */
    private _highlightBoxes(line: HTMLElement, boxes: Box[]) {
        if (boxes.length === 0) {
            this._hideHighlight();
            return;
        }
        // The box GLIDES between words (60ms transition on left/top/width/height)
        // so it reads as one cursor sliding along a row. That's right within a
        // row and wrong anywhere else: hopping from a word on the Japanese line
        // to a word on the English line beneath, to the next cue's line after
        // the previous one is gone, or to the other row of the same wrapped cue
        // slid the box diagonally across the video, which reads as the subtitle
        // scrolling. Same story when the box was last left on some far-away word
        // and reappears here. Glide only when a single box stays on the same row
        // of the same line element; otherwise snap, and re-enable the transition
        // on the next frame so the NEXT within-row move glides.
        const first = this._highlights[0];
        const sameRow =
            this._highlightLine === line &&
            this._highlightTop !== null &&
            first !== undefined &&
            first.style.display !== 'none' &&
            boxes.length === 1 &&
            Math.abs(boxes[0].top - this._highlightTop) < 1;
        this._placeHighlight(line, boxes, !sameRow);
        // The subtitle container forces cursor:text; signal the word is
        // clickable with a pointer while it's boxed.
        if (this._cursorLine !== line) {
            if (this._cursorLine) this._cursorLine.style.cursor = '';
            line.style.cursor = 'pointer';
            this._cursorLine = line;
        }
    }

    /** Write the boxes' geometry, one outline per row. `snap` suppresses the
     *  glide for this placement (cross-row hops, and the anchor tracker
     *  following a layout shift — gliding there reads as the box chasing the
     *  subtitle). */
    private _placeHighlight(line: HTMLElement, boxes: Box[], snap: boolean) {
        // Japanese cues carry letter-spacing, which each row's box includes as
        // trailing space on the right — drop it so the box ends at the last
        // glyph instead of reaching into the next word. Small horizontal room,
        // a touch more vertical.
        const trailing = parseFloat(getComputedStyle(line).letterSpacing) || 0;
        const shown = highlightBoxes(boxes, trailing);
        shown.forEach((box, i) => {
            const el = this._ensureHighlight(i);
            const snapThis = snap || i > 0;
            if (snapThis) {
                el.style.transition = 'none';
            }
            el.style.left = `${box.left}px`;
            el.style.top = `${box.top}px`;
            el.style.width = `${box.width}px`;
            el.style.height = `${box.height}px`;
            el.style.display = 'block';
            if (snapThis) {
                // Force the style flush at the snapped position before restoring
                // the transition, or the browser coalesces both writes and glides
                // anyway.
                void el.offsetWidth;
                el.style.transition = HIGHLIGHT_STYLE.transition ?? '';
            }
        });
        for (const el of this._highlights.slice(shown.length)) {
            el.style.display = 'none';
        }
        this._highlightLine = line;
        this._highlightTop = boxes[0]?.top ?? null;
        this._lastBoxes = boxes.map((box) => ({ ...box }));
    }

    // ── Anchor tracking ─────────────────────────────────────────────────────
    // While the highlight is visible, re-measure the anchored word every frame
    // and move the visuals when the PAGE moved the word. The classic trigger:
    // hover pauses the video, Netflix's control chrome fades out a couple of
    // seconds later, and the bottom-anchored subtitle block drops back down —
    // with a one-shot rect, the box and popup stayed floating where the word
    // USED to be. Measure only while visible; write styles only on change.

    private _startTracking() {
        if (this._trackRaf === null) {
            this._trackRaf = requestAnimationFrame(this._trackTick);
        }
    }

    private _stopTracking() {
        if (this._trackRaf !== null) {
            cancelAnimationFrame(this._trackRaf);
            this._trackRaf = null;
        }
        this._anchor = null;
        this._lastBoxes = null;
    }

    /** The anchored word's glyph boxes as laid out NOW — null once the cue is
     *  gone, replaced, or no longer laid out. */
    private _anchorBoxes(): Box[] | null {
        const anchor = this._anchor;
        if (!anchor || !anchor.line.isConnected || anchor.line.textContent !== anchor.text) {
            return null;
        }
        const boxes = fragmentBoxes(anchor.line, anchor.start, anchor.end);
        return boxes.length > 0 ? boxes : null;
    }

    private _trackTick = () => {
        this._trackRaf = null;
        const anchor = this._anchor;
        if (!anchor) return;
        const boxes = this._anchorBoxes();
        if (!boxes) {
            // A replaced, removed or hidden cue no longer anchors this lookup.
            this._clear();
            return;
        }
        if (!boxesEqual(boxes, this._lastBoxes)) {
            this._placeHighlight(anchor.line, boxes, true);
            this._aimPopup(anchor.line, boxes, anchor.hitIndex);
        }
        this._startTracking();
    };

    private _clear() {
        this._cancelHide();
        this._hidePopup();
        this._hideHighlight();
    }

    private _hidePopup() {
        this._endReveal();
        this._currentTerm = null;
        this._pointerOnSurface = false;
        this._generation++;
        if (this._popup) this._popup.style.display = 'none';
        if (this._bridge) this._bridge.style.display = 'none';
    }

    private _hideHighlight() {
        this._stopTracking();
        for (const el of this._highlights) el.style.display = 'none';
        this._highlightLine = null;
        this._highlightTop = null;
        if (this._cursorLine) {
            this._cursorLine.style.cursor = '';
            this._cursorLine = null;
        }
    }

    private _ensurePopup(): HTMLDivElement {
        if (this._popup) {
            this._host(this._popup, POPUP_KEEP);
            return this._popup;
        }
        const popup = document.createElement('div');
        popup.className = 'savi-dict-popup';
        Object.assign(popup.style, POPUP_STYLE);
        // Keep it alive while the cursor is on the popup itself.
        popup.addEventListener('mouseenter', () => {
            this._cancelHide();
        });

        const content = document.createElement('div');
        content.dataset.saviPopupContent = '';
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

        this._popup = popup;
        this._popupContent = content;
        this._arrow = arrow;
        this._host(popup, POPUP_KEEP);
        return popup;
    }

    /** Keep a body-level overlay paintable under the current fullscreen state
     *  (SV-44): inside the fullscreen element on streaming sites, in the top
     *  layer over a bare fullscreen video. Fullscreen renders only the
     *  fullscreened element's subtree, so a body-level popup exists, gets
     *  positioned, and is never painted — which is how the whole hover
     *  dictionary went invisible the moment the player went fullscreen, long
     *  after line detection there was fixed. Runs on every show, so an overlay
     *  created windowed follows the player in. */
    private _host(el: HTMLElement, keep: Partial<CSSStyleDeclaration>) {
        const hosted = this._hosted.get(el) ?? { promoted: false, keep };
        hosted.promoted = hostOverlay(el, hosted.promoted, keep);
        this._hosted.set(el, hosted);
    }

    /** Fullscreen toggled: whatever the hover had up is anchored to a layout
     *  that no longer exists — take it down — and every overlay moves into or
     *  out of the fullscreen element (or the top layer). The tap panel stays
     *  up across the toggle, re-hosted: it paused the video and must remain
     *  dismissable. */
    private _onFullscreenChange = () => {
        this._clear();
        this._hosted.forEach((hosted, el) => {
            hosted.promoted = hostOverlay(el, hosted.promoted, hosted.keep);
        });
        this._wordPanel?.rehost();
    };

    /** The `i`th outline box, created on demand (one per row of the boxed word). */
    private _ensureHighlight(i: number): HTMLDivElement {
        while (this._highlights.length <= i) {
            const el = document.createElement('div');
            el.className = 'savi-dict-highlight';
            Object.assign(el.style, HIGHLIGHT_STYLE);
            this._highlights.push(el);
        }
        this._host(this._highlights[i], HIGHLIGHT_KEEP);
        return this._highlights[i];
    }

    private _ensureBridge(): HTMLDivElement {
        if (this._bridge) {
            this._host(this._bridge, {});
            return this._bridge;
        }
        const el = document.createElement('div');
        el.className = 'savi-dict-bridge';
        Object.assign(el.style, {
            position: 'fixed',
            zIndex: '2147483646', // geometry only; underlying words remain interactive
            pointerEvents: 'none',
            background: 'transparent',
            padding: '0',
            display: 'none',
        });
        this._bridge = el;
        this._host(el, {});
        return el;
    }

    // Geometry-only corridor keeps the popup open across blank space without
    // intercepting hover or clicks on neighboring subtitle lines. Spans from
    // the hovered CUE (the anchor) up to the popup.
    private _positionBridge(word: Box) {
        const popup = this._popup;
        const bridge = this._ensureBridge();
        if (!popup) return;
        const pr = popup.getBoundingClientRect();
        const wordBottom = boxBottom(word);
        const left = Math.min(word.left, pr.left);
        const right = Math.max(boxRight(word), pr.right);
        let top: number;
        let height: number;
        if (pr.top >= wordBottom) {
            top = wordBottom; // popup sits below the word
            height = pr.top - wordBottom;
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
