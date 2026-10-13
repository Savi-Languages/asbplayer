import { VideoData, VideoDataSubtitleTrack } from '@project/common';
import { poll, trackFromDef } from '@/pages/util';
import { subtitleSourceMatchesUrl } from '@/savi/subtitle-source';

declare const netflix: any | undefined;

export default defineUnlistedScript(() => {
    setTimeout(() => {
        function getAPI() {
            if (typeof netflix === 'undefined') {
                return undefined;
            }

            return netflix?.appContext?.state?.playerApp?.getAPI?.();
        }

        function getVideoPlayer() {
            return getAPI()?.videoPlayer;
        }

        function player() {
            const netflixVideo = getVideoPlayer();

            if (netflixVideo) {
                const playerSessionIds = netflixVideo.getAllPlayerSessionIds?.() || [];

                if (0 === playerSessionIds.length) {
                    console.error('No Netflix player session IDs');
                    return undefined;
                }

                const playerSessionId = playerSessionIds[playerSessionIds.length - 1];
                return netflixVideo.getVideoPlayerBySessionId?.(playerSessionId);
            }

            console.error('Missing netflix global');
            return undefined;
        }

        // Reads subtitle download URLs from the most recent player session (the last id
        // from getAllPlayerSessionIds). Walks that session state and matches objects by
        // structure (type === 'timedtext' with a urls array), which avoids depending on the
        // minified property paths inside the player object that may change between releases.
        function timedTextUrls(): Map<string, string> {
            const urls = new Map<string, string>();
            const sessionIds = getVideoPlayer()?.getAllPlayerSessionIds?.() || [];

            if (sessionIds.length === 0) {
                return urls;
            }

            const activeSessionId = sessionIds[sessionIds.length - 1];
            const root =
                netflix?.appContext?.state?.playerApp?.getState?.()?.videoPlayer?.cadmiumPlayerRepository
                    ?.playersById?.[activeSessionId];

            if (!root) {
                return urls;
            }

            const seen = new WeakSet<object>();
            const stack: { node: any; depth: number }[] = [{ node: root, depth: 0 }];

            // Timedtext objects sit about 12 levels below the session root, so the depth
            // 20 cap below leaves margin without walking unrelated deep state.
            while (stack.length > 0) {
                const { node, depth } = stack.pop()!;

                if (node === null || typeof node !== 'object' || depth > 20 || seen.has(node)) {
                    continue;
                }

                seen.add(node);

                if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) {
                    continue;
                }

                try {
                    if (
                        node.type === 'timedtext' &&
                        typeof node.trackId === 'string' &&
                        Array.isArray(node.urls) &&
                        node.urls.length > 0 &&
                        typeof node.urls[0]?.url === 'string' &&
                        !urls.has(node.trackId)
                    ) {
                        urls.set(node.trackId, node.urls[0].url);
                    }
                } catch (e) {
                    // Ignore properties that throw on access
                }

                if (Array.isArray(node)) {
                    for (const value of node) {
                        if (value !== null && typeof value === 'object') {
                            stack.push({ node: value, depth: depth + 1 });
                        }
                    }
                } else {
                    for (const key of Object.keys(node)) {
                        let value;

                        try {
                            value = node[key];
                        } catch (e) {
                            continue;
                        }

                        if (value !== null && typeof value === 'object') {
                            stack.push({ node: value, depth: depth + 1 });
                        }
                    }
                }
            }

            return urls;
        }

        document.addEventListener('asbplayer-netflix-seek', (e) => {
            player()?.seek((e as CustomEvent).detail);
        });

        document.addEventListener('asbplayer-netflix-play', () => {
            player()?.play();
        });

        document.addEventListener('asbplayer-netflix-pause', () => {
            player()?.pause();
        });

        function determineBasename(titleId: string): [string, boolean] {
            // Netflix can return a metadata object before the requested video
            // is ready. A non-empty title alone does not prove ownership: an
            // unrelated movie must not become this episode's permanent name.
            try {
                const videoApi = getAPI()?.getVideoMetadataByVideoId?.(titleId)?.getCurrentVideo?.();
                const actualTitle = videoApi?.getTitle?.();
                if (typeof actualTitle !== 'string' || actualTitle.trim().length === 0) {
                    return [`${titleId}`, true];
                }

                const metadataId = videoApi?.getId?.();
                const hasId =
                    (typeof metadataId === 'number' && Number.isFinite(metadataId)) ||
                    (typeof metadataId === 'string' && metadataId.trim().length > 0);
                const episodic = videoApi?.isEpisodic?.();
                if (!hasId || typeof episodic !== 'boolean') return [`${titleId}`, true];

                if (!episodic) {
                    return `${metadataId}` === `${titleId}` ? [actualTitle.trim(), false] : [`${titleId}`, true];
                }

                // Episodic metadata uses the SERIES id, so do not compare that
                // namespace with the playable episode id. Require complete
                // episode coordinates before accepting the series title.
                const seasonNumber = videoApi?.getSeason?.()?._season?.seq;
                const episodeNumber = videoApi?.getEpisodeNumber?.();
                const epTitle = videoApi?.getEpisodeTitle?.();
                if (
                    !Number.isInteger(seasonNumber) ||
                    seasonNumber < 0 ||
                    !Number.isInteger(episodeNumber) ||
                    episodeNumber < 1 ||
                    typeof epTitle !== 'string' ||
                    epTitle.trim().length === 0
                ) {
                    return [`${titleId}`, true];
                }
                const season = `${seasonNumber}`.padStart(2, '0');
                const ep = `${episodeNumber}`.padStart(2, '0');
                if (`${metadataId}` !== `${titleId}`) {
                    document.dispatchEvent(
                        new CustomEvent('savi-netflix-show-id', {
                            detail: { showId: `netflix:${metadataId}` },
                        })
                    );
                }
                return [`${actualTitle.trim()} S${season}E${ep} ${epTitle.trim()}`, false];
            } catch {
                // Metadata failures must not prevent subtitle delivery. Retry
                // briefly, then retain the stable id instead of a wrong title.
                return [`${titleId}`, true];
            }
        }

        async function determineBasenameWithRetries(
            titleId: string,
            retries: number,
            stillCurrent: () => boolean
        ): Promise<string> {
            if (retries <= 0 || !stillCurrent()) {
                return `${titleId}`;
            }

            const [basename, shouldRetry] = determineBasename(titleId);

            if (shouldRetry) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                return await determineBasenameWithRetries(titleId, --retries, stillCurrent);
            }

            return basename;
        }

        const dataForTrack = (track: any, urlsByTrackId?: Map<string, string>): VideoDataSubtitleTrack | undefined => {
            // Skip the "Off" track, forced-narrative tracks, and image-based (bitmap)
            // subtitles, which can't be parsed as text.
            if (!track.bcp47 || track.isNoneTrack || track.isForcedNarrative || track.isImageBased) {
                return undefined;
            }

            const isClosedCaptions = 'CLOSEDCAPTIONS' === track.rawTrackType;
            const language = isClosedCaptions ? `${track.bcp47.toLowerCase()}-CC` : track.bcp47.toLowerCase();
            const label = `${track.bcp47} - ${track.displayName}${isClosedCaptions ? ' [CC]' : ''}`;

            return trackFromDef({
                label,
                language,
                // 'lazy' is a sentinel value indicating to the content script that it should
                // make a lazy language-specific request to get the URL
                url: urlsByTrackId?.get(track.trackId) ?? 'lazy',
                // Netflix subtitle downloads on this path are IMSC 1.1 (TTML)
                extension: 'nfimsc',
            });
        };

        // Capture both namespaces at request receipt, before queued/async work.
        // A playable id (trailer/extra) can legitimately differ from /watch/<id>.
        const requestContext = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            const np = player();
            return {
                np,
                titleId: np?.getMovieId(),
                sourceUrl: window.location.href,
                requestId: detail?.requestId as string | undefined,
                language: detail?.language as string | undefined,
                expectedEpisodeId: detail?.episodeId as string | undefined,
            };
        };
        type RequestContext = ReturnType<typeof requestContext>;
        const isCurrent = (request: RequestContext) =>
            request.np !== undefined &&
            player() === request.np &&
            request.np.getMovieId() === request.titleId &&
            subtitleSourceMatchesUrl(request.sourceUrl, window.location.href) &&
            (request.expectedEpisodeId === undefined || request.expectedEpisodeId === `netflix:${request.titleId}`);
        const emptyResponse = (request: RequestContext): VideoData => ({
            requestId: request.requestId,
            sourceUrl: request.sourceUrl,
            episodeId: request.titleId ? `netflix:${request.titleId}` : undefined,
            error: '',
            basename: '',
            subtitles: [],
        });
        const staleResponse = (request: RequestContext): VideoData => ({ ...emptyResponse(request), stale: true });

        const buildResponse = async (request: RequestContext): Promise<VideoData> => {
            const response = emptyResponse(request);
            if (!request.np || !request.titleId) {
                response.error = 'Netflix Player or Title Id not found...';
                return response;
            }
            if (!isCurrent(request)) {
                return staleResponse(request);
            }
            response.basename = await determineBasenameWithRetries(request.titleId, 5, () => isCurrent(request));
            if (!isCurrent(request)) {
                return staleResponse(request);
            }
            const urlsByTrackId = timedTextUrls();
            // Audio metadata is optional: a missing/temporarily unavailable
            // API must not prevent the existing subtitle response.
            try {
                const language = request.np.getAudioTrack?.()?.bcp47;
                if (typeof language === 'string') {
                    response.audioLanguage = language;
                }
            } catch {
                // Leave language unknown; never infer it from offered captions.
            }
            response.subtitles = (request.np.getTimedTextTrackList() ?? [])
                .map((track: any) => dataForTrack(track, urlsByTrackId))
                .filter((data: VideoDataSubtitleTrack | undefined) => data !== undefined);
            return isCurrent(request) ? response : staleResponse(request);
        };

        document.addEventListener(
            'asbplayer-get-synced-data',
            async (e) => {
                const response = await buildResponse(requestContext(e));
                document.dispatchEvent(new CustomEvent('asbplayer-synced-data', { detail: response }));
            },
            false
        );

        const fetchDataForLanguage = async (request: RequestContext) => {
            const reply = (response: VideoData) =>
                document.dispatchEvent(new CustomEvent('asbplayer-synced-language-data', { detail: response }));
            const fail = (message?: string) =>
                reply({
                    ...emptyResponse(request),
                    error: message ?? 'Failed to fetch subtitles for requested language',
                });
            if (!isCurrent(request)) {
                reply(staleResponse(request));
                return;
            }
            const np = request.np;
            const previousTrack = np.getTimedTextTrack();
            let shouldRevert = false;
            try {
                const track = np
                    .getTimedTextTrackList()
                    ?.find((track: any) => dataForTrack(track)?.language === request.language);
                if (track === undefined) {
                    fail();
                    return;
                }
                if (!timedTextUrls().has(track.trackId)) {
                    // Only one lazy request changes Netflix's active track at a time.
                    await np.setTimedTextTrack(track);
                    shouldRevert = true;
                    const succeeded = await poll(() => !isCurrent(request) || timedTextUrls().has(track.trackId));
                    if (!isCurrent(request)) {
                        reply(staleResponse(request));
                        return;
                    }
                    if (!succeeded) {
                        fail();
                        return;
                    }
                }
                reply(await buildResponse(request));
            } catch (e) {
                if (!isCurrent(request)) {
                    reply(staleResponse(request));
                } else {
                    fail(e instanceof Error ? e.message : String(e));
                }
            } finally {
                // A stale request must never restore its old track on a new player.
                if (shouldRevert && previousTrack !== undefined && isCurrent(request)) {
                    await np.setTimedTextTrack(previousTrack);
                }
            }
        };

        let languageQueue = Promise.resolve();
        document.addEventListener(
            'asbplayer-get-synced-language-data',
            (e) => {
                const request = requestContext(e);
                languageQueue = languageQueue
                    .then(() => fetchDataForLanguage(request))
                    .catch((error) => {
                        console.error('[savi subtitle sync] Netflix track request failed', error);
                    });
            },
            false
        );

        Function.prototype.apply = new Proxy(Function.prototype.apply, {
            apply: function (target, originalThis, args) {
                if (args && args[1] && typeof args[1][0] === 'string') {
                    const property = args[1][0];

                    if (
                        property === 'preciseSeeking' ||
                        property === 'preciseseeking' ||
                        property === 'preciseseekingontwocoredevice'
                    ) {
                        return true;
                    }
                }

                // @ts-ignore
                return target.call(originalThis, ...args);
            },
        });

        document.addEventListener('asbplayer-query-netflix', async () => {
            const apiAvailable = await poll(() => getVideoPlayer() !== undefined, 30000);
            document.dispatchEvent(
                new CustomEvent('asbplayer-netflix-enabled', {
                    detail: apiAvailable,
                })
            );
        });
    }, 0);
});
