import { cacheKey, pruneByRecency } from './persistent-cache';

describe('cacheKey', () => {
    it('is deterministic and distinguishes different text', () => {
        expect(cacheKey('ja', 'abc')).toBe(cacheKey('ja', 'abc'));
        expect(cacheKey('ja', 'abc')).not.toBe(cacheKey('ja', 'abd'));
    });
});

describe('pruneByRecency', () => {
    it('keeps the most recent entries up to max, dropping the oldest', () => {
        const map: Record<string, { t: number }> = {
            a: { t: 1 },
            b: { t: 5 },
            c: { t: 3 },
            d: { t: 9 },
        };
        pruneByRecency(map, 2);
        expect(Object.keys(map).sort()).toEqual(['b', 'd']); // highest t survive
    });

    it('is a no-op at or under the cap', () => {
        const map = { a: { t: 1 }, b: { t: 2 } };
        pruneByRecency(map, 5);
        expect(Object.keys(map).sort()).toEqual(['a', 'b']);
    });
});
