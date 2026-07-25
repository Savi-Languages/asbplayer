// The engagement clock (SV-21): turns a stream of "what is happening right
// now" samples into blocks of actively-engaged learning time.
//
// ⚠️ TWIN FILE. An identical copy lives in the savi monorepo at
// `packages/ui/src/lib/engagementClock.ts`, along with an identical test
// table. The two repos share no package, and a package for ~150 lines of pure
// logic would cost more than it saves — so they are deliberately duplicated,
// and the copied tests are what make a divergence visible as a test diff.
// Change one, change both.
//
// The clock is deliberately ignorant of ids, languages, sources, and HTTP: an
// adapter stamps those at flush time. That keeps it testable as a pure fold
// and — because the adapter mints a fresh UUID per flush — guarantees no id is
// ever reused.

/** What the user is doing, and so how deeply they are processing the language.
 *  Mirrors savi-core's `ActivityKind` (snake_case canon). */
export type ActivityKind = 'flashcard' | 'watch' | 'relisten' | 'listen' | 'ambient';

/** A sample of the world at one instant. */
export interface ClockInputs {
    /** Media is actually advancing. A card reviewer passes `false` and leans on
     *  interaction recency instead. */
    playing: boolean;
    /** `document.visibilityState === "visible"` */
    visible: boolean;
    /** `document.hasFocus()` */
    focused: boolean;
    /** When the user last did anything on this surface, on the SAME MONOTONIC
     *  clock as `tick`'s `now` — not wall time. A clock step must not be able to
     *  make a present user look idle. */
    lastInteractionAt: number;
}

/** A closed block, ready for an adapter to stamp and send. */
export interface SessionFlush {
    kind: ActivityKind;
    /** Accrued engaged milliseconds — always ≤ `endedAtMs - startedAtMs`. */
    engagedMs: number;
    /** Wall clock (epoch ms, UTC) of the first accrual. */
    startedAtMs: number;
    /** Wall clock (epoch ms, UTC) of the last accrual. */
    endedAtMs: number;
}

export interface EngagementClockOptions {
    /** Kind while playing AND attended, and while paused but recently touched. */
    foregroundKind: ActivityKind;
    /** Kind while playing but NOT attended — the user can only hear it.
     *  `"listen"` for video in a hidden tab; `"relisten"` for the audio player
     *  (backgrounding audio is still relistening); `null` for a card reviewer,
     *  where a hidden tab means nobody is reviewing. */
    backgroundKind: ActivityKind | null;
    /** How long after an interaction a PAUSED surface still counts. */
    idleMs?: number;
    /** Deltas larger than this are discarded rather than credited — the guard
     *  against a slept laptop or a throttled background timer waking up and
     *  claiming hours in a single tick. */
    maxTickDeltaMs?: number;
    /** Close and reopen at this much accrued time. */
    maxSessionMs?: number;
    /** Blocks shorter than this are dropped instead of emitted as noise. */
    minSessionMs?: number;
    onFlush(session: SessionFlush): void;
}

export const DEFAULT_IDLE_MS = 60_000;
export const DEFAULT_MAX_TICK_DELTA_MS = 5_000;
/** Must match savi-core's `MAX_SESSION_MS` — the server clamps to it, so a
 *  larger value here would silently lose credit on ingest. */
export const DEFAULT_MAX_SESSION_MS = 5 * 60_000;
export const DEFAULT_MIN_SESSION_MS = 5_000;

interface OpenSession {
    kind: ActivityKind;
    engagedMs: number;
    startedAtMs: number;
    endedAtMs: number;
}

/**
 * Decide what the user is doing, or `null` for "not engaged".
 *
 * Exported for the test table — the truth table IS the specification.
 */
