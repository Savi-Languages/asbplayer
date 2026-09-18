import { SaviToken } from './daemon-client';
import { Box, fragmentBoxes, highlightBoxes, popupAnchor, rowBoxes, textExtent, tokenSpanAtPoint } from './hit-test';
import { SaviHoverDictionary } from './hover-dict';

const tok = (text: string, lemma?: string): SaviToken => ({ text, lemma });
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

// ── A fake layout ─────────────────────────────────────────────────────────
// jsdom lays nothing out, so `Range.getClientRects` is faked as a monospace
// grid: every character is CELL px wide, rows are ROW px apart, a glyph box is
// GLYPH px tall (leaving LEAD px of leading above and below), the text starts
// ORIGIN_Y down the viewport, and rows wrap every `cols` characters. That is
// enough to reproduce both things the caret got wrong: a point on either half
// of a glyph, and a word straddling a wrap.
const CELL = 10;
const ROW = 20;
const GLYPH = 12;
const LEAD = (ROW - GLYPH) / 2;
let cols = 100;
let originY = 0;

/** Position of (container, offset) in the document's text, walking text nodes
 *  in order. Element containers only ever come from `selectNodeContents`, so
 *  offset 0 means "before the first text inside" and anything else "after the
 *  last". */
function charIndex(container: Node, offset: number): number {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    let node: Node = container;
    let off = offset;
    if (container.nodeType !== Node.TEXT_NODE) {
        const inside = nodes.filter((t) => container.contains(t));
        if (offset === 0) {
            node = inside[0];
            off = 0;
        } else {
            node = inside[inside.length - 1];
            off = node.textContent!.length;
        }
    }
    let acc = 0;
    for (const t of nodes) {
        if (t === node) return acc + off;
        acc += t.textContent!.length;
    }
    return acc;
}

const fakeRects = function (this: Range): DOMRect[] {
    const s = charIndex(this.startContainer, this.startOffset);
    const e = charIndex(this.endContainer, this.endOffset);
    const rects: DOMRect[] = [];
    for (let i = s; i < e; ) {
        const row = Math.floor(i / cols);
        const rowEnd = Math.min(e, (row + 1) * cols);
        const left = (i % cols) * CELL;
        const top = originY + row * ROW + LEAD;
        const width = (rowEnd - i) * CELL;
        rects.push({
            left,
            top,
            width,
            height: GLYPH,
            right: left + width,
            bottom: top + GLYPH,
            x: left,
            y: top,
        } as DOMRect);
        i = rowEnd;
    }
    return rects;
};

beforeAll(() => {
    (Range.prototype as any).getClientRects = fakeRects;
});
afterAll(() => {
    delete (Range.prototype as any).getClientRects;
});
beforeEach(() => {
    cols = 100;
    originY = 0;
});

const glyphMidY = (row: number) => originY + row * ROW + LEAD + GLYPH / 2;

/** A subtitle line laid out by the fake, returned as the [data-track] span. */
function line(text: string): HTMLElement {
    document.body.innerHTML = `<div class="asbplayer-subtitles"><span data-track="0" id="line">${text}</span></div>`;
    return document.getElementById('line') as HTMLElement;
}

// 同棲(0-1) 中(2) の(3) 男性(4-5) が(6) — concatenates to 同棲中の男性が
const tokens = [tok('同棲', '同棲'), tok('中'), tok('の'), tok('男性', '男性'), tok('が')];
const pad = { x: 2, y: 3 };

