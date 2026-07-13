// On-demand hover glossing (follow-up to SV-12/13). Two behaviours, gated behind
// the `saviHoverGloss` setting and scoped to glossable (non-Japanese) languages:
//
//   1. Hover a subtitle word → its translation shows in a small ruby-style label
//      ABOVE the word. Additive to the always-on labels: it only labels words
//      that don't already have one (words you know, or ones the always-on pass
//      couldn't translate), so hovering a known word reveals its meaning.
//   2. Deferred pause: when the current line reaches its end while the cursor is
//      still on the subtitle, HOLD the line (pause) so you can finish reading;
//      resume when you move the cursor off the line.
//
// Nothing here re-renders the subtitle DOM — the label is a `pointer-events:none`
// overlay positioned over the word, so moving between words never reflows the
// line. Japanese is served by the hover DICTIONARY instead (this stays inert
// there), so the two never collide.

import type { SettingsProvider } from '@project/common/settings';
import { GlossSegment, SaviGlossController, segmentLine } from './gloss';
import { caretRangeFromPoint, lineElement } from './hover-dict';

const GAP_ABOVE_WORD_PX = 6;

const LABEL_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    zIndex: '2147483646',
    pointerEvents: 'none',
    color: '#ffe08a', // matches the always-on gloss label
    background: 'rgba(0, 0, 0, 0.72)',
    padding: '1px 7px',
    borderRadius: '6px',
    whiteSpace: 'nowrap',
    textShadow: '0 1px 2px rgba(0, 0, 0, 0.9)',
    transform: 'translate(-50%, -100%)', // center above the word
    transition: 'left 60ms linear, top 60ms linear',
    font: '600 15px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    display: 'none',
};

// ── rt-aware line geometry ────────────────────────────────────────────────
// The always-on pass wraps glossed words in `<ruby class="asb-gloss">word<rt>
// gloss</rt></ruby>`, so the line's raw text contains the <rt> labels too. These
// helpers walk only the BASE text (skipping <rt>), so a caret offset maps to the
// ORIGINAL line and a word's box excludes its gloss label.

const inRt = (node: Node | null): boolean =>
    (node instanceof Element ? node : node?.parentElement)?.closest('rt') != null;

const baseTextWalker = (root: HTMLElement): TreeWalker =>
    document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (inRt(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });

/** The line's text with any `<rt>` gloss labels removed — the original subtitle. */
export function baseTextOf(root: HTMLElement): string {
    const walker = baseTextWalker(root);
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        text += n.textContent ?? '';
    }
    return text;
}

/** Char offset in the BASE text of (x, y), or null when the caret is over an
 *  `<rt>` gloss label or off the line's text. */
export function baseCaretOffset(root: HTMLElement, x: number, y: number): number | null {
    const caret = caretRangeFromPoint(x, y);
    if (!caret || !root.contains(caret.startContainer) || inRt(caret.startContainer)) {
        return null;
    }
    const walker = baseTextWalker(root);
    let offset = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n === caret.startContainer) {
            return offset + caret.startOffset;
        }
        offset += n.textContent?.length ?? 0;
    }
    return null;
}

/** A Range over BASE chars `[start, end)`, skipping `<rt>` — the word's box. */
export function baseRangeForSpan(root: HTMLElement, start: number, end: number): Range | null {
    const walker = baseTextWalker(root);
    const range = document.createRange();
    let acc = 0;
    let started = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.textContent?.length ?? 0;
        if (!started && acc + len > start) {
            range.setStart(n, start - acc);
            started = true;
        }
        if (started && acc + len >= end) {
            range.setEnd(n, end - acc);
            return range;
        }
        acc += len;
    }
    return null;
}

/** The word segment whose `[start, end)` contains `offset` (null on a gap/punct).
 *  Segments concatenate back to the line, so a running sum locates the word. */
export function wordAtOffset(
    segments: GlossSegment[],
    offset: number
): { seg: GlossSegment; start: number; end: number } | null {
    let start = 0;
    for (const seg of segments) {
        const end = start + seg.text.length;
        if (seg.word && offset >= start && offset < end) {
            return { seg, start, end };
        }
        start = end;
    }
    return null;
}

// ── The controller ────────────────────────────────────────────────────────

export interface GlossHoverSources {
    readonly gloss: SaviGlossController;
    readonly settings: Pick<SettingsProvider, 'get'>;
    /** The bound media element, for the paused-state check. */
    readonly video: () => HTMLMediaElement | null | undefined;
    /** The binding's pause/play (Netflix-aware — a raw video.pause() is overridden). */
    readonly pause: () => void;
    readonly play: () => void;
}

export class SaviGlossHover {
    private readonly _sources: GlossHoverSources;

    private _settingEnabled = false; // the saviHoverGloss setting (glossable is read live)
    private _bound = false;
    private _label: HTMLDivElement | null = null;
    private _mouseOnSubtitle = false;
    private _deferredPaused = false; // WE held the line at its end; WE resume on mouse-out
    private _hoveredKey = ''; // line + span, so a word is translated/positioned once
    private _generation = 0; // cancels stale async translations
    private _lastLog = ''; // dedup for the hover diagnostics (mousemove fires constantly)

    constructor(sources: GlossHoverSources) {
        this._sources = sources;
    }

    // Diagnostic trail on the streaming tab's console (same spirit as
    // `[savi auto-load]`). Deduped so a mousemove storm logs each state once.
    private _log(message: string): void {
        if (message === this._lastLog) {
            return;
        }
        this._lastLog = message;
        console.info('[savi hover-gloss] %s', message);
    }

