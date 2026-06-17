import { tokenAtOffset } from './hover-dict';
import { SaviToken } from './daemon-client';

const tok = (text: string, lemma?: string): SaviToken => ({ text, lemma });

describe('tokenAtOffset', () => {
    // 容疑(0-1) 者(2) は(3) 黙秘(4-5) を(6) — concatenates to 容疑者は黙秘を
    const tokens = [tok('容疑', '容疑'), tok('者'), tok('は'), tok('黙秘', '黙秘'), tok('を')];

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
