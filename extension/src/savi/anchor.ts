// Anchor savi's floating controls to the VIDEO, not the viewport.
//
// The Record button and the speed selector are `position: fixed`, which on a
// full-bleed player (Netflix, YouTube fullscreen/theater) puts them over the
// video — the intent SAVI.md describes. On YouTube's default watch page it does
// not: the viewport is much wider than the video, so
//
//   - `right: 18px; top: 18px`  lands the Record button on YouTube's own
//     masthead, directly over the Sign-in button / account avatar, and
//   - `left: 50%`               centres the speed selector on the *viewport*
//     (x≈720 at 1440px wide) rather than the *video* (x≈514), leaving it
//     floating over the recommendations sidebar.
//
// Both are interactive, so overlapping site chrome is not cosmetic: the two
// layers fight for the same clicks. This module computes viewport coordinates
// from the video's own rect, so the controls track the player through resizes,
// theater mode, and fullscreen.
//
// The geometry is a pure function so it is unit-testable without a DOM.

/** The subset of `DOMRect` the math needs. */
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export type Corner = 'top-right' | 'top-center';

/** Backstop re-measure cadence for position-only moves (see VideoAnchor). */
const POLL_MS = 500;

export interface Placement {
    left: number;
    top: number;
}

/**
 * Where to put a `control`-sized box inside `video`, `margin` px from the
 * chosen edge, clamped so the control can never leave the viewport (a tiny or
 * off-screen player must not push it out of reach).
 *
 * Returns viewport coordinates for a `position: fixed` element, so the caller
 * sets `left`/`top` and clears `right`/`transform`.
 */
export function placeInVideo(
    video: Rect,
    control: { width: number; height: number },
    corner: Corner,
    margin: number,
    viewport: { width: number; height: number }
): Placement {
    const top = video.y + margin;
    const left =
        corner === 'top-right'
            ? video.x + video.width - control.width - margin
            : video.x + (video.width - control.width) / 2;

    return {
        left: clamp(left, 0, Math.max(0, viewport.width - control.width)),
        top: clamp(top, 0, Math.max(0, viewport.height - control.height)),
    };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** A video rect is usable only when the element is actually laid out. A
 *  detached or `display:none` video reports 0×0, and anchoring to that would
 *  slam the control into the top-left corner. */
export function isUsableRect(rect: Rect | undefined): boolean {
    return rect !== undefined && rect.width > 0 && rect.height > 0;
}

/**
 * Keeps one fixed-position element pinned to the video. Re-measures on the
 * events that move a player (resize, scroll, fullscreen, YouTube's theater
 * toggle) via one rAF-coalesced callback, so a burst of resize events costs a
 * single layout read.
 */
export class VideoAnchor {
    private _frame: number | null = null;
    private _observer: ResizeObserver | null = null;
    private _observed: Element | null = null;
    private _poll: ReturnType<typeof setInterval> | null = null;
    private _lastKey = '';
    private readonly _onChange = () => this.schedule();

    constructor(
        private readonly _element: HTMLElement,
        private readonly _getVideo: () => Element | null | undefined,
        private readonly _corner: Corner,
        private readonly _margin: number
    ) {
        window.addEventListener('resize', this._onChange, { passive: true });
        window.addEventListener('scroll', this._onChange, { passive: true, capture: true });
        document.addEventListener('fullscreenchange', this._onChange);

        // Window events alone are not enough. The player commonly MOVES without
        // the window changing at all — YouTube swaps the pre-roll ad out for the
        // real video, banners appear above the masthead, theater mode reflows —
        // and a one-shot measurement then leaves the controls stranded where the
        // video used to be. Observing the video and the document element catches
        // those reflows without polling.
        if (typeof ResizeObserver !== 'undefined') {
            this._observer = new ResizeObserver(this._onChange);
            this._observer.observe(document.documentElement);
        }

        // Size observers still miss the case that actually bit us: the player
        // MOVES without resizing (banner appears/disappears above it, ad ends,
        // masthead collapses). No DOM event reports "an element changed
        // position", so a cheap 500ms rect comparison is the backstop. It only
        // reads a rect and returns unless the geometry genuinely changed.
        this._poll = setInterval(this._onChange, POLL_MS);
        this.schedule();
    }

    /** Coalesce repositions into the next frame. */
    schedule() {
        if (this._frame !== null) {
            return;
        }
        this._frame = requestAnimationFrame(() => {
            this._frame = null;
            this.apply();
        });
    }

    apply() {
        const video = this._getVideo();

        // The video element itself is swapped on ad->content transitions, so
        // re-target the observer whenever the element identity changes.
        if (video && video !== this._observed && this._observer !== null) {
            if (this._observed !== null) {
                this._observer.unobserve(this._observed);
            }
            this._observer.observe(video);
            this._observed = video;
        }

        const rect = video?.getBoundingClientRect();

        if (!isUsableRect(rect)) {
            return; // Leave the CSS fallback in place rather than pinning to 0,0.
        }

        const box = this._element.getBoundingClientRect();

        if (box.width === 0 || box.height === 0) {
            return; // Hidden (display:none) — nothing to place yet.
        }

        // Skip the write when nothing moved — this runs on a poll.
        const key = `${rect!.x},${rect!.y},${rect!.width},${rect!.height},${box.width},${box.height},${window.innerWidth},${window.innerHeight}`;

        if (key === this._lastKey) {
            return;
        }

        this._lastKey = key;

        const { left, top } = placeInVideo(
            rect as Rect,
            { width: box.width, height: box.height },
            this._corner,
            this._margin,
            { width: window.innerWidth, height: window.innerHeight }
        );

        // The stylesheet positions via `right`/`transform`; anchoring drives
        // `left`/`top`, so those must be neutralised or the two fight.
        this._element.style.right = 'auto';
        this._element.style.transform = 'none';
        this._element.style.left = `${Math.round(left)}px`;
        this._element.style.top = `${Math.round(top)}px`;
    }

    destroy() {
        if (this._poll !== null) {
            clearInterval(this._poll);
            this._poll = null;
        }
        this._observer?.disconnect();
        this._observer = null;
        this._observed = null;
        if (this._frame !== null) {
            cancelAnimationFrame(this._frame);
            this._frame = null;
        }
        window.removeEventListener('resize', this._onChange);
        window.removeEventListener('scroll', this._onChange, { capture: true } as EventListenerOptions);
        document.removeEventListener('fullscreenchange', this._onChange);
    }
}