    /** Read the setting and (if on) bind the mouse listener. Called from the
     *  binding's bind(); safe to call again. Deliberately does NOT snapshot the
     *  gloss controller's `glossable` — that resolves asynchronously in its own
     *  start() (settings + roaming reads), so a snapshot here races it and the
     *  feature would wrongly deactivate. `isActive()` reads it live instead. */
    async start(): Promise<void> {
        this._clearHover();
        this._mouseOnSubtitle = false;
        this._deferredPaused = false;
        try {
            const { saviHoverGloss } = await this._sources.settings.get(['saviHoverGloss']);
            this._settingEnabled = saviHoverGloss;
        } catch {
            this._settingEnabled = false;
        }
        if (this._settingEnabled && !this._bound) {
            this._bound = true;
            document.addEventListener('mousemove', this._onMouseMove, true);
        }
        this._log(
            `start: setting=${this._settingEnabled}, glossable=${this._sources.gloss.glossable} (glossable may flip true shortly after), listener=${this._bound}`
        );
    }

    stop(): void {
        if (this._bound) {
            document.removeEventListener('mousemove', this._onMouseMove, true);
            this._bound = false;
        }
        this._clearHover();
        this._mouseOnSubtitle = false;
        this._deferredPaused = false;
        this._settingEnabled = false;
    }

    /** True when the feature is active: setting on AND glossing is live for the
     *  current language (computed LIVE — see start()). The binding reads it to
     *  suppress asbplayer's IMMEDIATE pause-on-hover, so the two don't both fire. */
    isActive(): boolean {
        return this._settingEnabled && this._sources.gloss.glossable;
    }

    /** The subtitle controller signals the current line is about to stop showing.
     *  If the cursor is on the subtitle, hold the line (pause) instead. */
    onWillStopShowing(): void {
        if (!this.isActive() || !this._mouseOnSubtitle || this._deferredPaused) {
            return;
        }
        const video = this._sources.video();
        if (video && !video.paused) {
            this._log('line ended while hovering — holding (pause)');
            this._sources.pause();
            this._deferredPaused = true;
        }
    }

    private _onMouseMove = (event: MouseEvent) => {
        if (!this.isActive()) {
            this._log(`inactive: setting=${this._settingEnabled}, glossable=${this._sources.gloss.glossable}`);
            return;
        }
        const line = lineElement(event.target);
        this._mouseOnSubtitle = line !== null;

        // Resume the line we held once the cursor leaves the subtitle.
        if (this._deferredPaused && !this._mouseOnSubtitle) {
            this._deferredPaused = false;
            this._sources.play();
        }

        if (!line) {
            this._clearHover();
            return;
        }
        void this._hoverWord(line, event.clientX, event.clientY);
    };

    private async _hoverWord(line: HTMLElement, x: number, y: number): Promise<void> {
        const offset = baseCaretOffset(line, x, y);
        if (offset === null) {
            this._log('no caret offset (between lines / over a gloss label / off text)');
            this._clearHover(); // between words / over an existing gloss label / off text
            return;
        }
        const baseText = baseTextOf(line);
        const span = wordAtOffset(segmentLine(baseText), offset);
        if (!span) {
            this._log(`offset ${offset} is a gap/punctuation in "${baseText}"`);
            this._clearHover();
            return;
        }
        const range = baseRangeForSpan(line, span.start, span.end);
        if (!range) {
            this._log(`no DOM range for "${span.seg.text}" [${span.start},${span.end})`);
            this._clearHover();
            return;
        }
        // Skip a word the always-on pass already labels (it's inside an asb-gloss
        // ruby) — the gloss is already on screen, no need to duplicate it.
        const anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
        if (anchor?.closest('ruby.asb-gloss')) {
            this._log(`"${span.seg.text}" already has an always-on label — skipping`);
            this._clearHover();
            return;
        }

        const key = `${baseText} ${span.start} ${span.end}`;
        if (key === this._hoveredKey) {
            return; // same word — already handled (label shown, or known to have no gloss)
        }
        this._hoveredKey = key;
        const generation = ++this._generation;

        const rect = range.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) {
            this._log(`empty rect for "${span.seg.text}"`);
            this._clearHover();
            return;
        }
        // Placeholder immediately (cached words fill instantly; a first-time known
        // word takes a beat), then the gloss.
        this._log(`translating "${span.seg.text}"…`);
        this._showLabel(rect, '…');
        const gloss = await this._sources.gloss.glossForHover(span.seg.text, baseText);
        if (generation !== this._generation) {
            return; // moved to another word / cleared before it resolved
        }
        if (gloss) {
            this._log(`"${span.seg.text}" → "${gloss}"`);
            this._showLabel(rect, gloss);
        } else if (this._label) {
            this._log(`no usable gloss for "${span.seg.text}" (translate failed / not label-length)`);
            // No usable gloss — hide the placeholder but KEEP the key so we don't
            // re-translate the same word on every mouse move.
            this._label.style.display = 'none';
        }
    }

    private _showLabel(rect: DOMRect, text: string): void {
        const el = this._ensureLabel();
        el.textContent = text;
        el.style.left = `${rect.left + rect.width / 2}px`;
        el.style.top = `${rect.top - GAP_ABOVE_WORD_PX}px`;
        el.style.display = 'block';
    }

    private _clearHover(): void {
        this._hoveredKey = '';
        this._generation++; // cancel any in-flight translation
        if (this._label) {
            this._label.style.display = 'none';
        }
    }

    private _ensureLabel(): HTMLDivElement {
        if (this._label) {
            return this._label;
        }
        const el = document.createElement('div');
        el.className = 'savi-gloss-hover';
        Object.assign(el.style, LABEL_STYLE);
        document.body.appendChild(el);
        this._label = el;
        return el;
    }
}
