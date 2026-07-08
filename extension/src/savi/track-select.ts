// Pick the streaming player's own subtitle track that matches the learner's
// target language, so savi can auto-load it without the user opening the track
// picker (SV-8). Operates on the detected-track list the page scripts surface
// (Netflix/YouTube/etc.), so it is site-agnostic.
//
// Matching is by BCP-47 PRIMARY SUBTAG (es matches es, es-419, es-ES). Among
// the matches we prefer, in order: an exact full-tag match to the target (so a
// learner who set es-419 gets Latin-American Spanish), then a non-closed-caption
// track (CC tracks carry [sound] cues that pollute glossing), then the site's
// own ordering (usually the primary track first).

import type { VideoDataSubtitleTrack } from '@project/common';

/** The BCP-47 primary subtag, lowercased (`es-419` → `es`). */
export const primarySubtag = (language: string): string => language.trim().toLowerCase().split('-')[0];

/** Netflix labels closed-caption tracks `xx-CC` (see netflix-page.ts) and their
 *  label carries `[CC]`. Either signal marks the track as closed captions. */
const isClosedCaptions = (track: VideoDataSubtitleTrack): boolean => {
    const language = (track.language ?? '').toLowerCase();
    return language.endsWith('-cc') || /\[cc\]/i.test(track.label ?? '');
};

/** A track is a real, loadable subtitle (not the "None"/empty placeholder). */
const isLoadable = (track: VideoDataSubtitleTrack): boolean => {
    const language = (track.language ?? '').trim();
    return language.length > 0 && language !== '-' && track.url !== '-';
};

/**
 * The best detected subtitle track for `targetLanguage`, or `undefined` when no
 * track shares the target's primary subtag. `targetLanguage` is a BCP-47 tag or
 * bare subtag (`es`, `ja`, `es-419`); empty/absent returns `undefined`.
 */
export const selectTrackForLanguage = (
    subtitles: VideoDataSubtitleTrack[] | undefined,
    targetLanguage: string | undefined
): VideoDataSubtitleTrack | undefined => {
    const target = (targetLanguage ?? '').trim().toLowerCase();

    if (target.length === 0 || subtitles === undefined || subtitles.length === 0) {
        return undefined;
    }

    const targetPrimary = primarySubtag(target);
    const candidates = subtitles.filter(
        (track) => isLoadable(track) && primarySubtag(track.language ?? '') === targetPrimary
    );

    if (candidates.length === 0) {
        return undefined;
    }

    // Stable rank: exact full-tag match first, then non-CC, then input order.
    const score = (track: VideoDataSubtitleTrack): number => {
        const exact = (track.language ?? '').toLowerCase() === target ? 2 : 0;
        const notCc = isClosedCaptions(track) ? 0 : 1;
        return exact + notCc;
    };

    return candidates.reduce((best, track) => (score(track) > score(best) ? track : best), candidates[0]);
};

/**
 * Split a detected episode name (e.g. Netflix's `Dark S01E03 Secrets`) into an
 * OpenSubtitles search query + season/episode numbers, for the fallback search.
 * When no `SxxEyy` marker is present the whole name is the query (a film).
 */
export const parseShowQuery = (basename: string): { query: string; seasonNumber?: number; episodeNumber?: number } => {
    const name = (basename ?? '').trim();
    const match = name.match(/[sS](\d{1,2})[\s._-]*[eE](\d{1,3})/);

    if (!match || match.index === undefined) {
        return { query: name };
    }

    const query = name.slice(0, match.index).trim();
    return {
        query: query.length > 0 ? query : name,
        seasonNumber: Number(match[1]),
        episodeNumber: Number(match[2]),
    };
};
