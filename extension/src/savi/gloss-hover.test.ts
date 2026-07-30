import { baseRangeForSpan, baseTextOf, wordAtOffset, wordAtPoint } from './gloss-hover';
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
        const segs = segmentLine('el gato');
        expect(wordAtOffset(segs, 0)?.seg.text).toBe('el');
        const gato = wordAtOffset(segs, 4); // inside 'gato' (starts at index 3)
        expect(gato?.seg.text).toBe('gato');
        expect(gato).toMatchObject({ start: 3, end: 7 });
    });

    it('returns null on a gap (the space between words)', () => {
        expect(wordAtOffset(segmentLine('el gato'), 2)).toBeNull();
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
        expect(wordAtPoint(el, segmentLine('el gato'), 10, 10)).toBeNull();
    });
});

describe('baseRangeForSpan — rt-aware', () => {
    it('covers the base word, excluding its <rt> gloss (not "gatocat")', () => {
        const el = lineEl('quiero <ruby class="asb-gloss">gato<rt>cat</rt></ruby>');
        const base = baseTextOf(el); // 'quiero gato'
        const span = wordAtOffset(segmentLine(base), base.indexOf('gato'))!;
        const range = baseRangeForSpan(el, span.start, span.end);
        expect(range?.toString()).toBe('gato');
    });

    it('maps a span across plain text nodes', () => {
        const el = lineEl('el gato');
        const range = baseRangeForSpan(el, 3, 7);
        expect(range?.toString()).toBe('gato');
    });
});
