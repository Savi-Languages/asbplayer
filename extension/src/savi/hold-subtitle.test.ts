import {
    DEFAULT_HOLD_MS,
    HOLD_UNTIL_NEXT_CUE,
    NO_NEXT_CUE_FALLBACK_MS,
    nextStartAfter,
    subtitlesToDisplay,
} from './hold-subtitle';
import { defaultSettings } from '@project/common/settings';

const cue = (start: number, end: number, text = 'x', track = 0) => ({ start, end, text, track });

const slice = (showing: any[], lastShown?: any[], nextToShow?: any[]) => ({
    showing,
    lastShown,
    nextToShow,
});

describe('subtitlesToDisplay', () => {
    it('passes through whatever is genuinely showing', () => {
        const now = cue(1000, 3000, 'now');
        expect(subtitlesToDisplay(slice([now]), 2000, DEFAULT_HOLD_MS)).toEqual([now]);
    });

    it('holds the last cue through a short gap', () => {
        // The case that motivated this: the cue ended at 3000 but the speaker
        // is still talking, and the next cue is 4s away.
        const last = cue(1000, 3000, 'still talking');
        const held = subtitlesToDisplay(slice([], [last], [cue(7000, 9000)]), 3500, 2000);
        expect(held).toEqual([last]);
    });

    it('drops the held cue once the cap expires', () => {
        const last = cue(1000, 3000);
        expect(subtitlesToDisplay(slice([], [last], [cue(9000, 9500)]), 5001, 2000)).toEqual([]);
    });

    it('holds right up to the cap but not past it', () => {
        const last = cue(1000, 3000);
        const next = [cue(9000, 9500)];
        expect(subtitlesToDisplay(slice([], [last], next), 5000, 2000)).toEqual([last]);
        expect(subtitlesToDisplay(slice([], [last], next), 5001, 2000)).toEqual([]);
    });

    it('never bleeds into the next cue, even inside the cap', () => {
        // Gap of only 500ms: the hold must yield at 3500, not run to 5000.
        const last = cue(1000, 3000);
        const next = cue(3500, 6000);
        expect(subtitlesToDisplay(slice([], [last], [next]), 3400, 2000)).toEqual([last]);
        expect(subtitlesToDisplay(slice([], [last], [next]), 3500, 2000)).toEqual([]);
    });

    it('holds to the cap when nothing follows (end of track)', () => {
        const last = cue(1000, 3000);
        expect(subtitlesToDisplay(slice([], [last], undefined), 4900, 2000)).toEqual([last]);
        expect(subtitlesToDisplay(slice([], [last], undefined), 5100, 2000)).toEqual([]);
    });

    it('holds a dual-track pair together, using the later end', () => {
        // The native line usually ends a touch after the target line; dropping
        // one and keeping the other would flicker half the pair away.
        const target = cue(1000, 3000, 'ja', 0);
        const native = cue(1000, 3200, 'en', 1);
        expect(subtitlesToDisplay(slice([], [target, native], undefined), 5100, 2000)).toEqual([target, native]);
        expect(subtitlesToDisplay(slice([], [target, native], undefined), 5201, 2000)).toEqual([]);
    });

    it('is disabled only by exactly 0', () => {
        const last = cue(1000, 3000);
        expect(subtitlesToDisplay(slice([], [last], undefined), 3100, 0)).toEqual([]);
    });

    // ── hold-until-next-cue (the default) ────────────────────────────────

    it('ships the module default as the actual setting default', () => {
        // Two constants that must agree and live in different packages: the
        // controller falls back to DEFAULT_HOLD_MS, but what an unconfigured
        // user actually gets is `defaultSettings`. Changing one and not the
        // other would leave the module documenting a default nobody has.
        expect(defaultSettings.saviHoldSubtitleMs).toBe(DEFAULT_HOLD_MS);
    });

    it('defaults to a BOUNDED hold, not hold-until-next-cue', () => {
        // Flipped deliberately: unbounded-by-default parked a finished line
        // over 19s of real silence on a human-timed track (see the silence
        // test above). The sentinel is unchanged and still opt-in-able.
        expect(DEFAULT_HOLD_MS).toBeGreaterThan(0);
        expect(DEFAULT_HOLD_MS).not.toBe(HOLD_UNTIL_NEXT_CUE);
    });

    it('clears the line into genuine silence rather than papering over it', () => {
        // A professionally-timed Netflix ES track, cues 478/479: the line ends
        // at 26:27.365 and the next cue — a MUSIC cue, `[suena "Ya no más"]` —
        // is not due until 26:46.645. That 19.28s gap is real silence, not
        // speech the track failed to timestamp, and hold-until-next-cue parked
        // a finished sentence over the whole of it.
        //
        // The distinction this feature rests on (gaps are mistimed speech)
        // holds for auto-timed tracks and not for human-timed ones, and a
        // single unbounded default cannot serve both. The default is bounded;
        // HOLD_UNTIL_NEXT_CUE stays available for the auto-timed case.
        const last = cue(1584445, 1587365, 'es despedirnos de la misma manera.');
        const next = [cue(1606645, 1609525, '[suena "Ya no más"]')];

        // A brief mistimed tail is still covered...
        expect(subtitlesToDisplay(slice([], [last], next), 1588000, DEFAULT_HOLD_MS)).toEqual([last]);
        // ...but the silence is left silent.
        expect(subtitlesToDisplay(slice([], [last], next), 1592000, DEFAULT_HOLD_MS)).toEqual([]);
        expect(subtitlesToDisplay(slice([], [last], next), 1606000, DEFAULT_HOLD_MS)).toEqual([]);
    });

    it('holds across a gap far longer than any fixed cap would allow', () => {
        // The 9.04s gap that motivated the change (cue ends 4:37.60, next at
        // 4:46.64). A 2s cap left ~7s of blank mid-sentence.
        const last = cue(273480, 277600, 'long line');
        const next = [cue(286640, 291680)];
        for (const t of [278000, 281000, 284000, 286639]) {
            expect(subtitlesToDisplay(slice([], [last], next), t, HOLD_UNTIL_NEXT_CUE)).toEqual([last]);
        }
        // ...and still yields the instant the next cue is due.
        expect(subtitlesToDisplay(slice([], [last], next), 286640, HOLD_UNTIL_NEXT_CUE)).toEqual([]);
    });

    it('falls back to a bounded hold when nothing follows', () => {
        // Past the last cue there is no `nextToShow` to bound against, so an
        // unbounded hold would park the final line over the outro forever.
        const last = cue(1000, 3000);
        const atLimit = 3000 + NO_NEXT_CUE_FALLBACK_MS;
        expect(subtitlesToDisplay(slice([], [last], undefined), atLimit, HOLD_UNTIL_NEXT_CUE)).toEqual([last]);
        expect(subtitlesToDisplay(slice([], [last], undefined), atLimit + 1, HOLD_UNTIL_NEXT_CUE)).toEqual([]);
    });

    it('still refuses to resurrect a line after a backwards seek', () => {
        const last = cue(4000, 6000);
        expect(subtitlesToDisplay(slice([], [last], undefined), 2000, HOLD_UNTIL_NEXT_CUE)).toEqual([]);
    });

    it('a finite cap still works when explicitly configured', () => {
        const last = cue(1000, 3000);
        const next = [cue(20000, 22000)];
        expect(subtitlesToDisplay(slice([], [last], next), 4900, 2000)).toEqual([last]);
        expect(subtitlesToDisplay(slice([], [last], next), 5100, 2000)).toEqual([]);
    });

    it('holds nothing before the first cue', () => {
        // `lastShown` is empty at the top of a track; there is nothing to hold.
        expect(subtitlesToDisplay(slice([], [], [cue(5000, 7000)]), 1000, 2000)).toEqual([]);
        expect(subtitlesToDisplay(slice([], undefined, undefined), 1000, 2000)).toEqual([]);
    });

    it('ignores a timestamp before the held cue ended', () => {
        // Defensive: a seek backwards can put `now` behind `lastShown.end`
        // without anything showing. Holding then would resurrect an old line.
        const last = cue(4000, 6000);
        expect(subtitlesToDisplay(slice([], [last], undefined), 2000, 2000)).toEqual([]);
    });
});

