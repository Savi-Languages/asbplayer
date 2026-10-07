import { spotifyPayloadLines } from '@/savi/spotify';
import { observeSpotifyMedia } from '@/savi/spotify-media';
/** Passive: inspect responses Spotify itself requested. No credentials leave the page. */
export default defineContentScript({
    matches: ['https://open.spotify.com/*'],
    runAt: 'document_start',
    world: 'MAIN',
    main() {
        observeSpotifyMedia(window);
        const cache = new Map<string, unknown>();
        const emit = (value: unknown) => window.postMessage(value, 'https://open.spotify.com');
        window.addEventListener('message', (event) => {
            if (
                event.source === window &&
                event.origin === 'https://open.spotify.com' &&
                event.data?.type === 'savi-spotify-text-request'
            )
                for (const value of cache.values()) emit(value);
        });
        const original = window.fetch;
        window.fetch = async function (...args: Parameters<typeof fetch>) {
            const response = await original.apply(this, args);
            try {
                const u = new URL(response.url);
                const match = u.pathname.match(
                    /\/(?:color-lyrics\/v2\/track|transcript-read-along\/v2\/episode)\/([A-Za-z0-9]{22})(?:\/|$)/
                );
                if (
                    response.ok &&
                    u.protocol === 'https:' &&
                    (u.hostname === 'spclient.wg.spotify.com' || u.hostname.endsWith('.spotify.com')) &&
                    match &&
                    response.headers.get('content-type')?.includes('json')
                ) {
                    const kind = u.pathname.includes('color-lyrics') ? 'track' : 'episode';
                    void response
                        .clone()
                        .text()
                        .then((text) => {
                            if (text.length > 1000000) return;
                            const payload = JSON.parse(text),
                                lines = spotifyPayloadLines(payload);
                            if (lines.length) {
                                const id = `spotify:${kind}:${match[1]}`;
                                const value = {
                                    type: 'savi-spotify-text',
                                    id,
                                    lines,
                                    language:
                                        typeof payload?.lyrics?.language === 'string'
                                            ? payload.lyrics.language
                                            : typeof payload?.language === 'string'
                                              ? payload.language
                                              : undefined,
                                };
                                cache.set(id, value);
                                if (cache.size > 10) cache.delete(cache.keys().next().value!);
                                emit(value);
                            }
                        })
                        .catch(() => {});
                }
            } catch {}
            return response;
        };
    },
});
