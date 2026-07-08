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
jest.mock('../services/pages', () => ({
    currentPageDelegate: async () => ({
        isVideoPage: () => true,
        canAutoSync: () => false,
        config: { key: 'netflix' },
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

    const makeController = () =>
        new VideoDataSyncController({ loadSubtitles, settings: { set: settingsSet } } as any, { getSingle } as any);

    const opensubtitlesCall = () =>
        sendMessage.mock.calls.find((c) => c[0]?.message?.command === 'savi-opensubtitles-fetch');

    beforeEach(() => {
        loadSubtitles = jest.fn();
        getSingle = jest.fn().mockResolvedValue(true); // saviAutoLoadSubtitles
        settingsSet = jest.fn().mockResolvedValue(undefined);
        roamingResponse = { targetLanguage: 'es', openSubtitlesApiKey: '' };
        openSubtitlesResponse = { ok: false };
        sendMessage = jest.fn(async (cmd: any) => {
            const command = cmd?.message?.command;
            if (command === 'savi-roaming-settings') return roamingResponse;
            if (command === 'savi-opensubtitles-fetch') return openSubtitlesResponse;
            return undefined;
        });
        roamingCacheMock.mockReset();
        roamingCacheMock.mockResolvedValue({ targetLanguage: '', openSubtitlesApiKey: '' });
        (globalThis as any).browser = { runtime: { getURL: (p: string) => p, sendMessage } };
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

    it('does nothing when auto-load is disabled', async () => {
        getSingle.mockResolvedValue(false);
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('does nothing when no target language is set', async () => {
        roamingResponse = { targetLanguage: '', openSubtitlesApiKey: '' };
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('Path B: falls back to OpenSubtitles when no track matches and a key is set', async () => {
        roamingResponse = { targetLanguage: 'es', openSubtitlesApiKey: 'k-1' };
        openSubtitlesResponse = { ok: true, name: 'Show.es.srt', content: '1\n00:00:01,000 --> 00:00:02,000\nHola\n' };
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
        expect(loadSubtitles.mock.calls[0][0][0].name).toBe('Show.es.srt');
        expect(settingsSet).toHaveBeenCalledWith({ streamingLastLanguagesSynced: { localhost: ['es'] } });
    });

    it('does not use OpenSubtitles when no key is configured', async () => {
        roamingResponse = { targetLanguage: 'es', openSubtitlesApiKey: '' };
        controller._syncedData = { basename: 'Show', subtitles: [track('1', 'en', 'English')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(opensubtitlesCall()).toBeUndefined();
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('Path B returns false when OpenSubtitles has no result', async () => {
        roamingResponse = { targetLanguage: 'es', openSubtitlesApiKey: 'k-1' };
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
        roamingCacheMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: '' });
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(true);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
    });
});
