import { VideoDataSubtitleTrack } from '@project/common';
import { parseShowQuery, primarySubtag, selectNativeTrack, selectTrackForLanguage } from './track-select';

const track = (id: string, language: string | undefined, label = id, extra: Partial<VideoDataSubtitleTrack> = {}) =>
    ({ id, language, label, url: `https://sub/${id}`, extension: 'nfimsc', ...extra }) as VideoDataSubtitleTrack;

const emptyTrack = track('-', '-', 'None', { url: '-' });

describe('primarySubtag', () => {
    it('takes the subtag before the first dash, lowercased', () => {
        expect(primarySubtag('es-419')).toBe('es');
        expect(primarySubtag('ES-ES')).toBe('es');
        expect(primarySubtag('ja')).toBe('ja');
        expect(primarySubtag(' pt-BR ')).toBe('pt');
    });
});

describe('selectTrackForLanguage', () => {
    it('returns undefined when the target language is empty or missing', () => {
        const subs = [track('1', 'es'), track('2', 'en')];
        expect(selectTrackForLanguage(subs, '')).toBeUndefined();
        expect(selectTrackForLanguage(subs, undefined)).toBeUndefined();
    });

    it('returns undefined when there are no subtitles', () => {
        expect(selectTrackForLanguage(undefined, 'es')).toBeUndefined();
        expect(selectTrackForLanguage([], 'es')).toBeUndefined();
    });

    it('returns undefined when no track shares the target primary subtag', () => {
        const subs = [track('1', 'en'), track('2', 'pt-BR'), emptyTrack];
        expect(selectTrackForLanguage(subs, 'es')).toBeUndefined();
    });

    it('matches by primary subtag and prefers the plain non-CC variant', () => {
        const subs = [track('1', 'es-419'), track('2', 'es'), track('3', 'es-CC'), track('4', 'en')];
        expect(selectTrackForLanguage(subs, 'es')?.id).toBe('2');
    });

    it('prefers an exact regional match when the target is regional', () => {
        const subs = [track('1', 'es'), track('2', 'es-419'), track('3', 'es-ES')];
        expect(selectTrackForLanguage(subs, 'es-419')?.id).toBe('2');
    });

    it('falls back to the first non-CC regional variant when target is generic', () => {
        const subs = [track('1', 'es-419'), track('2', 'es-ES')];
        expect(selectTrackForLanguage(subs, 'es')?.id).toBe('1');
    });

    it('prefers a non-CC track even when the CC track comes first', () => {
        const subs = [track('1', 'es-CC', 'Spanish [CC]'), track('2', 'es')];
        expect(selectTrackForLanguage(subs, 'es')?.id).toBe('2');
    });

    it('detects CC via the [CC] label as well as the -cc suffix', () => {
        const subs = [track('1', 'es', 'Spanish [CC]'), track('2', 'es', 'Spanish')];
        expect(selectTrackForLanguage(subs, 'es')?.id).toBe('2');
    });

    it('returns the CC track when it is the only match', () => {
        const subs = [track('1', 'es-CC'), track('2', 'en')];
        expect(selectTrackForLanguage(subs, 'es')?.id).toBe('1');
    });

    it('is case-insensitive on the target', () => {
        const subs = [track('1', 'ja'), track('2', 'en')];
        expect(selectTrackForLanguage(subs, 'JA')?.id).toBe('1');
    });

    it('skips the empty placeholder track', () => {
        const subs = [emptyTrack, track('2', 'es')];
        expect(selectTrackForLanguage(subs, 'es')?.id).toBe('2');
    });
});

describe('parseShowQuery', () => {
    it('splits a Netflix episode name into query + season/episode', () => {
        expect(parseShowQuery('Dark S01E03 Secrets')).toEqual({
            query: 'Dark',
            seasonNumber: 1,
            episodeNumber: 3,
        });
    });

    it('handles lowercase and separators between s and e', () => {
        expect(parseShowQuery('La Casa de Papel s2.e08')).toEqual({
            query: 'La Casa de Papel',
            seasonNumber: 2,
            episodeNumber: 8,
        });
    });

    it('treats a name without a marker as a film query', () => {
        expect(parseShowQuery('Roma')).toEqual({ query: 'Roma' });
    });

    it('falls back to the full name when the marker is at the start', () => {
        expect(parseShowQuery('S01E01')).toEqual({ query: 'S01E01', seasonNumber: 1, episodeNumber: 1 });
    });
});

describe('selectNativeTrack', () => {
    // The real shape of the video that prompted this: a Japanese learner whose
    // native language is English, on a video carrying human tracks for both.
    const subs = [track('ja', 'ja', 'Japanese'), track('en', 'en', 'English'), track('fr', 'fr', 'French')];
    const jaTrack = subs[0];

    it('picks the native track alongside the target', () => {
        expect(selectNativeTrack(subs, 'en', 'ja', jaTrack)).toBe(subs[1]);
    });

    it('is off when no native language is configured', () => {
        expect(selectNativeTrack(subs, '', 'ja', jaTrack)).toBeUndefined();
        expect(selectNativeTrack(subs, '   ', 'ja', jaTrack)).toBeUndefined();
        expect(selectNativeTrack(subs, undefined, 'ja', jaTrack)).toBeUndefined();
    });

    it('refuses to duplicate the target line when both languages match', () => {
        // Studying the language you already speak: one line, not the same twice.
        expect(selectNativeTrack(subs, 'en', 'en-US', subs[1])).toBeUndefined();
        expect(selectNativeTrack(subs, 'ja', 'ja', jaTrack)).toBeUndefined();
    });

    it('never returns the very track already loaded as the target', () => {
        // Defensive. For well-formed input the language guard above already
        // makes this unreachable: a native selection and a target selection
        // resolve to different primary subtags, so they cannot be the same
        // object. It stands guard against a mislabelled track, which would
        // otherwise put the same line on screen twice.
        const mislabelled = [track('en', 'en', 'English')];
        expect(selectNativeTrack(mislabelled, 'en', 'de', mislabelled[0])).toBeUndefined();
    });

    it('returns undefined when the video has no track in the native language', () => {
        expect(selectNativeTrack(subs, 'de', 'ja', jaTrack)).toBeUndefined();
        expect(selectNativeTrack([], 'en', 'ja', undefined)).toBeUndefined();
        expect(selectNativeTrack(undefined, 'en', 'ja', undefined)).toBeUndefined();
    });

    it('matches on primary subtag, like the target selector', () => {
        const regional = [track('ja', 'ja'), track('gb', 'en-GB', 'English (UK)')];
        expect(selectNativeTrack(regional, 'en', 'ja', regional[0])).toBe(regional[1]);
    });

    it('skips the None placeholder', () => {
        expect(selectNativeTrack([track('ja', 'ja'), emptyTrack], 'en', 'ja', undefined)).toBeUndefined();
    });

    it('prefers a non-CC native track, inheriting the target ranking', () => {
        const withCc = [track('ja', 'ja'), track('encc', 'en', 'English [CC]'), track('en', 'en', 'English')];
        expect(selectNativeTrack(withCc, 'en', 'ja', withCc[0])).toBe(withCc[2]);
    });
});
