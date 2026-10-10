import { resolveTargetEpisode } from './episode-resolver';
it('requires an exact unique show and verified episode, including Netflix S1:E2', async () => {
    const get = jest
        .fn()
        .mockResolvedValueOnce({ results: [{ tmdbId: 7, title: 'Dark' }] })
        .mockResolvedValueOnce({ show: { title: 'Dark' }, season: { episodes: [{ episodeNumber: 2, name: 'Lies' }] } });
    expect(await resolveTargetEpisode(get, 'Dark', 'S1:E2 Lies')).toEqual({
        mediaType: 'tv',
        tmdbId: 7,
        season: 1,
        episode: 2,
        title: 'Dark',
    });
    expect(get.mock.calls[1][0]).toBe('/v2/shows/7/season/1');
});
it('leaves ambiguous, missing and unrecognized episode labels unresolved', async () => {
    const get = jest.fn().mockResolvedValue({
        results: [
            { tmdbId: 1, title: 'Dark' },
            { tmdbId: 2, title: 'Dark' },
        ],
    });
    expect(await resolveTargetEpisode(get, 'Dark', 'S1:E2')).toBeNull();
    expect(await resolveTargetEpisode(get, undefined, 'A movie: Part 2')).toBeNull();
});
it('matches a named episode only inside the exact requested season', async () => {
    const get = jest
        .fn()
        .mockResolvedValueOnce({ results: [{ tmdbId: 1, title: 'Dark' }] })
        .mockResolvedValueOnce({ show: { title: 'Dark' }, season: { episodes: [{ episodeNumber: 2, name: 'Lies' }] } });
    expect((await resolveTargetEpisode(get, undefined, 'Dark: Season 1: Lies'))?.episode).toBe(2);
});
