import { decideLanguageGate, spokenLanguageFromTracks } from './language-gate';

describe('spokenLanguageFromTracks', () => {
    // YouTube marks its speech-recognition track kind:"asr". That track's
    // language is what is actually being SPOKEN; every other track is merely a
    // subtitle that exists — including the auto-translated ones YouTube offers
    // in dozens of languages, which is exactly why "a track matches" is not a
    // usable signal.
    it('takes the language of the asr track', () => {
        const tracks = [
            { languageCode: 'es', kind: 'standard' },
            { languageCode: 'en', kind: 'asr' },
        ];
        expect(spokenLanguageFromTracks(tracks)).toBe('en');
    });

    it('is undefined when no track is auto-generated', () => {
        const tracks = [{ languageCode: 'es' }, { languageCode: 'fr', kind: 'standard' }];
        expect(spokenLanguageFromTracks(tracks)).toBeUndefined();
    });

    it('is undefined for an empty or absent track list', () => {
        expect(spokenLanguageFromTracks([])).toBeUndefined();
        expect(spokenLanguageFromTracks(undefined)).toBeUndefined();
    });

    it('ignores an asr track with no language', () => {
        expect(spokenLanguageFromTracks([{ kind: 'asr' }])).toBeUndefined();
    });

    it('survives malformed entries rather than throwing', () => {
        // A parse failure must degrade to "unknown", never take savi down.
        expect(spokenLanguageFromTracks([null, 'nonsense', { kind: 'asr', languageCode: 'ja' }])).toBe('ja');
    });
});

describe('decideLanguageGate', () => {
    const target = 'es';

    it('activates when the spoken language matches the target', () => {
        expect(decideLanguageGate({ spokenLanguage: 'es', targetLanguage: target })).toEqual({
            active: true,
            reason: 'match',
        });
    });

    it('matches on the primary subtag, so es-419 counts as es', () => {
        expect(decideLanguageGate({ spokenLanguage: 'es-419', targetLanguage: 'es' })).toEqual({
            active: true,
            reason: 'match',
        });
        expect(decideLanguageGate({ spokenLanguage: 'es', targetLanguage: 'es-ES' })).toEqual({
            active: true,
            reason: 'match',
        });
    });

    it('deactivates on a positive mismatch', () => {
        expect(decideLanguageGate({ spokenLanguage: 'en', targetLanguage: target })).toEqual({
            active: false,
            reason: 'mismatch',
        });
    });

    // Fail open: savi going silent by accident costs real exposure, and the
    // user cannot see that it happened. Noise is recoverable; silence is not.
    it('stays active when the spoken language is unknown', () => {
        expect(decideLanguageGate({ spokenLanguage: undefined, targetLanguage: target })).toEqual({
            active: true,
            reason: 'unknown',
        });
    });

    it('stays active when no target language is configured', () => {
        expect(decideLanguageGate({ spokenLanguage: 'en', targetLanguage: '' })).toEqual({
            active: true,
            reason: 'unknown',
        });
        expect(decideLanguageGate({ spokenLanguage: 'en', targetLanguage: '   ' })).toEqual({
            active: true,
            reason: 'unknown',
        });
    });

    it('deactivates a muted episode whatever the language says', () => {
        expect(
            decideLanguageGate({
                spokenLanguage: 'es',
                targetLanguage: target,
                episodeId: 'youtube:abc',
                mutedEpisodes: ['youtube:abc'],
            })
        ).toEqual({ active: false, reason: 'muted' });
    });

    it('mutes only the episode named, not its neighbours', () => {
        expect(
            decideLanguageGate({
                spokenLanguage: undefined,
                targetLanguage: target,
                episodeId: 'youtube:def',
                mutedEpisodes: ['youtube:abc'],
            })
        ).toEqual({ active: true, reason: 'unknown' });
    });

    it('ignores the mute list when the episode has no id', () => {
        expect(
            decideLanguageGate({
                spokenLanguage: undefined,
                targetLanguage: target,
                episodeId: undefined,
                mutedEpisodes: ['youtube:abc'],
            })
        ).toEqual({ active: true, reason: 'unknown' });
    });
});
