// Integration test for the SV-8 savi auto-load glue inside VideoDataSyncController.
// The controller is heavily coupled to Binding/UiFrame/page delegates, so we mock
// those out and exercise the real `_trySaviAutoLoad` path end to end: it reads the
// setting + roaming target language, selects the matching detected track (Path A),
// fetches its subtitle bytes, and hands them to Binding.loadSubtitles — or, when no
// track matches, asks the background to fetch from OpenSubtitles (Path B).

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

const roamingMock = getCachedRoamingSettings as jest.Mock;

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
    let controller: any;
    let sendMessage: jest.Mock;

    const makeController = () => {
        const context = { loadSubtitles } as any;
        const settings = { getSingle } as any;
        return new VideoDataSyncController(context, settings);
    };

    beforeEach(() => {
        loadSubtitles = jest.fn();
        getSingle = jest.fn().mockResolvedValue(true); // saviAutoLoadSubtitles
        sendMessage = jest.fn();
        roamingMock.mockReset();
        (globalThis as any).browser = { runtime: { getURL: (p: string) => p, sendMessage } };
        (globalThis as any).fetch = jest.fn().mockResolvedValue({
            ok: true,
            // "WEBVTT" bytes — jsdom's jest env has no global TextEncoder.
            arrayBuffer: async () => new Uint8Array([87, 69, 66, 86, 84, 84]).buffer,
        });
        controller = makeController();
    });

    it('Path A: loads the player track matching the target language', async () => {
        roamingMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: '' });
        controller._syncedData = {
            basename: 'Show',
            subtitles: [track('1', 'en', 'English'), track('2', 'es', 'Spanish'), track('3', 'es-CC', 'Spanish [CC]')],
        };

        const loaded = await controller._trySaviAutoLoad();

        expect(loaded).toBe(true);
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        const [files] = loadSubtitles.mock.calls[0];
        expect(files[0].name).toBe('Show - Spanish.nfimsc');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does nothing when auto-load is disabled', async () => {
        getSingle.mockResolvedValue(false);
        roamingMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: '' });
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('does nothing when no target language is set', async () => {
        roamingMock.mockResolvedValue({ targetLanguage: '', openSubtitlesApiKey: '' });
        controller._syncedData = { basename: 'Show', subtitles: [track('2', 'es', 'Spanish')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('Path B: falls back to OpenSubtitles when no track matches and a key is set', async () => {
        roamingMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: 'k-1' });
        sendMessage.mockResolvedValue({
            ok: true,
            name: 'Show.es.srt',
            content: '1\n00:00:01,000 --> 00:00:02,000\nHola\n',
        });
        controller._syncedData = { basename: 'Dark S01E03 Secrets', subtitles: [track('1', 'en', 'English')] };

        const loaded = await controller._trySaviAutoLoad();

        expect(loaded).toBe(true);
        const [command] = sendMessage.mock.calls[0];
        expect(command.message).toMatchObject({
            command: 'savi-opensubtitles-fetch',
            query: 'Dark',
            languages: 'es',
            seasonNumber: 1,
            episodeNumber: 3,
        });
        expect(loadSubtitles).toHaveBeenCalledTimes(1);
        expect(loadSubtitles.mock.calls[0][0][0].name).toBe('Show.es.srt');
    });

    it('does not use OpenSubtitles when no key is configured', async () => {
        roamingMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: '' });
        controller._syncedData = { basename: 'Show', subtitles: [track('1', 'en', 'English')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(loadSubtitles).not.toHaveBeenCalled();
    });

    it('Path B returns false when OpenSubtitles has no result', async () => {
        roamingMock.mockResolvedValue({ targetLanguage: 'es', openSubtitlesApiKey: 'k-1' });
        sendMessage.mockResolvedValue({ ok: false });
        controller._syncedData = { basename: 'Show', subtitles: [track('1', 'en', 'English')] };

        expect(await controller._trySaviAutoLoad()).toBe(false);
        expect(loadSubtitles).not.toHaveBeenCalled();
    });
});
