// ⚠️ TWIN FILE — keep identical to the savi monorepo's
// `packages/ui/src/lib/engagementClock.test.ts` (modulo the import line and
// vitest-vs-jest globals). Copying the table is the whole mechanism that makes
// the two clock implementations visibly diverge if one is edited alone.

import {
    activeKind,
    DEFAULT_MAX_SESSION_MS,
    EngagementClock,
    type ActivityKind,
    type ClockInputs,
    type SessionFlush,
} from './engagement-clock';

const WALL0 = 1_753_189_200_000;

function inputs(over: Partial<ClockInputs> = {}): ClockInputs {
    return { playing: false, visible: true, focused: true, lastInteractionAt: 0, ...over };
}

function clock(over: Partial<Parameters<typeof makeOpts>[0]> = {}) {
    const flushes: SessionFlush[] = [];
    const c = new EngagementClock({ ...makeOpts(over), onFlush: (s) => flushes.push(s) });
    return { c, flushes };
}

function makeOpts(over: {
    foregroundKind?: ActivityKind;
    backgroundKind?: ActivityKind | null;
    idleMs?: number;
    maxTickDeltaMs?: number;
    maxSessionMs?: number;
    minSessionMs?: number;
}) {
    return {
        foregroundKind: 'watch' as ActivityKind,
        backgroundKind: 'listen' as ActivityKind | null,
        idleMs: 60_000,
        maxTickDeltaMs: 5_000,
        maxSessionMs: DEFAULT_MAX_SESSION_MS,
        minSessionMs: 5_000,
        ...over,
    };
}

/** Drive the clock for `steps` ticks of `stepMs`, starting at monotonic 0. */
function run(
    c: EngagementClock,
    steps: number,
    stepMs: number,
    build: (i: number) => ClockInputs,
    startAt = 0
): number {
    let now = startAt;
    for (let i = 0; i < steps; i++) {
        c.tick(now, WALL0 + now, build(i));
        now += stepMs;
    }
    return now;
}

describe('activeKind — the truth table IS the spec', () => {
    const opts = { foregroundKind: 'watch' as const, backgroundKind: 'listen' as const, idleMs: 60_000 };

    it('playing + attended → foreground', () => {
        expect(activeKind(inputs({ playing: true }), 0, opts)).toBe('watch');
    });

    it('playing + hidden or unfocused → background (audio still reaches them)', () => {
        expect(activeKind(inputs({ playing: true, visible: false }), 0, opts)).toBe('listen');
        expect(activeKind(inputs({ playing: true, focused: false }), 0, opts)).toBe('listen');
    });

    it('paused + attended + recently interacted → foreground (studying a line)', () => {
        const i = inputs({ playing: false, lastInteractionAt: 0 });
        expect(activeKind(i, 59_000, opts)).toBe('watch');
        // The idle window is INCLUSIVE at its edge.
        expect(activeKind(i, 60_000, opts)).toBe('watch');
    });

    it('paused + attended + idle → nothing', () => {
        expect(activeKind(inputs({ lastInteractionAt: 0 }), 60_001, opts)).toBeNull();
    });

    it('paused + away → nothing, however recent the interaction', () => {
        expect(activeKind(inputs({ visible: false, lastInteractionAt: 0 }), 0, opts)).toBeNull();
        expect(activeKind(inputs({ focused: false, lastInteractionAt: 0 }), 0, opts)).toBeNull();
    });

    it('paused BEFORE the first play → nothing, even attended and active', () => {
        // The founder timed a 39:19 watch that Savi recorded as 41:19. This
        // was the leak: browsing to a title with the tab focused and the mouse
        // moving credited `watch` before a single frame had played.
        const i = inputs({ playing: false, lastInteractionAt: 0, everPlayed: false });
        expect(activeKind(i, 1_000, opts)).toBeNull();
    });

    it('paused AFTER the end → nothing (the credits are not exposure)', () => {
        const i = inputs({ playing: false, lastInteractionAt: 0, everPlayed: true, ended: true });
        expect(activeKind(i, 1_000, opts)).toBeNull();
    });

    it('paused MID-viewing still counts — that is the studying case', () => {
        // The half of the rule the founder explicitly asked to keep: pausing
        // to hover a word is learning, and must not be collateral damage.
        const i = inputs({ playing: false, lastInteractionAt: 0, everPlayed: true, ended: false });
        expect(activeKind(i, 1_000, opts)).toBe('watch');
    });

    it('omitting the media flags preserves the reviewer, which has no media', () => {
        // `everPlayed` defaults true and `ended` false precisely so a surface
        // with nothing to play is unaffected — presence IS the activity there.
        const reviewer = { foregroundKind: 'flashcard' as const, backgroundKind: null, idleMs: 60_000 };
        expect(activeKind(inputs({ lastInteractionAt: 0 }), 1_000, reviewer)).toBe('flashcard');
    });

    it('a null backgroundKind means an unattended surface accrues nothing', () => {
        // The reviewer's configuration: a hidden tab is not reviewing.
        const reviewer = { foregroundKind: 'flashcard' as const, backgroundKind: null, idleMs: 60_000 };
        expect(activeKind(inputs({ playing: true, visible: false }), 0, reviewer)).toBeNull();
        // …but present-and-typing still counts, with playing:false throughout.
        expect(activeKind(inputs({ lastInteractionAt: 0 }), 1_000, reviewer)).toBe('flashcard');
    });
});

