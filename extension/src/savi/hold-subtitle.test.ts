import { DEFAULT_HOLD_MS, HOLD_UNTIL_NEXT_CUE, NO_NEXT_CUE_FALLBACK_MS, subtitlesToDisplay } from './hold-subtitle';

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

    it('defaults to holding until the next cue', () => {
        expect(DEFAULT_HOLD_MS).toBe(HOLD_UNTIL_NEXT_CUE);
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
