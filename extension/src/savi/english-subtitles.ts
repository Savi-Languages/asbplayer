import type { VideoData, VideoDataSubtitleTrack } from '@project/common';
import { deriveEpisodeId } from './episode';

export interface PlatformSubtitleSource {
    episodeId: string;
    sourceUrl: string;
    trackId: string;
}
export interface EnglishSubtitleInput {
    content: string;
    format: 'srt';
    language: string;
    provider: 'netflix' | 'youtube';
    sourceId: string;
    trackId: string;
    sourceOffsetMs: number;
}
export function englishCompanionTrack(tracks: VideoDataSubtitleTrack[]) {
    return tracks.find(
        (t) =>
            t.captionTrust === 'human' &&
            !t.closedCaptions &&
            !t.localFile &&
            !(Array.isArray(t.url) ? t.url : [t.url]).some((url) => /[?&]tlang=/i.test(url)) &&
            /^en(?:-[a-z]{2})?$/i.test(t.language ?? '') &&
            !/\b(CC|SDH|forced)\b/i.test(t.label)
    );
}
export function primaryPlatformSource(
    data: VideoData | undefined,
    track: VideoDataSubtitleTrack | undefined
): PlatformSubtitleSource | undefined {
    if (
        !data?.sourceUrl ||
        !track ||
        track.localFile ||
        !data.subtitles?.some((t) => t.id === track.id && t.url === track.url)
    )
        return;
    const episodeId = deriveEpisodeId(data.sourceUrl, '');
    if (!episodeId || !/^(netflix|youtube):/.test(episodeId)) return;
    const detected = data.episodeId?.includes(':') ? data.episodeId : `${episodeId.split(':')[0]}:${data.episodeId}`;
    if (detected !== episodeId) return;
    return { episodeId, sourceUrl: data.sourceUrl, trackId: track.id };
}
export function primaryOffset(cues: { start: number; originalStart?: number }[]): number | undefined {
    if (!cues.length) return;
    const offset = cues[0].originalStart === undefined ? NaN : Math.round(cues[0].start - cues[0].originalStart);
    if (
        !Number.isFinite(offset) ||
        Math.abs(offset) > 86400000 ||
        cues.some((c) => c.originalStart === undefined || Math.round(c.start - c.originalStart) !== offset)
    )
        return;
    return offset;
}
