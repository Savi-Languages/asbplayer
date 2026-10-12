// Which subtitle word is under the cursor, and where its glyphs are — by
// GEOMETRY, one line fragment at a time.
//
// The hover dictionary used to ask the browser for the caret at the cursor
// (`caretRangeFromPoint`) and map that char offset to a token. Two things that
// gets wrong, both measured on a real subtitle line rather than assumed:
//
//   - A caret is an INSERTION POINT — the nearest gap between glyphs. On the
//     right half of a word's last glyph the nearest gap is the one after it, so
//     the offset resolved to the NEXT word: 16 of 23 characters on one Netflix
//     line handed their right half to the following token. Every word arrived
//     half a glyph early, single-character particles worst of all.
//   - A word that soft-wraps has a glyph box on each row. The union of those
//     (`getBoundingClientRect`) is a box spanning both rows and everything in
//     between — 269×77px for a two-character word — and the popup's arrow then
//     pointed at the empty middle of it.
//
// So: test the cursor against each token's laid-out glyph boxes, and keep the
// boxes. gloss-hover already does this for Spanish (`wordAtPoint`); this is the
// Japanese counterpart on the raw line text (there is no <rt> to skip here).
// Everything that touches a Range's geometry is guarded: jsdom has no layout,
// and the tests install a fake one.

import type { SaviToken } from './daemon-client';

/** A viewport-space box. Plain data, so the geometry is testable without a DOMRect. */
export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

export const boxRight = (b: Box): number => b.left + b.width;
export const boxBottom = (b: Box): number => b.top + b.height;

export interface TokenSpan {
    token: SaviToken;
    start: number;
    end: number;
}

/** The token whose `[start, start+len)` range contains `offset`, plus that
 *  span — tokens concatenate back to the line (the daemon emits gap tokens for
 *  any whitespace it would otherwise drop), so a running sum of surface lengths
 *  locates the word under a character offset. Pure — unit-tested without the
 *  DOM. Still the right tool for the AI segmentation, whose chunks are matched
 *  by char offset rather than by the cursor. */
