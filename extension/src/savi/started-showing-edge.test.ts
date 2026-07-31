// SV-28 regression: the watched-line pipeline must see each subtitle display
// exactly once. SubtitleCollection.subtitlesAt() is level-triggered — it
// reports `startedShowing` on every poll tick whose timestamp falls within
// showingCheckRadiusMs of the line's start, and on every tick indefinitely
// while playback is paused inside that window. The subtitle controller
// therefore routes the savi hook through a dedicated AutoPauseContext, whose
// start-equality dedup turns the level signal into an edge. These tests drive
// the real collection + the real guard exactly the way the controller's 100 ms
// poll loop does, and would fail against the pre-SV-28 raw wiring.

import { AutoPauseContext, SubtitleModel } from '@project/common';
import { SubtitleCollection } from '@project/common/subtitle-collection';

// The controller's constants (subtitle-controller.ts): 100 ms poll interval,
// 150 ms showing-check radius.
const POLL_MS = 100;
const RADIUS_MS = 150;

const line = (text: string, start: number, end: number): SubtitleModel => ({
    text,
    start,
    end,
    originalStart: start,
    originalEnd: end,
    track: 0,
});

interface Harness {
    collection: SubtitleCollection<SubtitleModel>;
    guard: AutoPauseContext;
    fired: SubtitleModel[];
    rawFired: SubtitleModel[];
    tick: (mediaTimeMs: number) => void;
}

const harness = (subtitles: SubtitleModel[]): Harness => {
    const collection = new SubtitleCollection<SubtitleModel>({
        showingCheckRadiusMs: RADIUS_MS,
        returnLastShown: true,
        returnNextToShow: true,
    });
    collection.setSubtitles(subtitles);
    const guard = new AutoPauseContext();
    const fired: SubtitleModel[] = [];
    const rawFired: SubtitleModel[] = [];
    guard.onStartedShowing = (s) => fired.push(s);
    const tick = (mediaTimeMs: number) => {
        const slice = collection.subtitlesAt(mediaTimeMs);
        if (slice.startedShowing) {
            rawFired.push(slice.startedShowing);
            guard.startedShowing(slice.startedShowing);
        }
    };
    return { collection, guard, fired, rawFired, tick };
};

it('fires once per line during normal playback', () => {
    const a = line('hola', 1000, 3000);
    const b = line('chau', 3200, 5000);
    const h = harness([a, b]);

    for (let t = 0; t <= 6000; t += POLL_MS) {
        h.tick(t);
    }

    expect(h.fired).toEqual([a, b]);
    // The raw level-triggered signal really does repeat (two 100 ms ticks fit
    // inside the 150 ms radius) — the exact double-count this guard exists
    // for. If this assertion ever fails, the collection went edge-triggered
    // and the guard is redundant.
    expect(h.rawFired.length).toBeGreaterThan(2);
});

it('fires once while paused inside the start window, not once per tick', () => {
    const a = line('sos vos, Martina', 1000, 4000);
    const h = harness([a]);

    // Paused at 1050 ms — inside start + 150 ms, so every poll reports the
    // line as startedShowing. Five minutes of the controller's 100 ms polls.
    const pausedTicks = (5 * 60 * 1000) / POLL_MS;
    for (let i = 0; i < pausedTicks; i++) {
        h.tick(1050);
    }

    expect(h.fired).toEqual([a]);
    expect(h.rawFired.length).toBe(pausedTicks);
});

it('fires again when the same line re-shows after another line (seek back)', () => {
    const a = line('hola', 1000, 3000);
    const b = line('chau', 3200, 5000);
    const h = harness([a, b]);

    h.tick(1000); // a shows
    h.tick(3200); // b shows
    h.tick(1000); // seek back: a re-shows — a fresh encounter
    expect(h.fired).toEqual([a, b, a]);
});

it('re-arms on clear, as on a subtitle reload', () => {
    const a = line('hola', 1000, 3000);
    const h = harness([a]);

    h.tick(1000);
    h.guard.clear();
    h.tick(1050);
    expect(h.fired).toEqual([a, a]);
});
