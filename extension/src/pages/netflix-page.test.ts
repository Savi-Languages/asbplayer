/** Exercise the real injected Netflix script with a fake player API. */
let runScript: () => void;
(globalThis as any).defineUnlistedScript = (fn: () => void) => {
    runScript = fn;
};
jest.mock('@/pages/util', () => ({
    trackFromDef: (def: any) => ({ id: def.language, ...def }),
    poll: jest.fn(async (test: () => boolean) => test()),
}));
import '../entrypoints/netflix-page';
import { poll } from '@/pages/util';

describe('Netflix page response identity', () => {
    let activePlayer: any;
    let metadataReady: boolean;
    let api: any;
    let listeners: [string, EventListener][];
    let nativeApply: typeof Function.prototype.apply;
    const subtitle = { trackId: 'es', bcp47: 'es', displayName: 'Spanish' };
    const makePlayer = (id: string) => ({
        getMovieId: () => id,
        getTimedTextTrackList: () => [subtitle],
        getTimedTextTrack: () => ({ trackId: 'previous' }),
        setTimedTextTrack: jest.fn().mockResolvedValue(undefined),
    });
    const flush = async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    const request = (event: string, detail: any) => document.dispatchEvent(new CustomEvent(event, { detail }));
    beforeEach(() => {
        jest.useFakeTimers();
        nativeApply = Function.prototype.apply;
        listeners = [];
        const add = document.addEventListener.bind(document);
        jest.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: any, options?: any) => {
            listeners.push([type, listener]);
            add(type, listener, options);
        });
        activePlayer = makePlayer('playable-999');
        metadataReady = true;
        api = {
            videoPlayer: {
                getAllPlayerSessionIds: () => ['session'],
                getVideoPlayerBySessionId: () => activePlayer,
            },
            getVideoMetadataByVideoId: () => ({
                getCurrentVideo: () => ({
                    getTitle: () => (metadataReady ? 'Show' : undefined),
                }),
            }),
        };
        (globalThis as any).netflix = {
            appContext: {
                state: {
                    playerApp: {
                        getAPI: () => api,
                        getState: () => ({
                            videoPlayer: {
                                cadmiumPlayerRepository: {
                                    playersById: {
                                        session: {
                                            type: 'timedtext',
                                            trackId: 'es',
                                            urls: [{ url: 'https://sub/es.vtt' }],
                                        },
                                    },
                                },
                            },
                        }),
                    },
                },
            },
        };
        runScript();
        jest.advanceTimersByTime(0);
    });
    afterEach(() => {
        for (const [type, listener] of listeners) document.removeEventListener(type, listener);
        Function.prototype.apply = nativeApply;
        delete (globalThis as any).netflix;
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('echoes the request token and captures the URL separately from the player id', async () => {
        const response = jest.fn();
        document.addEventListener('asbplayer-synced-data', (e) => response((e as CustomEvent).detail));
        request('asbplayer-get-synced-data', { requestId: 'first' });
        await flush();
        expect(response).toHaveBeenCalledWith(
            expect.objectContaining({
                requestId: 'first',
                sourceUrl: window.location.href,
                episodeId: 'netflix:playable-999',
                basename: 'Show',
            })
        );
    });

    it.each(['replacement', 'same-object'])('rejects a player change during metadata lookup (%s)', async (kind) => {
        const response = jest.fn();
        document.addEventListener('asbplayer-synced-data', (e) => response((e as CustomEvent).detail));
        metadataReady = false;
        request('asbplayer-get-synced-data', { requestId: 'old' });
        if (kind === 'replacement') activePlayer = makePlayer('next');
        else activePlayer.getMovieId = () => 'next';
        metadataReady = true;
        await jest.advanceTimersByTimeAsync(1000);
        expect(response).toHaveBeenCalledWith(
            expect.objectContaining({ requestId: 'old', stale: true, subtitles: [] })
        );
    });

    it('rejects a lazy request for a different player before changing its track', async () => {
        const response = jest.fn();
        document.addEventListener('asbplayer-synced-language-data', (e) => response((e as CustomEvent).detail));
        request('asbplayer-get-synced-language-data', {
            requestId: 'lazy-old',
            language: 'es',
            episodeId: 'netflix:previous',
        });
        await flush();
        expect(response).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'lazy-old', stale: true }));
        expect(activePlayer.setTimedTextTrack).not.toHaveBeenCalled();
    });

    it('correlates lazy replies even when the requested track is unavailable', async () => {
        const response = jest.fn();
        document.addEventListener('asbplayer-synced-language-data', (e) => response((e as CustomEvent).detail));
        request('asbplayer-get-synced-language-data', { requestId: 'missing', language: 'ja' });
        await flush();
        expect(response).toHaveBeenCalledWith(
            expect.objectContaining({ requestId: 'missing', error: expect.any(String) })
        );
    });
    it('rejects navigation during metadata lookup even when the player id is unchanged', async () => {
        const originalUrl = window.location.href;
        const response = jest.fn();
        document.addEventListener('asbplayer-synced-data', (e) => response((e as CustomEvent).detail));
        metadataReady = false;
        request('asbplayer-get-synced-data', { requestId: 'navigation' });
        window.history.replaceState({}, '', '/next');
        metadataReady = true;
        try {
            await jest.advanceTimersByTimeAsync(1000);
            expect(response).toHaveBeenCalledWith(
                expect.objectContaining({
                    requestId: 'navigation',
                    sourceUrl: originalUrl,
                    stale: true,
                    subtitles: [],
                })
            );
        } finally {
            window.history.replaceState({}, '', originalUrl);
        }
    });

    it('serializes queued lazy requests and never restores an old track after player replacement', async () => {
        const response = jest.fn();
        document.addEventListener('asbplayer-synced-language-data', (e) => response((e as CustomEvent).detail));
        (globalThis as any).netflix.appContext.state.playerApp.getState = () => ({});
        let release!: (ok: boolean) => void;
        (poll as jest.Mock).mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    release = resolve;
                })
        );
        const oldPlayer = activePlayer;
        request('asbplayer-get-synced-language-data', { requestId: 'first', language: 'es' });
        request('asbplayer-get-synced-language-data', { requestId: 'queued', language: 'es' });
        await flush();
        expect(oldPlayer.setTimedTextTrack).toHaveBeenCalledTimes(1);
        activePlayer = makePlayer('next');
        release(true);
        await flush();
        expect(response.mock.calls.map(([data]) => [data.requestId, data.stale])).toEqual([
            ['first', true],
            ['queued', true],
        ]);
        expect(oldPlayer.setTimedTextTrack).toHaveBeenCalledTimes(1);
        expect(activePlayer.setTimedTextTrack).not.toHaveBeenCalled();
    });
});