export function activeKind(
    inputs: ClockInputs,
    now: number,
    opts: { foregroundKind: ActivityKind; backgroundKind: ActivityKind | null; idleMs: number }
): ActivityKind | null {
    const attended = inputs.visible && inputs.focused;

    // Playing: attended means they're watching it; unattended means the audio is
    // still reaching them, which is a real (shallower) kind of exposure.
    if (inputs.playing) return attended ? opts.foregroundKind : opts.backgroundKind;

    // Paused and away: nothing is reaching them at all.
    if (!attended) return null;

    // Paused but present and recently active — hovering a word for a gloss,
    // reading the line again. That is studying, not idling.
    return now - inputs.lastInteractionAt <= opts.idleMs ? opts.foregroundKind : null;
}

/**
 * Accumulates engaged time and emits closed blocks.
 *
 * Feed it `tick()` on any cadence (1 s is plenty); it is safe to over-tick,
 * since credit comes from the delta between ticks rather than from their
 * count. Time is measured on a MONOTONIC clock and only *stamped* with wall
 * time, so an NTP correction or a user editing the system clock cannot mint or
 * destroy credit.
 */
export class EngagementClock {
    private readonly opts: Required<Omit<EngagementClockOptions, 'onFlush'>> & Pick<EngagementClockOptions, 'onFlush'>;
    private lastTickAt: number | null = null;
    private open: OpenSession | null = null;

    constructor(options: EngagementClockOptions) {
        this.opts = {
            idleMs: DEFAULT_IDLE_MS,
            maxTickDeltaMs: DEFAULT_MAX_TICK_DELTA_MS,
            maxSessionMs: DEFAULT_MAX_SESSION_MS,
            minSessionMs: DEFAULT_MIN_SESSION_MS,
            ...options,
        };
    }

    /**
     * Advance the clock.
     *
     * @param now      monotonic ms (`performance.now()`) — measures duration
     * @param wallNow  epoch ms (`Date.now()`) — only ever stamps the block
     */
    tick(now: number, wallNow: number, inputs: ClockInputs): void {
        // 1. Credit the interval that just elapsed to whatever was open THROUGH
        //    it — the kind held for that whole span, so it is credited before any
        //    transition below.
        const delta = this.lastTickAt === null ? 0 : now - this.lastTickAt;
        const creditable = delta > 0 && delta <= this.opts.maxTickDeltaMs;
        if (this.open && creditable) {
            this.open.engagedMs += delta;
            this.open.endedAtMs = wallNow;
        }
        this.lastTickAt = now;

        // 2. Re-evaluate, and close the block if what they're doing changed
        //    (including changing to "nothing").
        const next = activeKind(inputs, now, this.opts);
        if (this.open && this.open.kind !== next) this.flushOpen();

        // 3. Open a block if they're engaged and none is running.
        if (next !== null && !this.open) {
            this.open = { kind: next, engagedMs: 0, startedAtMs: wallNow, endedAtMs: wallNow };
        }

        // 4. Chunk long stretches. Sessions are immutable once sent (ingest is
        //    idempotent on the id and would DROP a re-send carrying a larger
        //    total), so a long sitting has to arrive as several rows.
        if (this.open && this.open.engagedMs >= this.opts.maxSessionMs) {
            this.flushOpen();
            this.open = { kind: next!, engagedMs: 0, startedAtMs: wallNow, endedAtMs: wallNow };
        }
    }

    /** Emit whatever has accrued — for unmount, `pagehide`, or sign-out. */
    flush(): void {
        this.flushOpen();
        this.lastTickAt = null;
    }

    /** Drop whatever has accrued WITHOUT emitting it (e.g. the user switched to
     *  a different episode and the credit belongs to neither). */
    reset(): void {
        this.open = null;
        this.lastTickAt = null;
    }

    /** Accrued ms in the block currently open — for tests and diagnostics. */
    get openMs(): number {
        return this.open?.engagedMs ?? 0;
    }

    private flushOpen(): void {
        const open = this.open;
        this.open = null;
        if (!open) return;
        // Sub-threshold blocks are noise: a stray focus event on the way past a
        // tab shouldn't become a row.
        if (open.engagedMs < this.opts.minSessionMs) return;
        this.opts.onFlush({
            kind: open.kind,
            engagedMs: Math.round(open.engagedMs),
            startedAtMs: open.startedAtMs,
            endedAtMs: open.endedAtMs,
        });
    }
}
