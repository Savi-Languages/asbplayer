// Integration test for the SV-8 savi auto-load glue inside VideoDataSyncController.
// The controller is heavily coupled to Binding/UiFrame/page delegates, so we mock
// those out and exercise the real `_trySaviAutoLoad` path end to end: it fetches
// the roaming target language (fresh from the background, cache as fallback),
// selects the matching detected track (Path A), fetches its subtitle bytes, and
// hands them to Binding.loadSubtitles — or, when no track matches, asks the
// background to fetch from OpenSubtitles (Path B) — and records the language for
// savi capture.

const fakeFrame = { hidden: true, clientIfLoaded: undefined };

jest.mock('../services/binding', () => ({ __esModule: true, default: class {} }));
jest.mock('../services/ui-frame', () => ({
    __esModule: true,
    default: class {},
    uiFrameForHtml: () => fakeFrame,
}));
let pageKey = 'netflix';
jest.mock('../services/pages', () => ({
    currentPageDelegate: async () => ({
        isVideoPage: () => true,
        canAutoSync: () => false,
        config: { key: pageKey },
    }),
}));
jest.mock('../services/localization-fetcher', () => ({ fetchLocalization: async () => ({}) }));
jest.mock('@/services/extension-global-state-provider', () => ({
    ExtensionGlobalStateProvider: class {
        async get() {
            return {};
        }
        async set() {}
    },
}));
jest.mock('@/services/tutorial', () => ({ isOnTutorialPage: () => false }));
jest.mock('@/pages/util', () => ({ extractExtension: (_u: string, e: string) => e }));
jest.mock('@/savi/cloud-settings', () => ({ getCachedRoamingSettings: jest.fn() }));

import VideoDataSyncController from './video-data-sync-controller';
import { getCachedRoamingSettings } from '@/savi/cloud-settings';
import { resetMutedEpisodesMemo } from '@/savi/muted-episodes';

const roamingCacheMock = getCachedRoamingSettings as jest.Mock;

const track = (id: string, language: string, label: string) => ({
    id,
    language,
    label,
    url: `https://sub/${id}.vtt`,
    extension: 'nfimsc',
});

