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

/** `saviHoldSubtitleMs` sentinel: hold until the next cue starts, with no time
 *  limit of its own. Bounded by the track, not the clock. */
export const HOLD_UNTIL_NEXT_CUE = -1;

/** The default. A time cap turned out to be the wrong instrument: measured on a
 *  real 75-minute Japanese track, a 2s cap still left 319s of blank screen and
 *  covered only 65% of gaps, because these gaps are mostly NOT silence — they
 *  are speech the track failed to timestamp, packed into the preceding cue. So
 *  the line stays until the next one is due; `nextToShow` guarantees it can
 *  never overlap or outlive that. */
export const DEFAULT_HOLD_MS = HOLD_UNTIL_NEXT_CUE;

/** Hold-until-next still needs SOME bound when nothing follows (past the last
 *  cue, where `nextToShow` is empty), or the final line would sit over the
 *  outro forever. */
export const NO_NEXT_CUE_FALLBACK_MS = 5000;

/**
 * The subtitles to draw at `timestampMs`.
 *
 * Normally just `slice.showing`. When that is empty, the most recent cue is
 * held over — never into the next cue, and never before its own end.
 *
 * `holdMs` semantics:
 *   - `HOLD_UNTIL_NEXT_CUE` (-1, the default): hold until the next cue is due,
 *     falling back to `NO_NEXT_CUE_FALLBACK_MS` when nothing follows.
 *   - `0`: disabled — the pre-existing behaviour.
 *   - `> 0`: hold at most that many ms past the cue's end.
 */
export function subtitlesToDisplay<T extends SubtitleModel>(
    slice: SubtitleSlice<T>,
    timestampMs: number,
    holdMs: number
): T[] {
    if (slice.showing.length > 0) {
        return slice.showing;
    }

    if (holdMs === 0) {
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

    // A backwards seek can leave `now` behind the held cue's end with nothing
    // showing; holding then would resurrect a line the viewer scrubbed past.
    if (elapsed < 0) {
        return [];
    }

    // Never bleed into the next cue — this is what bounds hold-until-next.
    const nextStart = smallestStart(slice.nextToShow);

    if (nextStart !== undefined && timestampMs >= nextStart) {
        return [];
    }

    const cap = holdMs < 0 ? (nextStart === undefined ? NO_NEXT_CUE_FALLBACK_MS : Number.POSITIVE_INFINITY) : holdMs;

    if (elapsed > cap) {
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
