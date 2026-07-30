// "Is the user actually here?" — the one signal SV-21's engagement clock
// needs that the extension did not previously have anywhere.
//
// The clock counts a PAUSED video as engaged time only while the user is
// demonstrably present (hovering a word for a gloss, scrubbing, reading the
// line again). Nothing in the extension tracked that: the capture controller's
// video listeners exist only while a capture is recording, and the gloss
// controllers only fire on their own narrow interactions.
//
// Timestamps are MONOTONIC (performance.now), matching the clock's `now`.
// Wall time would let an NTP correction make a present user look idle.

/** Coarse enough that a moving mouse costs ~nothing; far finer than the
 *  60 s idle window it feeds. */
const MOUSEMOVE_THROTTLE_MS = 500;

export class SaviInteractionClock {
    private _last = 0;
    private _lastMouseMove = 0;
    private _listening = false;
    private readonly _now: () => number;
    private readonly _onActivity = () => this.note();
    private readonly _onMouseMove = () => {
        const now = this._now();
        if (now - this._lastMouseMove < MOUSEMOVE_THROTTLE_MS) {
            return;
        }
        this._lastMouseMove = now;
        this.note();
    };

    constructor(now: () => number = () => performance.now()) {
        this._now = now;
        this._last = now();
    }

    /** Monotonic timestamp of the last observed interaction. */
    get lastInteractionAt(): number {
        return this._last;
    }

    /** Record an interaction. Public so savi's own signals — a hover-gloss
     *  reveal, the JA word panel, a subtitle click — can feed the same clock;
     *  those are the STRONGEST evidence that a paused line is being studied,
     *  and some of them (a hover held still) produce no further DOM events. */
    note(): void {
        this._last = this._now();
    }

    bind(): void {
        if (this._listening) {
            return;
        }
        this._listening = true;
        // Capture phase + passive: the page cannot stop these from reaching us
        // (fullscreen players stop propagation liberally), and passive means we
        // never delay a scroll or a click.
        const opts = { capture: true, passive: true } as const;
        document.addEventListener('keydown', this._onActivity, opts);
        document.addEventListener('pointerdown', this._onActivity, opts);
        document.addEventListener('wheel', this._onActivity, opts);
        document.addEventListener('mousemove', this._onMouseMove, opts);
    }

    unbind(): void {
        if (!this._listening) {
            return;
        }
        this._listening = false;
        const opts = { capture: true } as const;
        document.removeEventListener('keydown', this._onActivity, opts);
        document.removeEventListener('pointerdown', this._onActivity, opts);
        document.removeEventListener('wheel', this._onActivity, opts);
        document.removeEventListener('mousemove', this._onMouseMove, opts);
    }
}
