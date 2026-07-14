// Keep the subtitles clear of the streaming player's control bar.
//
// asbplayer anchors the bottom subtitle's bottom edge a fixed offset above the
// video's bottom (the `subtitlePositionOffset` setting, default 75px) — which is
// exactly the strip where Netflix's progress bar lives when the controls are up.
// Both layers are interactive, so they fight over the mouse: the progress bar is
// hard to click under the subtitle, and hovering subtitle words gets flaky.
//
// This watches the site's bottom-controls element and lifts the subtitle overlay
// just above it while it is visible, restoring the user's configured offset when
// it hides — so subs sit low during normal watching and move out of the way the
// moment the controls appear. Runtime-only: the setting itself is never written.
//
// Site coverage is a pure hostname → selector map (same pattern as
// native-subtitle-hider); unknown hosts are a no-op.

/** CSS selector for the site's bottom controls (progress bar + buttons), or
 *  undefined when we don't know this site. Pure — unit-testable. */
export function controlsSelectorForHost(host: string): string | undefined {
    if (host === 'netflix.com' || host.endsWith('.netflix.com')) {
        return '.watch-video--bottom-controls-container';
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        return '.ytp-chrome-bottom';
    }
    return undefined;
}

/** The bottom offset (px above the video's bottom edge) that places the
 *  subtitle's bottom just above controls whose top edge is at `controlsTop`.
 *  Pure — unit-testable. */
export function clearanceOffsetPx(videoBottom: number, controlsTop: number, marginPx: number): number {
    return Math.max(0, Math.ceil(videoBottom - controlsTop) + marginPx);
}

/** Visible enough to matter: laid out with height, not display/visibility/opacity
 *  hidden. Netflix unmounts its controls entirely (height 0 when absent);
 *  YouTube fades them via opacity. */
export function controlsVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.height < 1) {
        return false;
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05;
}

export interface ControlsClearanceSources {
    /** The bound media element, for its bottom edge. */
    readonly video: () => HTMLMediaElement | null | undefined;
    /** Apply an effective bottom offset to the subtitle overlay (runtime only —
     *  never persisted; the binding routes this to the subtitle controller). */
    readonly applyOffset: (px: number) => void;
}

const POLL_MS = 300;
const MARGIN_PX = 10;

export class SaviControlsClearance {
    private readonly _sources: ControlsClearanceSources;

    /** The user's configured resting offset (the `subtitlePositionOffset`
     *  setting). The binding refreshes this whenever settings (re)load. */
    baseOffsetPx = 75;

    private _selector?: string;
    private _timer?: ReturnType<typeof setInterval>;
    private _applied?: number; // last offset applied, so ticks without change are free

    constructor(sources: ControlsClearanceSources) {
        this._sources = sources;
    }

    start(): void {
        this._selector = controlsSelectorForHost(location.hostname);
        if (this._selector === undefined || this._timer !== undefined) {
            return; // unknown site (no-op) or already running
        }
        this._timer = setInterval(() => this._tick(), POLL_MS);
    }

    stop(): void {
        if (this._timer !== undefined) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
        this._applied = undefined;
    }

    private _tick(): void {
        const video = this._sources.video();
        if (!video) {
            return;
        }
        let effective = this.baseOffsetPx;
        const controls = this._selector ? document.querySelector(this._selector) : null;
        if (controls !== null && controlsVisible(controls)) {
            const controlsTop = controls.getBoundingClientRect().top;
            const videoBottom = video.getBoundingClientRect().bottom;
            // Never drop below the user's resting offset — only lift.
            effective = Math.max(this.baseOffsetPx, clearanceOffsetPx(videoBottom, controlsTop, MARGIN_PX));
        }
        if (effective !== this._applied) {
            this._applied = effective;
            this._sources.applyOffset(effective);
        }
    }
}
