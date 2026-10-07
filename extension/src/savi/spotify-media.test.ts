import { observeSpotifyMedia, SpotifyMediaBridge } from './spotify-media';
import { readSpotifyPlayback } from './spotify';

const id = '1234567890123456789012';
const origin = 'https://open.spotify.com';
beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = `<footer data-testid="now-playing-bar"><a data-testid="context-item-link" href="/episode/${id}">Podcast</a><span data-testid="playback-position">0:10</span><span data-testid="playback-duration">1:00</span><button data-testid="control-button-playpause" aria-label="Pause"></button></footer>`;
});
afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
});

it('observes a detached native player without attaching it or changing play results', async () => {
    const playResult = Promise.resolve();
    jest.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValue(playResult);
    const send = jest.fn();
    const stop = observeSpotifyMedia(window, send);
    const media = document.createElement('audio');
    Object.defineProperties(media, {
        duration: { value: 60 },
        currentTime: { value: 10 },
        readyState: { value: 4 },
        paused: { value: false },
        ended: { value: false },
    });
    expect(media.play()).toBe(playResult);
    expect(media.isConnected).toBe(false);
    const packet = send.mock.calls.at(-1)![0];
    expect(packet.media).toHaveLength(1);
    expect(packet.media[0]).toMatchObject({ currentTime: 10, duration: 60, paused: false });
    expect(JSON.stringify(packet)).not.toContain('src');
    media.dispatchEvent(new Event('waiting'));
    expect(send.mock.calls.at(-1)![0].event).toBe('waiting');
    stop();
});

it('accepts fresh local snapshots, rejects foreign messages, and expires missing clocks', () => {
    const bridge = new SpotifyMediaBridge(window);
    bridge.start();
    const packet = {
        type: 'savi-spotify-media',
        media: [
            {
                key: 'm1',
                currentTime: 10,
                duration: 60,
                playbackRate: 1,
                paused: false,
                ended: false,
                muted: false,
                volume: 1,
                readyState: 4,
            },
        ],
    };
    const deliver = (eventOrigin: string) =>
        window.dispatchEvent(
            new MessageEvent('message', {
                source: window,
                origin: eventOrigin,
                data: packet,
            })
        );
    deliver('https://example.com');
    expect(bridge.media()).toHaveLength(0);
    deliver(origin);
    expect(readSpotifyPlayback(document, bridge.media()).local).toBe(true);
    jest.advanceTimersByTime(1001);
    expect(bridge.media()).toHaveLength(0);
    bridge.stop();
});

it('routes replay only to the native clock matching the current player and rejects a different item', async () => {
    const play = jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const send = jest.fn();
    const stop = observeSpotifyMedia(window, send);
    const media = document.createElement('audio');
    Object.defineProperties(media, {
        duration: { value: 60 },
        currentTime: { value: 10, writable: true },
        readyState: { value: 4 },
        paused: { value: true },
        ended: { value: false },
    });
    await media.play();
    const key = send.mock.calls.at(-1)![0].media[0].key;
    const command = (request: string, time: number) =>
        window.dispatchEvent(
            new MessageEvent('message', {
                source: window,
                origin,
                data: { type: 'savi-spotify-media-control', action: 'replay', key, request, time },
            })
        );
    command('valid', 2);
    await Promise.resolve();
    expect(media.currentTime).toBe(2);
    expect(play).toHaveBeenCalledTimes(2);
    // Footer is still at 10s: a stale/other clock cannot be controlled by key alone.
    command('stale', 4);
    expect(media.currentTime).toBe(2);
    expect(send).toHaveBeenCalledWith({ type: 'savi-spotify-media-result', request: 'stale', ok: false });
    stop();
});
