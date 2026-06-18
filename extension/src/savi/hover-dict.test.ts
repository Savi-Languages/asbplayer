import { lookupTermFor, rangeForCharSpan, tokenAtOffset, tokenSpanAtOffset } from './hover-dict';
import { SaviToken } from './daemon-client';

const tok = (text: string, lemma?: string): SaviToken => ({ text, lemma });

// 容疑(0-1) 者(2) は(3) 黙秘(4-5) を(6) — concatenates to 容疑者は黙秘を
const tokens = [tok('容疑', '容疑'), tok('者'), tok('は'), tok('黙秘', '黙秘'), tok('を')];

describe('tokenAtOffset', () => {
    it('finds the token whose range contains the offset', () => {
        expect(tokenAtOffset(tokens, 0)?.text).toBe('容疑');
        expect(tokenAtOffset(tokens, 1)?.text).toBe('容疑');
        expect(tokenAtOffset(tokens, 2)?.text).toBe('者');
        expect(tokenAtOffset(tokens, 3)?.text).toBe('は');
        expect(tokenAtOffset(tokens, 4)?.text).toBe('黙秘');
        expect(tokenAtOffset(tokens, 5)?.text).toBe('黙秘');
        expect(tokenAtOffset(tokens, 6)?.text).toBe('を');
    });

    it('returns null past the end', () => {
        expect(tokenAtOffset(tokens, 7)).toBeNull();
        expect(tokenAtOffset([], 0)).toBeNull();
    });

    it('carries the lemma only for content words (drives the lookup)', () => {
        expect(tokenAtOffset(tokens, 4)?.lemma).toBe('黙秘');
        expect(tokenAtOffset(tokens, 2)?.lemma).toBeUndefined();
    });
});

describe('tokenSpanAtOffset', () => {
    it('returns the token plus its [start, end) span (drives the highlight box)', () => {
        expect(tokenSpanAtOffset(tokens, 0)).toEqual({ token: tokens[0], start: 0, end: 2 });
        expect(tokenSpanAtOffset(tokens, 1)).toEqual({ token: tokens[0], start: 0, end: 2 });
        expect(tokenSpanAtOffset(tokens, 2)).toEqual({ token: tokens[1], start: 2, end: 3 });
        expect(tokenSpanAtOffset(tokens, 4)).toEqual({ token: tokens[3], start: 4, end: 6 });
        expect(tokenSpanAtOffset(tokens, 6)).toEqual({ token: tokens[4], start: 6, end: 7 });
    });

    it('returns null past the end', () => {
        expect(tokenSpanAtOffset(tokens, 7)).toBeNull();
        expect(tokenSpanAtOffset([], 0)).toBeNull();
    });

    it('aligns across a gap (space) token so post-space words map correctly', () => {
        // 思う(0-1) [space](2) です(3-4) — the daemon's gap token keeps offsets honest.
        const withGap = [tok('思う', '思う'), tok(' '), tok('です')];
        expect(tokenSpanAtOffset(withGap, 0)).toEqual({ token: withGap[0], start: 0, end: 2 });
        expect(tokenSpanAtOffset(withGap, 2)).toEqual({ token: withGap[1], start: 2, end: 3 });
        expect(tokenSpanAtOffset(withGap, 3)).toEqual({ token: withGap[2], start: 3, end: 5 });
    });
});

describe('lookupTermFor', () => {
    it('uses the lemma to un-inflect verbs/adjectives', () => {
        expect(lookupTermFor(tok('続け', '続ける'))).toBe('続ける');
        expect(lookupTermFor(tok('国立', '国立'))).toBe('国立');
    });

    it('falls back to the surface for words with no lemma (the しかし bug)', () => {
        // Conjunctions/pronouns/proper nouns are not "reportable", so they
        // carry no lemma — but they ARE in the dictionary. Look up the surface.
        expect(lookupTermFor(tok('しかし'))).toBe('しかし');
        expect(lookupTermFor(tok('そこ'))).toBe('そこ');
        expect(lookupTermFor(tok('東京'))).toBe('東京');
    });
});

describe('rangeForCharSpan', () => {
    it('maps a char span to a Range, walking across nested text nodes', () => {
        document.body.innerHTML = '<span class="line"><span>変形</span>性関節症</span>';
        const root = document.querySelector('.line') as HTMLElement;
        expect(rangeForCharSpan(root, 0, 2)?.toString()).toBe('変形');
        expect(rangeForCharSpan(root, 2, 6)?.toString()).toBe('性関節症');
        expect(rangeForCharSpan(root, 4, 6)?.toString()).toBe('節症');
        // A single character mid-line.
        expect(rangeForCharSpan(root, 3, 4)?.toString()).toBe('関');
    });

    it('returns null when the span runs past the available text', () => {
        document.body.innerHTML = '<span class="line">あい</span>';
        const root = document.querySelector('.line') as HTMLElement;
        expect(rangeForCharSpan(root, 0, 5)).toBeNull();
    });
});
