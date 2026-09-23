import {
    spotifyIdentity,
    parseSpotifyText,
    playbackDelta,
    readSpotifyPlayback,
    readSpotifyLines,
    readSpotifyTranscriptGroups,
    spotifyPayloadLines,
} from './spotify';
const id = '1234567890123456789012';
it('repairs Japanese provider spacing before tokenization without changing cue timing', () => {
    expect(
        spotifyPayloadLines({
            language: 'ja',
            section: [
                { startMs: 1000, endMs: 3000, text: { sentence: { text: '今 日 は こ こ ま で で す。' } } },
                { startMs: 3000, endMs: 4000, text: { sentence: { text: 'パ リ と New York に 行 く。' } } },
                { startMs: 4000, endMs: 5000, text: { sentence: { text: '東 京' } } },
            ],
        })
    ).toEqual([
        { text: '今日はここまでです。', timing: 'timed', start: 1000, end: 3000 },
        { text: 'パリと New York に行く。', timing: 'timed', start: 3000, end: 4000 },
        { text: '東京', timing: 'timed', start: 4000, end: 5000 },
    ]);
});
it('repairs visible Japanese text while preserving other languages and imported spacing', () => {
    document.body.innerHTML = '<div data-testid="transcript-line">今 日 は こ こ ま で で す。</div>';
    expect(readSpotifyLines(document)).toEqual([{ text: '今日はここまでです。', timing: 'untimed' }]);
    for (const [language, words] of [
        ['en', 'New York is nice'],
        ['ko', '오늘 여기까지 입니다'],
        ['zh', '今 天 好'],
        ['en', 'A B C'],
    ]) {
        expect(spotifyPayloadLines({ lyrics: { language, syncType: 'UNSYNCED', lines: [{ words }] } })[0].text).toBe(
            words
        );
    }
    expect(parseSpotifyText('今 日 は\nNew York')).toEqual([
        { text: '今 日 は', timing: 'untimed' },
        { text: 'New York', timing: 'untimed' },
    ]);
});
it('reads current podcast transcript paragraphs without notices or coarse chapter timestamps', () => {
    document.body.innerHTML = `<div role="tabpanel" id="transcript-panel">
        <div><span data-encore-id="text">Automatic transcript notice</span></div>
        <div><button><span data-encore-id="text">0:19</span></button></div>
        <div><span data-encore-id="text" dir="auto">こんにちは。</span></div>
        <div><span data-encore-id="text" dir="auto">今日は晴れです。</span></div>
    </div><div id="description-panel"><span data-encore-id="text" dir="auto">Unrelated description</span></div>`;
    expect(readSpotifyLines(document)).toEqual([
        { text: 'こんにちは。', timing: 'untimed' },
        { text: '今日は晴れです。', timing: 'untimed' },
    ]);
});
it('uses only canonical track/episode identities, never ads or arbitrary hosts', () => {
    expect(spotifyIdentity(`https://open.spotify.com/intl-ja/track/${id}?si=abc`)).toEqual({
        id: `spotify:track:${id}`,
        kind: 'track',
        url: `https://open.spotify.com/track/${id}`,
    });
    expect(spotifyIdentity(`spotify:episode:${id}`)?.kind).toBe('episode');
    for (const s of [`https://evil.com/track/${id}`, `https://open.spotify.com/album/${id}`, 'spotify:ad:foo'])
        expect(spotifyIdentity(s)).toBeUndefined();
});
it('parses actual VTT/SRT/LRC times and never fabricates plain-text timing', () => {
    expect(parseSpotifyText('WEBVTT\n\n00:00:01.000 --> 00:00:03.200\nこんにちは')[0]).toMatchObject({
        text: 'こんにちは',
        start: 1000,
        end: 3200,
        timing: 'timed',
    });
    expect(parseSpotifyText('[00:01.20]hello\n[00:03.00]world')).toEqual([
        { text: 'hello', start: 1200, end: 3000, timing: 'timed' },
        { text: 'world', timing: 'untimed' },
    ]);
    expect(parseSpotifyText('hello\nworld')).toEqual([
        { text: 'hello', timing: 'untimed' },
        { text: 'world', timing: 'untimed' },
    ]);
    expect(parseSpotifyText('00:00:05.000 --> 00:00:01.000\nbad')).toEqual([]);
});
it('decodes safe subtitle entities after stripping markup', () => {
    expect(parseSpotifyText('Tom &amp; Hana &#x65E5;&#26412; <img src=x onerror=alert(1)>')).toEqual([
        { text: 'Tom & Hana 日本', timing: 'untimed' },
    ]);
});
it('counts real forward playback, not pause, seek, duplicate ticks, remote device or item changes', () => {
    const a = { id: 'one', positionMs: 1000, playing: true, rate: 1, local: true, at: 1000 };
    expect(playbackDelta(a, { ...a, positionMs: 2000, at: 2000 })).toBe(1000);
    for (const b of [
        { ...a, at: 2000 },
        { ...a, positionMs: 40000, at: 2000 },
        { ...a, positionMs: 2000, at: 2000, id: 'two' },
        { ...a, positionMs: 2000, at: 2000, local: false },
        { ...a, positionMs: 2000, at: 2000, playing: false },
    ])
        expect(playbackDelta(a, b)).toBe(0);
    expect(playbackDelta({ ...a, rate: 2 }, { ...a, rate: 2, at: 2000, positionMs: 3000 })).toBe(1000);
});
it('does not identify the browsed album as the playing item or count a disabled player', () => {
    document.body.innerHTML = `<main><a href="/track/${id}">browsed</a></main><footer data-testid="now-playing-bar"><button data-testid="control-button-playpause" disabled aria-label="Pause"></button></footer>`;
    expect(readSpotifyPlayback(document).identity).toBeUndefined();
    expect(readSpotifyPlayback(document).playing).toBe(false);
});
it('rejects crossfade and muted clocks, and never binds a preview at another position', () => {
    document.body.innerHTML = `<footer><a data-testid="context-item-link" href="/track/${id}">Song</a><span data-testid="playback-position">0:10</span><span data-testid="playback-duration">1:00</span><button data-testid="control-button-playpause" aria-label="Pause"></button></footer><audio></audio>`;
    const media = document.querySelector('audio')!;
    Object.defineProperties(media, {
        duration: { value: 60 },
        readyState: { value: 3 },
        paused: { value: false },
        currentTime: { value: 10, writable: true },
    });
    expect(readSpotifyPlayback(document).local).toBe(true);
    media.muted = true;
    expect(readSpotifyPlayback(document).local).toBe(false);
    media.muted = false;
    media.currentTime = 20;
    expect(readSpotifyPlayback(document).local).toBe(false);
    media.currentTime = 10;
    const other = document.createElement('audio');
    Object.defineProperties(other, {
        duration: { value: 60 },
        readyState: { value: 3 },
        paused: { value: false },
        currentTime: { value: 10 },
    });
    document.body.append(other);
    expect(readSpotifyPlayback(document).local).toBe(false);
});

