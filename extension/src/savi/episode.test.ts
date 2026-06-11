import { episodeIdForTitle, slugify } from './episode';

describe('slugify', () => {
    it('lowercases and dashes Latin titles', () => {
        expect(slugify('Watch Better Call Saul | Netflix')).toBe('watch-better-call-saul-netflix');
    });

    it('keeps unicode letters so Japanese titles survive', () => {
        expect(slugify('名探偵コナン 第1話')).toBe('名探偵コナン-第1話');
    });

    it('never produces path separators or traversal sequences', () => {
        const slug = slugify('../..\\evil/title .. here');
        expect(slug).not.toContain('/');
        expect(slug).not.toContain('\\');
        expect(slug).not.toContain('..');
    });

    it('falls back to "episode" when nothing survives', () => {
        expect(slugify('!!! ###')).toBe('episode');
        expect(slugify('')).toBe('episode');
    });

    it('caps very long titles', () => {
        expect(slugify('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    });
});

describe('episodeIdForTitle', () => {
    it('appends a date-time suffix so same-day same-title captures cannot collide', () => {
        const at = new Date(2026, 5, 10, 21, 5); // 2026-06-10 21:05 local
        expect(episodeIdForTitle('Watch Dark | Netflix', at)).toBe('watch-dark-netflix-20260610-2105');
    });

    it('produces ids that satisfy the daemon id rules', () => {
        const id = episodeIdForTitle('日本語/タイトル..テスト', new Date(2026, 0, 2, 3, 4));
        expect(id.length).toBeGreaterThan(0);
        expect(id).not.toContain('/');
        expect(id).not.toContain('\\');
        expect(id).not.toContain('..');
    });
});
