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
            targetLanguage: 'es',
        });
    });

    it('matches on the primary subtag, so es-419 counts as es', () => {
        expect(decideLanguageGate({ spokenLanguage: 'es-419', targetLanguage: 'es' })).toEqual({
            active: true,
            reason: 'match',
            targetLanguage: 'es',
        });
        expect(decideLanguageGate({ spokenLanguage: 'es', targetLanguage: 'es-ES' })).toEqual({
            active: true,
            reason: 'match',
            targetLanguage: 'es-ES',
        });
    });

    it('deactivates on a positive mismatch', () => {
        expect(decideLanguageGate({ spokenLanguage: 'en', targetLanguage: target })).toEqual({
            active: false,
            reason: 'mismatch',
            targetLanguage: 'es',
        });
    });

    // Fail open: savi going silent by accident costs real exposure, and the
    // user cannot see that it happened. Noise is recoverable; silence is not.
    it('stays active when the spoken language is unknown', () => {
        expect(decideLanguageGate({ spokenLanguage: undefined, targetLanguage: target })).toEqual({
            active: true,
            reason: 'unknown',
            targetLanguage: 'es',
        });
    });

    it('stays active when no target language is configured', () => {
        expect(decideLanguageGate({ spokenLanguage: 'en', targetLanguage: '' })).toEqual({
            active: true,
            reason: 'unknown',
            targetLanguage: '',
        });
        // Whitespace normalizes away, so the carried language is '' too — the
        // binding compares these strings to decide whether to re-arm.
        expect(decideLanguageGate({ spokenLanguage: 'en', targetLanguage: '   ' })).toEqual({
            active: true,
            reason: 'unknown',
            targetLanguage: '',
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
        ).toEqual({ active: false, reason: 'muted', targetLanguage: 'es' });
    });

    it('mutes only the episode named, not its neighbours', () => {
        expect(
            decideLanguageGate({
                spokenLanguage: undefined,
                targetLanguage: target,
                episodeId: 'youtube:def',
                mutedEpisodes: ['youtube:abc'],
            })
        ).toEqual({ active: true, reason: 'unknown', targetLanguage: 'es' });
    });

    it('ignores the mute list when the episode has no id', () => {
        expect(
            decideLanguageGate({
                spokenLanguage: undefined,
                targetLanguage: target,
                episodeId: undefined,
                mutedEpisodes: ['youtube:abc'],
            })
        ).toEqual({ active: true, reason: 'unknown', targetLanguage: 'es' });
    });
});

// SV-38: the verdict carries the language it was reached ABOUT, because the
// binding cannot otherwise tell a no-op re-sync from a sign-in.
describe('the verdict carries its target language', () => {
    it('changes when the account language arrives, even though the verdict does not', () => {
        // This is exactly what signing in looks like from the gate's side. The
        // gate fails open BOTH before (no target configured) and after (no
        // spoken-language signal), so `active` and `reason` are identical —
        // only `targetLanguage` moves. The binding compares it to decide
        // whether to re-arm glossing; comparing `active` alone was why a
        // sign-in needed a page reload.
        const signedOut = decideLanguageGate({ spokenLanguage: undefined, targetLanguage: '' });
        const signedIn = decideLanguageGate({ spokenLanguage: undefined, targetLanguage: 'fr' });

        expect(signedOut.active).toBe(signedIn.active);
        expect(signedOut.reason).toBe(signedIn.reason);
        expect(signedOut.targetLanguage).toBe('');
        expect(signedIn.targetLanguage).toBe('fr');
    });

    it('reports the configured language verbatim, not the primary subtag', () => {
        // The binding only needs equality, and keeping the raw value means a
        // change from es to es-419 still counts as a change worth re-arming on.
        expect(decideLanguageGate({ spokenLanguage: 'es', targetLanguage: 'es-419' }).targetLanguage).toBe('es-419');
    });
});
