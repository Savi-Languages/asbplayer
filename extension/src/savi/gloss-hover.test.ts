import { baseRangeForSpan, baseTextOf, firstLineContaining, wordAtOffset, wordAtPoint } from './gloss-hover';
import { segmentLine } from './gloss';

const lineEl = (html: string): HTMLElement => {
    const el = document.createElement('span');
    el.setAttribute('data-track', '0');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
};

describe('wordAtOffset', () => {
    it('finds the word segment containing the offset, with its span', () => {
        const segs = segmentLine('el gato', 'es');
        expect(wordAtOffset(segs, 0)?.seg.text).toBe('el');
        const gato = wordAtOffset(segs, 4); // inside 'gato' (starts at index 3)
        expect(gato?.seg.text).toBe('gato');
        expect(gato).toMatchObject({ start: 3, end: 7 });
    });

    it('returns null on a gap (the space between words)', () => {
        expect(wordAtOffset(segmentLine('el gato', 'es'), 2)).toBeNull();
    });
});

describe('baseTextOf — rt-aware', () => {
    it('excludes <rt> gloss labels, recovering the original line', () => {
        // A word already glossed by the always-on pass carries its label in <rt>.
        const el = lineEl('quiero <ruby class="asb-gloss">gato<rt>cat</rt></ruby>');
        expect(baseTextOf(el)).toBe('quiero gato');
    });

    it('is the plain text when there are no ruby glosses', () => {
        expect(baseTextOf(lineEl('quiero un gato'))).toBe('quiero un gato');
    });
});

describe('wordAtPoint', () => {
    it('returns null when the word has no laid-out rects (jsdom has no layout)', () => {
        // The geometric lookup depends on real layout; without it (tests) it
        // degrades to null rather than throwing. Live behavior is verified in-browser.
        const el = lineEl('el gato');
        expect(wordAtPoint(el, segmentLine('el gato', 'es'), 10, 10)).toBeNull();
    });
});

describe('baseRangeForSpan — rt-aware', () => {
    it('covers the base word, excluding its <rt> gloss (not "gatocat")', () => {
        const el = lineEl('quiero <ruby class="asb-gloss">gato<rt>cat</rt></ruby>');
        const base = baseTextOf(el); // 'quiero gato'
        const span = wordAtOffset(segmentLine(base, 'es'), base.indexOf('gato'))!;
        const range = baseRangeForSpan(el, span.start, span.end);
        expect(range?.toString()).toBe('gato');
    });

    it('maps a span across plain text nodes', () => {
        const el = lineEl('el gato');
        const range = baseRangeForSpan(el, 3, 7);
        expect(range?.toString()).toBe('gato');
    });
});

// SV-44. Hover went dead in fullscreen on a bare `file://` video — no label AND
// no end-of-line pause, because both hang off the same line detection.
//
// The cause is that hit-testing goes blind there: the subtitle overlay has to
// live in the browser's TOP LAYER to paint over a fullscreened <video> at all,
// and the top layer is reported by neither `event.target` nor
// `elementsFromPoint` (measured against a real fullscreened video, where
// `elementsFromPoint` at the subtitle's own centre returns the video). The
// mouse events still arrive and the rects are still real, so the line is found
// by testing boxes instead of asking the browser.
describe('firstLineContaining', () => {
    const at = (x: number, y: number, w: number, h: number): HTMLElement => {
        const el = document.createElement('span');
        // jsdom does not lay out, so the rect is supplied.
        el.getBoundingClientRect = () =>
            ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }) as DOMRect;
        return el;
    };
    const anyLine = () => true;

    it('finds the line whose box contains the cursor', () => {
        const a = at(0, 0, 100, 20);
        const b = at(0, 100, 100, 20);
        expect(firstLineContaining([a, b], 50, 110, anyLine)).toBe(b);
    });

    it('is null when the cursor is outside every line', () => {
        expect(firstLineContaining([at(0, 0, 100, 20)], 500, 500, anyLine)).toBeNull();
    });

    it('counts the edges as inside, so a cursor on the last pixel still hovers', () => {
        const a = at(10, 10, 100, 20);
        expect(firstLineContaining([a], 10, 10, anyLine)).toBe(a);
        expect(firstLineContaining([a], 110, 30, anyLine)).toBe(a);
    });

    it('skips zero-sized boxes rather than matching them at the origin', () => {
        // A hidden or unlaid-out line reports 0x0 at 0,0 — which would
        // otherwise "contain" a cursor at the top-left corner.
        const hidden = at(0, 0, 0, 0);
        expect(firstLineContaining([hidden], 0, 0, anyLine)).toBeNull();
    });

    it('respects the caller’s verdict on what is really a subtitle', () => {
        // asbplayer's notification banner has the same DOM shape as a line, so
        // geometry alone must not decide.
        const banner = at(0, 0, 100, 20);
        const line = at(0, 0, 100, 20);
        expect(firstLineContaining([banner, line], 50, 10, (el) => el === line)).toBe(line);
    });

    it('is null for no candidates at all', () => {
        expect(firstLineContaining([], 5, 5, anyLine)).toBeNull();
    });
});