describe('VideoDataSyncController savi auto-load (SV-8)', () => {
    let loadSubtitles: jest.Mock;
    let getSingle: jest.Mock;
    let settingsSet: jest.Mock;
    let sendMessage: jest.Mock;
    let controller: any;
    // Replies the background gives for each command the controller sends.
    let roamingResponse: any;
    let openSubtitlesResponse: any;
    let applySaviLanguageGate: jest.Mock;

    const makeController = () =>
        new VideoDataSyncController(
            { loadSubtitles, settings: { set: settingsSet }, applySaviLanguageGate } as any,
            { getSingle } as any
        );

    const opensubtitlesCall = () =>
        sendMessage.mock.calls.find((c) => c[0]?.message?.command === 'savi-opensubtitles-fetch');

    beforeEach(() => {
        loadSubtitles = jest.fn();
        getSingle = jest.fn().mockResolvedValue(true); // saviAutoLoadSubtitles
        settingsSet = jest.fn().mockResolvedValue(undefined);
        roamingResponse = { targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: '' };
        openSubtitlesResponse = { ok: false };
        sendMessage = jest.fn(async (cmd: any) => {
            const command = cmd?.message?.command;
            if (command === 'savi-roaming-settings') return roamingResponse;
            if (command === 'savi-opensubtitles-fetch') return openSubtitlesResponse;
            return undefined;
        });
        roamingCacheMock.mockReset();
        roamingCacheMock.mockResolvedValue({ targetLanguage: '', openSubtitlesApiKey: '' });
        applySaviLanguageGate = jest.fn();
        pageKey = 'netflix'; // per-test override; YouTube skips OpenSubtitles
        // The mute list keeps an in-process mirror; drop it so tests don't
        // inherit each other's storage view.
        resetMutedEpisodesMemo();
        // storage.local backs the muted-episode list the gate consults.
        (globalThis as any).browser = {
            runtime: { getURL: (p: string) => p, sendMessage },
            storage: { local: { get: async () => ({}), set: async () => {} } },
        };
        (globalThis as any).fetch = jest.fn().mockResolvedValue({
            ok: true,
            // "WEBVTT" bytes — jsdom's jest env has no global TextEncoder.
            arrayBuffer: async () => new Uint8Array([87, 69, 66, 86, 84, 84]).buffer,
        });
        controller = makeController();
    });

    it('Path A: loads the player track matching the target language', async () => {
        controller._syncedData = {
            basename: 'Show',
            subtitles: [track('1', 'en', 'English'), track('2', 'es', 'Spanish'), track('3', 'es-CC', 'Spanish [CC]')],
        };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toBe('Show - Spanish.nfimsc');
        expect(opensubtitlesCall()).toBeUndefined();
        // Records the language for savi capture (localhost is the jsdom host).
        expect(settingsSet).toHaveBeenCalledWith({ streamingLastLanguagesSynced: { localhost: ['es'] } });
    });

    // The fallback searches a FILM/TV database with a fuzzy query that never
    // returns "nothing" — so its result has to be checked, and on YouTube it
    // should not run at all.
    describe('OpenSubtitles relevance', () => {
        it('discards a result that is not this video', async () => {
            roamingResponse = { targetLanguage: 'es', openSubtitlesApiKey: 'k-1' };
            openSubtitlesResponse = {
                ok: true,
                name: 'Hussain_ Who Said No HD (English . +20 Subs).srt',
                content: '1\n00:00:01,000 --> 00:00:02,000\nHola\n',
            };
            controller._syncedData = {
                basename: 'Garfunkel and Oates - Pregnant Women Are Smug',
                subtitles: [track('1', 'en', 'English')],
            };

            expect(await controller._trySaviAutoLoad()).toBe(false);
            expect(loadSubtitles).not.toHaveBeenCalled();
        });

        it('does not query OpenSubtitles at all on YouTube', async () => {
            pageKey = 'youtube';
            roamingResponse = { targetLanguage: 'es', openSubtitlesApiKey: 'k-1' };
            controller._syncedData = {
                basename: 'Garfunkel and Oates - Pregnant Women Are Smug',
                subtitles: [track('1', 'en', 'English')],
            };

            expect(await controller._trySaviAutoLoad()).toBe(false);
            expect(opensubtitlesCall()).toBeUndefined();
            expect(loadSubtitles).not.toHaveBeenCalled();
        });
    });

    // SV-41: the gate runs before auto-load, and judges the SPOKEN language.
    describe('language gate', () => {
        it('suppresses auto-load when the spoken language is not the target', async () => {
            controller._syncedData = {
                basename: 'Show',
                spokenLanguage: 'en',
                // YouTube offers an auto-translated Spanish track on English
                // videos — the false signal that used to switch savi on here.
                subtitles: [track('2', 'es', 'Spanish')],
            };

            expect(await controller._trySaviAutoLoad()).toBe(false);
            expect(loadSubtitles).not.toHaveBeenCalled();
            expect(applySaviLanguageGate).toHaveBeenCalledWith({
                active: false,
                reason: 'mismatch',
                targetLanguage: 'es',
            });
        });

        it('loads as usual when the spoken language matches', async () => {
            controller._syncedData = {
                basename: 'Show',
                spokenLanguage: 'es-419',
                subtitles: [track('2', 'es', 'Spanish')],
            };

            expect(await controller._trySaviAutoLoad()).toBe(true);
            expect(loadSubtitles).toHaveBeenCalledTimes(1);
            expect(applySaviLanguageGate).toHaveBeenCalledWith({
                active: true,
                reason: 'match',
                targetLanguage: 'es',
            });
        });

        it('fails open when the page gives no spoken language', async () => {
            controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

            expect(await controller._trySaviAutoLoad()).toBe(true);
            expect(applySaviLanguageGate).toHaveBeenCalledWith({
                active: true,
                reason: 'unknown',
                targetLanguage: 'es',
            });
        });

        it('fails open when the gate itself throws', async () => {
            // A broken gate must never be why savi went quiet. Note this case
            // would otherwise be a MISMATCH (en vs es), so returning true here
            // proves the failure path won, not the language comparison.
            applySaviLanguageGate.mockImplementation(() => {
                throw new Error('binding exploded');
            });
            controller._syncedData = { basename: 'Show', spokenLanguage: 'en', subtitles: [track('2', 'es', 'x')] };

            expect(await controller._trySaviAutoLoad()).toBe(true);
        });

        it('blocks BEFORE the native line ever gets a vote', async () => {
            // The gate judges the spoken language only. A native-language track
            // existing on this English video is precisely the "a track exists"
            // false signal it was built to ignore — so with a native language
            // configured and a matching track present, a mismatch must still
            // load nothing at all, not the native line on its own.
            roamingResponse = { targetLanguage: 'es', nativeLanguage: 'en', openSubtitlesApiKey: '' };
            controller._syncedData = {
                basename: 'Show',
                spokenLanguage: 'en',
                subtitles: [track('1', 'en', 'English'), track('2', 'es', 'Spanish')],
            };

            expect(await controller._trySaviAutoLoad()).toBe(false);
            expect(loadSubtitles).not.toHaveBeenCalled();
            expect(applySaviLanguageGate).toHaveBeenCalledWith({
                active: false,
                reason: 'mismatch',
                targetLanguage: 'es',
            });
        });
    });

    it('loads the native track as a second line alongside the target', async () => {
        roamingResponse = { targetLanguage: 'es', nativeLanguage: 'en', openSubtitlesApiKey: '' };
        controller._syncedData = {
            basename: 'Show',
            subtitles: [track('1', 'en', 'English'), track('2', 'es', 'Spanish')],
        };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        const files = loadSubtitles.mock.calls[0][0];
        expect(files).toHaveLength(2);
        // Target FIRST: asbplayer treats track 0 as the mining source, so the
        // order here decides whether mining yields Spanish or English.
        expect(files[0].name).toBe('Show - Spanish.nfimsc');
        expect(files[1].name).toBe('Show - English.nfimsc');
    });

    it('loads the target alone when the video has no native track', async () => {
        roamingResponse = { targetLanguage: 'es', nativeLanguage: 'de', openSubtitlesApiKey: '' };
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        expect(loadSubtitles.mock.calls[0][0]).toHaveLength(1);
    });

    it('loads the target alone when no native language is configured', async () => {
        roamingResponse = { targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: '' };
        controller._syncedData = {
            basename: 'Show',
            subtitles: [track('1', 'en', 'English'), track('2', 'es', 'Spanish')],
        };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        expect(loadSubtitles.mock.calls[0][0]).toHaveLength(1);
    });

    it('still auto-loads when the settings predate the native-line field', async () => {
        // A cache written by an older build has no `nativeLanguage`. Reading it
        // must not throw: the catch in _trySaviAutoLoad would swallow it and
        // report "auto-load failed", costing the user their subtitles outright
        // over an optional second line.
        sendMessage.mockImplementation(async (cmd: any) => {
            if (cmd?.message?.command === 'savi-roaming-settings') throw new Error('no background');
            return undefined;
        });
        roamingCacheMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: '' } as any);
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
    });

    it('does nothing when auto-load is disabled', async () => {
        getSingle.mockResolvedValue(false);
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('does nothing when no target language is set', async () => {
        roamingResponse = { targetLanguage: '', nativeLanguage: '', openSubtitlesApiKey: '' };
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('Path B: falls back to OpenSubtitles when no track matches and a key is set', async () => {
        roamingResponse = { targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: 'k-1' };
        // The name must actually resemble the query now — an unrelated result
        // is discarded (see the relevance tests below).
        openSubtitlesResponse = {
            ok: true,
            name: 'Dark.S01E03.es.srt',
            content: '1\n00:00:01,000 --> 00:00:02,000\nHola\n',
        };
        controller._syncedData = { basename: 'Dark S01E03 Secrets', subtitles: [track('1', 'en', 'English')] };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        const call = opensubtitlesCall();
        expect(call?.[0].message).toMatchObject({
            command: 'savi-opensubtitles-fetch',
            query: 'Dark',
            languages: 'es',
            seasonNumber: 1,
            episodeNumber: 3,
        });
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toBe('Dark.S01E03.es.srt');
        expect(settingsSet).toHaveBeenCalledWith({ streamingLastLanguagesSynced: { localhost: ['es'] } });
    });

    it('does not use OpenSubtitles when no key is configured', async () => {
        roamingResponse = { targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: '' };
        controller._syncedData = { basename: 'Show', subtitles: [track('1', 'en', 'English')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(opensubtitlesCall()).toBeUndefined();
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('Path B returns false when OpenSubtitles has no result', async () => {
        roamingResponse = { targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: 'k-1' };
        openSubtitlesResponse = { ok: false };
        controller._syncedData = { basename: 'Show', subtitles: [track('1', 'en', 'English')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('falls back to the cached roaming settings when the background is unreachable', async () => {
        sendMessage.mockImplementation(async (cmd: any) => {
            if (cmd?.message?.command === 'savi-roaming-settings') throw new Error('no background');
            return undefined;
        });
        roamingCacheMock.mockResolvedValue({ targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: '' });
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
    });
});
