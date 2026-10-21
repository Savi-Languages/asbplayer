import { englishCompanionTrack, primaryPlatformSource, primaryOffset } from './english-subtitles';
import { VideoDataSubtitleTrack } from '@project/common';
const track = (id: string, language: string, extra = {}): VideoDataSubtitleTrack => ({
    id,
    language,
    label: language,
    extension: 'srt',
    url: 'https://sub/' + id,
    captionTrust: 'human',
    ...extra,
});
test('only retains authored, non-CC English tracks', () => {
    const cc = track('cc', 'en-CC', { closedCaptions: true }),
        auto = track('asr', 'en', { captionTrust: 'auto' }),
        translated = track('t', 'en_from_ja', { captionTrust: 'translated' }),
        plain = track('en', 'en');
    expect(englishCompanionTrack([cc, auto, translated])).toBeUndefined();
    expect(englishCompanionTrack([cc, auto, plain])).toBe(plain);
    expect(englishCompanionTrack([track('unknown', 'en', { captionTrust: undefined })])).toBeUndefined();
});
test('binds only an actual platform primary to its episode', () => {
    const ja = track('ja', 'ja'),
        data = { basename: 'show', episodeId: '123', sourceUrl: 'https://www.netflix.com/watch/123', subtitles: [ja] };
    expect(primaryPlatformSource(data, ja)?.episodeId).toBe('netflix:123');
    expect(primaryPlatformSource(data, track('manual', 'ja'))).toBeUndefined();
    expect(primaryPlatformSource({ ...data, episodeId: '456' }, ja)).toBeUndefined();
    expect(primaryPlatformSource(data, { ...ja, localFile: true })).toBeUndefined();
});
test('preserves one consistent primary offset and rejects unknown timing', () => {
    expect(
        primaryOffset([
            { start: 1200, originalStart: 1000 },
            { start: 2200, originalStart: 2000 },
        ])
    ).toBe(200);
    expect(primaryOffset([{ start: 1200 }])).toBeUndefined();
    expect(
        primaryOffset([
            { start: 1200, originalStart: 1000 },
            { start: 2200, originalStart: 1000 },
        ])
    ).toBeUndefined();
});