it('normalizes provider transcript sentence wrappers without inventing a last-line end', () => {
    expect(
        spotifyPayloadLines({
            section: [
                { startMs: 1000, text: { sentence: { text: 'one' } } },
                { startMs: 2500, text: { sentence: { text: 'two' } } },
            ],
        })
    ).toEqual([
        { text: 'one', start: 1000, end: 2500, timing: 'timed' },
        { text: 'two', timing: 'untimed' },
    ]);
    expect(
        spotifyPayloadLines({
            lyrics: {
                syncType: 'UNSYNCED',
                lines: [
                    { words: 'one', startTimeMs: '0' },
                    { words: 'two', startTimeMs: '1000' },
                ],
            },
        }).every((l) => l.timing === 'untimed')
    ).toBe(true);
    expect(
        spotifyPayloadLines({
            lyrics: {
                syncType: 'LINE_SYNCED',
                lines: [
                    { words: 'one', startTimeMs: '1000' },
                    { words: 'two', startTimeMs: '3000' },
                ],
            },
        })[0]
    ).toMatchObject({ start: 1000, end: 3000, timing: 'timed' });
});

it('reads native timestamp groups as whole intervals without inventing sentence timing', () => {
    document.body.innerHTML = `<div id="transcript-panel" role="tabpanel">
      <div><button><span>0:14</span></button><span>話者1</span></div>
      <div><span data-encore-id="text" dir="auto">こんにちは。</span><span data-savi-spotify-translation lang="en">Hello.</span></div>
      <div><span data-encore-id="text" dir="auto">今日は晴れです。</span></div>
      <div><button>0:19</button></div>
      <div><span data-encore-id="text" dir="auto">最後。</span></div>
    </div>`;
    expect(readSpotifyTranscriptGroups(document)).toEqual([
        { text: 'こんにちは。\n今日は晴れです。', timing: 'timed', start: 14000, end: 19000 },
    ]);
});
it.each(['0:14', '0:13', 'invalid', '5:99', '3:15'])('rejects uncertain native interval end %s', (end) => {
    document.body.innerHTML = `<div id="transcript-panel" role="tabpanel">
      <button>0:14</button><span data-encore-id="text" dir="auto">こんにちは。</span>
      <button>${end}</button><span data-encore-id="text" dir="auto">最後。</span>
    </div>`;
    expect(readSpotifyTranscriptGroups(document)).toEqual([]);
});
