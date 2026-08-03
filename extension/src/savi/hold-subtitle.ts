// Hold a subtitle on screen through the silence its cue leaves behind.
//
// Auto-timed tracks — YouTube's ASR, and plenty of its human ones — routinely
// end a cue before the speaker actually stops. Measured on one real 75-minute
// Japanese track: 38% of the gaps between consecutive cues exceed 0.5s, and
// 860s of 4520s (19% of the video) has no cue at all, with individual gaps
// running past 15s. The line vanishes mid-sentence, and during the gap there is
// nothing on screen to hover for a dictionary lookup either.
//
// So when nothing is showing, keep the previous cue up — but only briefly, and
// only into genuine silence:
//
//   - capped (default 2s), because a stale line hanging over a 15s pause reads
//     as a bug and, worse, invites mining the wrong line;
//   - never past the next cue's start, so an extension can never overlap or
//     race the line that follows;
//   - display ONLY. The cue's real `start`/`end` are untouched, so mined audio
//     clips, condensed spans and per-lemma ear-time all keep using the true
//     timings. This module returns which subtitles to *draw*, nothing more.
//
// Auto-pause is deliberately left alone too: it fires on the cue's real end
// (`willStopShowing`), which is where the sentence nominally finishes. Holding
// the text a moment longer shouldn't move where playback stops.

import { SubtitleModel } from '@project/common';
import { SubtitleSlice } from '@project/common/subtitle-collection';

/** Default hold, in ms. Long enough to cover the ragged cue ends that motivated
 *  this; short enough that a genuine pause still clears the screen. */
export const DEFAULT_HOLD_MS = 2000;

/**
 * The subtitles to draw at `timestampMs`.
 *
 * Normally just `slice.showing`. When that is empty, the most recent cue is
 * held over — for at most `holdMs` past its own end, and never into the next
 * cue. Returns an empty array once the hold expires.
 *
 * `holdMs <= 0` disables holding entirely (the pre-existing behaviour).
 */
export function subtitlesToDisplay<T extends SubtitleModel>(
    slice: SubtitleSlice<T>,
    timestampMs: number,
    holdMs: number
): T[] {
    if (slice.showing.length > 0) {
        return slice.showing;
    }

    if (holdMs <= 0) {
        return [];
    }

    const held = slice.lastShown ?? [];

    if (held.length === 0) {
        return [];
    }

    // Hold from the LATEST end among the held cues: with two tracks loaded the
    // native line often ends slightly after the target line, and dropping one
    // while keeping the other would flicker half the pair away.
    const heldEnd = Math.max(...held.map((s) => s.end));
    const elapsed = timestampMs - heldEnd;

    if (elapsed < 0 || elapsed > holdMs) {
        return [];
    }

    // Never bleed into the next cue. `nextToShow` is the cue the gap runs into;
    // without it (end of track) the cap alone bounds the hold.
    const nextStart = smallestStart(slice.nextToShow);

    if (nextStart !== undefined && timestampMs >= nextStart) {
        return [];
    }

    return held;
}

function smallestStart<T extends SubtitleModel>(subtitles: T[] | undefined): number | undefined {
    if (subtitles === undefined || subtitles.length === 0) {
        return undefined;
    }

    return Math.min(...subtitles.map((s) => s.start));
}