export function tokenSpanAtOffset(tokens: SaviToken[], offset: number): TokenSpan | null {
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
 *  across nested text nodes (asbplayer may wrap a line in inner spans, and the
 *  target-word decorator splits them). Null if the span runs past the available
 *  text. */
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

const clientRects = (range: Range): Box[] => {
    try {
        return Array.from(range.getClientRects());
    } catch {
        return []; // no layout engine (jsdom) — nothing is laid out
    }
};

/** Union rects row by row: rects whose tops are within a pixel are one row.
 *  Chrome reports a text fragment per row, plus the border box of any element
 *  the range fully contains (a target-word span), which overlaps its own text
 *  fragment — so the union is what a row's glyphs actually cover. Zero-sized
 *  rects (a collapsed fragment at a wrap) are dropped. Rows come back top to
 *  bottom. */
export function rowBoxes(rects: Iterable<Box>): Box[] {
    const rows: Box[] = [];
    for (const r of rects) {
        if (r.width <= 0 || r.height <= 0) {
            continue;
        }
        const row = rows.find((b) => Math.abs(b.top - r.top) < 1);
        if (!row) {
            rows.push({ left: r.left, top: r.top, width: r.width, height: r.height });
            continue;
        }
        const left = Math.min(row.left, r.left);
        const right = Math.max(boxRight(row), boxRight(r));
        const top = Math.min(row.top, r.top);
        const bottom = Math.max(boxBottom(row), boxBottom(r));
        row.left = left;
        row.width = right - left;
        row.top = top;
        row.height = bottom - top;
    }
    return rows.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Whether two sets of boxes are the same rows in the same places, to within
 *  half a pixel — sub-pixel jitter is not a layout shift worth a re-place. */
export function boxesEqual(a: Box[], b: Box[] | null): boolean {
    if (!b || a.length !== b.length) {
        return false;
    }
    return a.every(
        (box, i) =>
            Math.abs(box.left - b[i].left) <= 0.5 &&
            Math.abs(box.top - b[i].top) <= 0.5 &&
            Math.abs(box.width - b[i].width) <= 0.5 &&
            Math.abs(box.height - b[i].height) <= 0.5
    );
}

/** The laid-out glyph boxes of chars `[start, end)` of `line`, one per row the
 *  span occupies (a word that wraps has two). Empty when nothing is laid out. */
export function fragmentBoxes(line: HTMLElement, start: number, end: number): Box[] {
    const range = rangeForCharSpan(line, start, end);
    return range ? rowBoxes(clientRects(range)) : [];
}

export interface HitSpan extends TokenSpan {
    /** The word's glyph boxes, one per row it occupies. */
    boxes: Box[];
    /** The one the point is in — what the popup should be aimed at. */
    hit: Box;
}

/** Slack for the second, forgiving pass of {@link tokenSpanAtPoint}. `x`/`y`
 *  are pixels; `lineHeight`, when known, widens `y` to half the row's leading
 *  (line-height minus the glyph box), so the gap between two wrapped rows still
 *  lands on the nearer row — as the old caret snap did. */
export interface HitPad {
    x: number;
    y: number;
    lineHeight?: number;
}

/** The token whose glyph boxes contain (x, y), with its boxes. Exact glyph
 *  boxes first, so a point on a word's last glyph is THAT word no matter which
 *  half of the glyph it is on (glyph boxes tile the row: a word's box ends
 *  where the next begins, letter-spacing included). Only when nothing contains
 *  the point exactly does a padded pass run, for the leading between rows and
 *  the odd pixel beside a glyph. Punctuation and gap tokens are returned like
 *  any other — the caller decides what deserves a popup. */
export function tokenSpanAtPoint(
    line: HTMLElement,
    tokens: SaviToken[],
    x: number,
    y: number,
    pad: HitPad
): HitSpan | null {
    const spans: Array<TokenSpan & { boxes: Box[] }> = [];
    let start = 0;
    for (const token of tokens) {
        const end = start + token.text.length;
        const boxes = fragmentBoxes(line, start, end);
        const hit = boxes.find((b) => x >= b.left && x < boxRight(b) && y >= b.top && y < boxBottom(b));
        if (hit) {
            return { token, start, end, boxes, hit };
        }
        spans.push({ token, start, end, boxes });
        start = end;
    }
    for (const span of spans) {
        const hit = span.boxes.find((b) => {
            const padY = Math.max(pad.y, pad.lineHeight === undefined ? 0 : (pad.lineHeight - b.height) / 2);
            return x >= b.left - pad.x && x <= boxRight(b) + pad.x && y >= b.top - padY && y <= boxBottom(b) + padY;
        });
        if (hit) {
            return { ...span, hit };
        }
    }
    return null;
}

/** The outline boxes for a word's glyph rows. Japanese cues carry
 *  letter-spacing, which every row's box includes as trailing space on the
 *  right — dropped so the box ends at the last glyph instead of reaching into
 *  the next word. A little horizontal room, a touch more vertical. */
export function highlightBoxes(boxes: Box[], trailing: number, padX = 1, padY = 3): Box[] {
    return boxes.map((b) => ({
        left: b.left - padX,
        top: b.top - padY,
        width: Math.max(0, b.width - trailing + padX * 2),
        height: b.height + padY * 2,
    }));
}

/** The vertical extent of everything laid out in `line` — the whole cue, all
 *  of its rows. Null when nothing is laid out. */
export function textExtent(line: HTMLElement): { top: number; bottom: number } | null {
    const range = document.createRange();
    try {
        range.selectNodeContents(line);
    } catch {
        return null;
    }
    let top = Infinity;
    let bottom = -Infinity;
    for (const r of clientRects(range)) {
        if (r.width <= 0 || r.height <= 0) {
            continue;
        }
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, boxBottom(r));
    }
    return top <= bottom ? { top, bottom } : null;
}

/** Where to aim the popup: the hovered row fragment horizontally (so the arrow
 *  points at the glyphs under the cursor) and the whole cue vertically (so the
 *  popup sits above — or below — every row of the cue, never on top of the
 *  cue's other row when the word is on a lower one). */
export function popupAnchor(hit: Box, extent: { top: number; bottom: number } | null): Box {
    if (!extent) {
        return hit;
    }
    return { left: hit.left, width: hit.width, top: extent.top, height: extent.bottom - extent.top };
}