describe('EngagementClock', () => {
    it('credits nothing on the first tick (no interval has elapsed yet)', () => {
        const { c, flushes } = clock();
        c.tick(0, WALL0, inputs({ playing: true }));
        expect(c.openMs).toBe(0);
        c.flush();
        expect(flushes).toEqual([]);
    });

    it('accrues the gap between ticks while playing', () => {
        const { c, flushes } = clock();
        run(c, 11, 1_000, () => inputs({ playing: true })); // 10 credited intervals
        c.flush();
        expect(flushes).toHaveLength(1);
        expect(flushes[0]).toMatchObject({ kind: 'watch', engagedMs: 10_000, startedAtMs: WALL0 });
        expect(flushes[0].endedAtMs).toBe(WALL0 + 10_000);
    });

    it('discards an oversized delta — the slept-laptop guard', () => {
        const { c, flushes } = clock();
        c.tick(0, WALL0, inputs({ playing: true }));
        // Eight hours later the timer fires again. Crediting this would invent a
        // whole night of study.
        const eightHours = 8 * 60 * 60_000;
        c.tick(eightHours, WALL0 + eightHours, inputs({ playing: true }));
        expect(c.openMs).toBe(0);

        // …and the clock keeps working normally afterwards.
        run(c, 6, 1_000, () => inputs({ playing: true }), eightHours);
        c.flush();
        expect(flushes).toHaveLength(1);
        expect(flushes[0].engagedMs).toBe(5_000);
    });

    it('keeps counting while paused if the user is interacting, and stops when they go idle', () => {
        const { c, flushes } = clock();
        // 10 s paused-but-hovering: interaction stays fresh.
        run(c, 11, 1_000, (i) => inputs({ playing: false, lastInteractionAt: i * 1_000 }));
        expect(c.openMs).toBe(10_000);

        // Then they walk away. The block closes on the next tick after the idle
        // window lapses (the clock is sampled, not event-driven) — and note the
        // 60 s gap is itself discarded as an oversized delta, so walking away
        // never retroactively credits the time spent away.
        c.tick(80_000, WALL0 + 80_000, inputs({ playing: false, lastInteractionAt: 10_000 }));
        expect(flushes).toHaveLength(1);
        expect(flushes[0].engagedMs).toBe(10_000);
        expect(c.openMs).toBe(0);
    });

    it('splits into two blocks when the user backgrounds a playing video', () => {
        // The headline behaviour: the same video becomes `listen` the moment they
        // stop watching it, because they're only hearing it now.
        const { c, flushes } = clock();
        run(c, 11, 1_000, () => inputs({ playing: true })); // 10 s watching
        run(c, 10, 1_000, () => inputs({ playing: true, visible: false }), 10_000); // 9 s hearing
        c.flush();

        expect(flushes.map((f) => [f.kind, f.engagedMs])).toEqual([
            ['watch', 10_000],
            ['listen', 9_000],
        ]);
    });

    it('chunks a long sitting at maxSessionMs', () => {
        // Sessions are immutable once sent — ingest is idempotent on the id and
        // would DROP a re-send carrying a bigger total — so a long stretch must
        // arrive as several rows.
        const { c, flushes } = clock({ maxSessionMs: 10_000 });
        run(c, 26, 1_000, () => inputs({ playing: true })); // 25 s
        c.flush();

        expect(flushes.map((f) => f.engagedMs)).toEqual([10_000, 10_000, 5_000]);
        expect(flushes.every((f) => f.kind === 'watch')).toBe(true);
    });

    it('drops a block below minSessionMs instead of emitting noise', () => {
        const { c, flushes } = clock({ minSessionMs: 5_000 });
        run(c, 4, 1_000, () => inputs({ playing: true })); // only 3 s
        c.flush();
        expect(flushes).toEqual([]);
    });

    it('reset() discards without emitting; flush() emits', () => {
        const { c, flushes } = clock();
        run(c, 11, 1_000, () => inputs({ playing: true }));
        c.reset();
        expect(flushes).toEqual([]);
        expect(c.openMs).toBe(0);

        run(c, 11, 1_000, () => inputs({ playing: true }), 100_000);
        c.flush();
        expect(flushes).toHaveLength(1);
    });

    it('does not double-emit when flush() is called twice', () => {
        // pagehide and unmount can both fire.
        const { c, flushes } = clock();
        run(c, 11, 1_000, () => inputs({ playing: true }));
        c.flush();
        c.flush();
        expect(flushes).toHaveLength(1);
    });

    it('ignores a backward wall clock — credit comes from the monotonic clock', () => {
        // An NTP correction mid-session moves Date.now() backwards by an hour.
        // Duration must be unaffected; only the stamps move.
        const { c, flushes } = clock({ minSessionMs: 1_000 });
        c.tick(0, WALL0, inputs({ playing: true }));
        c.tick(1_000, WALL0 - 3_600_000, inputs({ playing: true }));
        c.tick(2_000, WALL0 - 3_600_000 + 1_000, inputs({ playing: true }));
        c.flush();

        expect(flushes).toHaveLength(1);
        expect(flushes[0].engagedMs).toBe(2_000);
        // The span the stamps describe is now nonsense (ended < started), which
        // is exactly the case savi-core's sanitize() repairs by rebuilding the
        // span from the credit rather than discarding it.
        expect(flushes[0].endedAtMs).toBeLessThan(flushes[0].startedAtMs);
    });

    it('tolerates repeated ticks at the same instant', () => {
        // PlayerView ticks from both an interval and timeupdate; the two can land
        // together, and a zero delta must not be credited or crash anything.
        const { c } = clock();
        c.tick(0, WALL0, inputs({ playing: true }));
        for (let i = 0; i < 10; i++) c.tick(1_000, WALL0 + 1_000, inputs({ playing: true }));
        expect(c.openMs).toBe(1_000);
    });

    it('never credits more than the wall time that actually elapsed (fuzz)', () => {
        // The invariant the server also enforces: engagedMs <= the span it covers.
        const { c, flushes } = clock({ maxSessionMs: 30_000 });
        const rand = mulberry32(0xbeef);
        let now = 0;
        for (let i = 0; i < 200; i++) {
            const step = Math.floor(rand() * 9_000); // straddles maxTickDeltaMs
            now += step;
            c.tick(now, WALL0 + now, {
                playing: rand() > 0.4,
                visible: rand() > 0.2,
                focused: rand() > 0.2,
                lastInteractionAt: now - Math.floor(rand() * 90_000),
            });
        }
        c.flush();

        const total = flushes.reduce((n, f) => n + f.engagedMs, 0);
        expect(total).toBeLessThanOrEqual(now);
        for (const f of flushes) {
            expect(f.engagedMs).toBeGreaterThan(0);
            expect(f.engagedMs).toBeLessThanOrEqual(f.endedAtMs - f.startedAtMs);
            expect(f.engagedMs).toBeLessThanOrEqual(30_000);
        }
    });

    it('emits blocks the daemon route will accept unchanged', () => {
        // Guards the seam against savi-core's sanitize(): anything this clock
        // emits should pass the server's clamps untouched, or credit silently
        // shrinks on ingest.
        const { c, flushes } = clock();
        run(c, 400, 1_000, () => inputs({ playing: true }));
        c.flush();

        expect(flushes.length).toBeGreaterThan(1);
        for (const f of flushes) {
            expect(f.engagedMs).toBeLessThanOrEqual(DEFAULT_MAX_SESSION_MS);
            expect(f.engagedMs).toBeLessThanOrEqual(f.endedAtMs - f.startedAtMs);
            expect(Number.isInteger(f.engagedMs)).toBe(true);
        }
    });

    it('calls onFlush exactly once per closed block', () => {
        const onFlush = jest.fn();
        const c = new EngagementClock({ ...makeOpts({ maxSessionMs: 10_000 }), onFlush });
        run(c, 26, 1_000, () => inputs({ playing: true }));
        c.flush();
        expect(onFlush).toHaveBeenCalledTimes(3);
    });
});

/** Small deterministic PRNG so the fuzz case is reproducible. */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