describe('nextStartAfter', () => {
    const starts = [0, 1000, 5000, 5000, 9000];

    it('finds the first start strictly after the given time', () => {
        expect(nextStartAfter(starts, 0)).toBe(1000);
        expect(nextStartAfter(starts, 999)).toBe(1000);
        expect(nextStartAfter(starts, 1000)).toBe(5000);
        expect(nextStartAfter(starts, 4999)).toBe(5000);
    });

    it('skips duplicate starts and returns the next distinct one', () => {
        expect(nextStartAfter(starts, 5000)).toBe(9000);
    });

    it('returns undefined past the last cue', () => {
        expect(nextStartAfter(starts, 9000)).toBeUndefined();
        expect(nextStartAfter(starts, 99999)).toBeUndefined();
        expect(nextStartAfter([], 0)).toBeUndefined();
    });
});

describe('subtitlesToDisplay with an explicit next start', () => {
    it('prefers the caller-resolved next start over the slice', () => {
        // The bug this fixes: slice.nextToShow came back EMPTY during real
        // gaps, so the clamp never fired and holds silently fell through to
        // the 5s no-next-cue fallback. The caller resolves it instead.
        const last = cue(273480, 277600);
        const emptySlice = slice([], [last], []);
        // 9.04s gap — a fallback-bounded hold would have died at 282600.
        expect(subtitlesToDisplay(emptySlice, 284000, HOLD_UNTIL_NEXT_CUE, 286640)).toEqual([last]);
        expect(subtitlesToDisplay(emptySlice, 286640, HOLD_UNTIL_NEXT_CUE, 286640)).toEqual([]);
    });

    it('falls back to the 5s bound only when the caller has no next start', () => {
        const last = cue(1000, 3000);
        expect(subtitlesToDisplay(slice([], [last], []), 7999, HOLD_UNTIL_NEXT_CUE, undefined)).toEqual([last]);
        expect(subtitlesToDisplay(slice([], [last], []), 8001, HOLD_UNTIL_NEXT_CUE, undefined)).toEqual([]);
    });
});
