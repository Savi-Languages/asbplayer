import { subtitleSourceMatchesUrl } from './subtitle-source';

describe('subtitle source identity', () => {
    it('ignores tracking queries only for the same Netflix watch page', () => {
        expect(
            subtitleSourceMatchesUrl(
                'https://www.netflix.com/watch/111?trackId=old',
                'https://www.netflix.com/watch/111?tctx=new'
            )
        ).toBe(true);
    });
    it.each([
        ['https://www.netflix.com/watch/111', 'https://www.netflix.com/watch/222'],
        ['https://www.netflix.com/watch/111', 'https://other.netflix.com/watch/111'],
        ['https://notnetflix.com/watch/111?a=1', 'https://notnetflix.com/watch/111?a=2'],
        ['https://www.youtube.com/watch?v=1', 'https://www.youtube.com/watch?v=2'],
        ['https://www.netflix.com/browse?a=1', 'https://www.netflix.com/browse?a=2'],
        ['bad-url', 'another-bad-url'],
    ])('rejects unrelated sources %s → %s', (source, current) => {
        expect(subtitleSourceMatchesUrl(source, current)).toBe(false);
    });
});