describe('tokenSpanAtPoint', () => {
    it('gives the RIGHT half of a word’s last glyph to that word, not the next (the caret bug)', () => {
        const el = line('同棲中の男性が');
        // 棲 is char 1: x 10..20. The caret at x=17 is the gap after it → offset 2 → 中.
        expect(tokenSpanAtPoint(el, tokens, 17, glyphMidY(0), pad)?.token.text).toBe('同棲');
        expect(tokenSpanAtPoint(el, tokens, 12, glyphMidY(0), pad)?.token.text).toBe('同棲');
        // The particle の (char 3, x 30..40) on its right half stays の.
        expect(tokenSpanAtPoint(el, tokens, 38, glyphMidY(0), pad)?.token.text).toBe('の');
        // Exactly on the boundary belongs to the glyph that starts there.
        expect(tokenSpanAtPoint(el, tokens, 40, glyphMidY(0), pad)?.token.text).toBe('男性');
    });

    it('carries the char span (for the AI segmentation lookup) and the lemma', () => {
        const el = line('同棲中の男性が');
        const hit = tokenSpanAtPoint(el, tokens, 45, glyphMidY(0), pad);
        expect(hit).toMatchObject({ start: 4, end: 6, token: { text: '男性', lemma: '男性' } });
    });

    it('returns punctuation and gap tokens as-is — the caller decides', () => {
        const el = line('同棲、中');
        const t = [tok('同棲', '同棲'), tok('、'), tok('中')];
        expect(tokenSpanAtPoint(el, t, 25, glyphMidY(0), pad)?.token.text).toBe('、');
    });

    it('misses beside the text', () => {
        const el = line('同棲中の男性が');
        expect(tokenSpanAtPoint(el, tokens, 200, glyphMidY(0), pad)).toBeNull();
        expect(tokenSpanAtPoint(el, tokens, 5, 200, pad)).toBeNull();
    });

    describe('a word that wraps', () => {
        beforeEach(() => {
            cols = 5; // 男性 = chars 4,5 → 男 ends row 0, 性 starts row 1
        });

        it('has one box per row, and `hit` is the row the point is on', () => {
            const el = line('同棲中の男性が');
            const onRow0 = tokenSpanAtPoint(el, tokens, 45, glyphMidY(0), pad);
            expect(onRow0?.token.text).toBe('男性');
            expect(onRow0?.boxes).toEqual([box(40, LEAD, 10, GLYPH), box(0, ROW + LEAD, 10, GLYPH)]);
            expect(onRow0?.hit).toEqual(box(40, LEAD, 10, GLYPH));

            const onRow1 = tokenSpanAtPoint(el, tokens, 5, glyphMidY(1), pad);
            expect(onRow1?.token.text).toBe('男性');
            expect(onRow1?.hit).toEqual(box(0, ROW + LEAD, 10, GLYPH));
        });

        it('never hands a row-1 point to a row-0 word beneath the same x', () => {
            const el = line('同棲中の男性が');
            // x=5 on row 1 is 性; on row 0 it is 同.
            expect(tokenSpanAtPoint(el, tokens, 5, glyphMidY(1), pad)?.token.text).toBe('男性');
            expect(tokenSpanAtPoint(el, tokens, 5, glyphMidY(0), pad)?.token.text).toBe('同棲');
        });
    });

    describe('the leading between rows', () => {
        beforeEach(() => {
            cols = 5;
        });
        // Row 0 glyphs span y 4..16, row 1 y 24..36; the gap is 16..24.

        it('is dead with no vertical slack', () => {
            const el = line('同棲中の男性が');
            expect(tokenSpanAtPoint(el, tokens, 5, 20, { x: 2, y: 0 })).toBeNull();
        });

        it('lands on the nearer row when the slack covers half the leading', () => {
            const el = line('同棲中の男性が');
            const slack = { x: 2, y: 3, lineHeight: ROW }; // (20 − 12) / 2 = 4px each side
            expect(tokenSpanAtPoint(el, tokens, 5, 19, slack)?.token.text).toBe('同棲'); // row 0
            expect(tokenSpanAtPoint(el, tokens, 5, 21, slack)?.token.text).toBe('男性'); // row 1
        });

        it('prefers an exact glyph hit over a padded neighbour', () => {
            const el = line('同棲中の男性が');
            // y=15 is inside row 0's glyph box; row 1's padded box (20..40) does not reach it,
            // but even with generous slack the exact hit wins.
            expect(tokenSpanAtPoint(el, tokens, 5, 15, { x: 2, y: 30 })?.token.text).toBe('同棲');
        });
    });
});

describe('fragmentBoxes', () => {
    it('walks nested spans (the target-word decorator splits text nodes)', () => {
        document.body.innerHTML =
            '<div class="asbplayer-subtitles"><span data-track="0" id="line">同<span class="savi-target">棲中</span>の</span></div>';
        const el = document.getElementById('line') as HTMLElement;
        expect(fragmentBoxes(el, 0, 2)).toEqual([box(0, LEAD, 20, GLYPH)]);
        expect(fragmentBoxes(el, 1, 4)).toEqual([box(10, LEAD, 30, GLYPH)]);
    });

    it('is empty past the text', () => {
        expect(fragmentBoxes(line('あい'), 0, 5)).toEqual([]);
    });
});

describe('rowBoxes', () => {
    it('unions rects on the same row — an element’s border box overlapping its own text', () => {
        expect(rowBoxes([box(10, 0, 20, 16), box(10, 0, 10, 16), box(20, 0, 10, 16)])).toEqual([box(10, 0, 20, 16)]);
    });

    it('keeps rows apart and orders them top to bottom', () => {
        expect(rowBoxes([box(0, 20, 10, 16), box(40, 0, 10, 16)])).toEqual([box(40, 0, 10, 16), box(0, 20, 10, 16)]);
    });

    it('drops the zero-sized rect a wrap can leave behind', () => {
        expect(rowBoxes([box(50, 0, 0, 16), box(0, 20, 10, 16)])).toEqual([box(0, 20, 10, 16)]);
    });
});

describe('highlightBoxes', () => {
    it('pads each row and drops the trailing letter-spacing from every one', () => {
        const rows = [box(40, 4, 10, 12), box(0, 24, 10, 12)];
        expect(highlightBoxes(rows, 2.5)).toEqual([box(39, 1, 9.5, 18), box(-1, 21, 9.5, 18)]);
    });

    it('never goes negative on a box narrower than the spacing', () => {
        expect(highlightBoxes([box(0, 0, 1, 12)], 5)[0].width).toBe(0);
    });
});

describe('textExtent / popupAnchor', () => {
    it('spans every row of the cue', () => {
        cols = 5;
        originY = 500;
        expect(textExtent(line('同棲中の男性が'))).toEqual({ top: 504, bottom: 536 });
    });

    it('aims at the fragment horizontally and the whole cue vertically', () => {
        const hit = box(0, 524, 10, 12);
        expect(popupAnchor(hit, { top: 504, bottom: 536 })).toEqual(box(0, 504, 10, 32));
        expect(popupAnchor(hit, null)).toEqual(hit);
    });
});

// ── Through the hover dictionary ──────────────────────────────────────────
// The background is faked at the browser.runtime seam (tokenize + dict), and
// the popup is jsdom-sized (0×0), which makes its top edge easy to predict:
// above the cue, it sits at cue-top − gap(12) − arrow(7).
describe('SaviHoverDictionary hover — boxes and popup on a wrapped word', () => {
    const entries = [{ kanji: ['男性'], readings: ['だんせい'], senses: [{ pos: ['n'], glosses: ['man'] }] }];

    beforeEach(() => {
        cols = 5;
        originY = 500;
        (globalThis as any).browser = {
            runtime: {
                sendMessage: async (command: { message: { command: string; text?: string } }) => {
                    switch (command.message.command) {
                        case 'savi-tokenize':
                            return { tokens };
                        case 'savi-dict':
                            return { entries, kanji: [] };
                        default:
                            throw new Error(`unexpected ${command.message.command}`);
                    }
                },
            },
        };
    });

    afterEach(() => {
        delete (globalThis as any).browser;
    });

    const hover = (dict: SaviHoverDictionary, el: HTMLElement, x: number, y: number) =>
        (dict as any)._handleHover(el, x, y) as Promise<void>;
    const shownBoxes = () =>
        Array.from(document.querySelectorAll<HTMLElement>('.savi-dict-highlight'))
            .filter((el) => el.style.display !== 'none')
            .map((el) => [el.style.left, el.style.top, el.style.width, el.style.height]);
    const popupTop = () => (document.querySelector('.savi-dict-popup') as HTMLElement).style.top;

    it('boxes both rows of the word and puts the popup above the whole cue', async () => {
        const el = line('同棲中の男性が');
        const dict = new SaviHoverDictionary();
        await hover(dict, el, 5, glyphMidY(1)); // 性, on the second row
        // One outline per row: 男 at the end of row 0, 性 at the start of row 1
        // (each padded 1px sideways, 3px vertically).
        expect(shownBoxes()).toEqual([
            ['39px', '501px', '12px', '18px'],
            ['-1px', '521px', '12px', '18px'],
        ]);
        // Above the CUE (top 504), not above the hovered fragment (top 524) —
        // which would have parked the popup on the first row.
        expect(popupTop()).toBe(`${504 - 12 - 7}px`);
        expect((dict as any)._currentTerm).toBe('男性');
        dict.stop();
    });

    it('re-aims the popup when the same word is hovered on its other row', async () => {
        const el = line('同棲中の男性が');
        const dict = new SaviHoverDictionary();
        await hover(dict, el, 5, glyphMidY(1)); // 性
        const bridge = document.querySelector('.savi-dict-bridge') as HTMLElement;
        const before = [bridge.style.left, bridge.style.width];
        await hover(dict, el, 45, glyphMidY(0)); // 男 — same term, different fragment
        expect((dict as any)._currentTerm).toBe('男性');
        expect(shownBoxes()).toEqual([
            ['39px', '501px', '12px', '18px'],
            ['-1px', '521px', '12px', '18px'],
        ]);
        // The bridge follows the fragment under the cursor (its span starts at the popup's
        // left in jsdom, so only the width changes between x=0..10 and x=40..50).
        expect([bridge.style.left, bridge.style.width]).not.toEqual(before);
        dict.stop();
    });

    it('boxes the word whose last glyph is under the cursor’s right half', async () => {
        cols = 100;
        const el = line('同棲中の男性が');
        const dict = new SaviHoverDictionary();
        await hover(dict, el, 17, glyphMidY(0)); // right half of 棲
        expect((dict as any)._currentTerm).toBe('同棲');
        expect(shownBoxes()).toEqual([['-1px', '501px', '22px', '18px']]);
        dict.stop();
    });

    it('lets the box linger through the grace on punctuation instead of clearing at once', async () => {
        cols = 100;
        const el = line('同棲、中');
        const t = [tok('同棲', '同棲'), tok('、'), tok('中')];
        (globalThis as any).browser.runtime.sendMessage = async (command: { message: { command: string } }) =>
            command.message.command === 'savi-tokenize' ? { tokens: t } : { entries, kanji: [] };
        const dict = new SaviHoverDictionary();
        await hover(dict, el, 5, glyphMidY(0)); // 同棲
        expect(shownBoxes().length).toBe(1);
        await hover(dict, el, 25, glyphMidY(0)); // 、
        expect(shownBoxes().length).toBe(1); // still up — a hide is merely scheduled
        expect((dict as any)._hideTimer).toBeDefined();
        await hover(dict, el, 35, glyphMidY(0)); // 中 — the pending hide is cancelled
        expect((dict as any)._hideTimer).toBeUndefined();
        expect(shownBoxes()).toEqual([['29px', '501px', '12px', '18px']]);
        dict.stop();
    });
});
