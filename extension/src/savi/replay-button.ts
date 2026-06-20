// A small floating "Replay" control overlaid on the video. Re-plays the current
// subtitle line — seek to its start and play — mirroring asbplayer's "S" (seek
// to the beginning of the current subtitle). It's a sentence-level action (not
// tied to any one word), handy when watching with auto-pause on: replay the
// line before proceeding. Appended to document.body; styled by video.css
// (.savi-replay-button). The replay logic itself lives in the capture
// controller, which owns the video + subtitle list.

export class SaviReplayButton {
    private readonly _onReplay: () => void;
    private _button: HTMLButtonElement | null = null;
    private _rafId: number | null = null;

    constructor(onReplay: () => void) {
        this._onReplay = onReplay;
    }

    /** Make the control visible, creating it on first call, and start pinning it
     *  to the live subtitle position. */
    show() {
        this._ensure().style.display = 'inline-flex';
        this._startTracking();
    }

    hide() {
        this._stopTracking();
        if (this._button) {
            this._button.style.display = 'none';
        }
    }

    destroy() {
        this._stopTracking();
        this._button?.remove();
        this._button = null;
    }

    private _startTracking() {
        if (this._rafId !== null) {
            return;
        }
        const loop = () => {
            this._positionBySubtitle();
            this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
    }

    private _stopTracking() {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
    }

    /** Pin the button just to the LEFT of the current bottom subtitle, vertically
     *  centred on it — so it sits right where the eyes/cursor rest when auto-pause
     *  stops on a line, and never overlaps the text. The bottom subtitle container
     *  is an inline-block whose rect tightly wraps the visible text. While no
     *  subtitle is on screen the button keeps its last position (no flicker). */
    private _positionBySubtitle() {
        const btn = this._button;
        if (!btn) {
            return;
        }
        const sub = document.querySelector('.asbplayer-subtitles-container-bottom');
        if (!(sub instanceof HTMLElement)) {
            return;
        }
        const r = sub.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) {
            return; // no subtitle on screen right now — stay put
        }
        const b = btn.getBoundingClientRect();
        // One fixed spot, anchored to the subtitle's STABLE references so it
        // never moves as lines change (it only follows the subtitle on a video
        // resize / fullscreen toggle, which is correct):
        //  • Horizontal: the cue's CENTRE is the video centre (cues are centred),
        //    so it's stable regardless of line length. Sit a fixed distance left
        //    of it instead of tracking the per-line left edge (which slid).
        //  • Vertical: the cue stack grows UPWARD from a fixed bottom, so its
        //    bottom edge is the stable anchor (its top/centre move with line
        //    count). Anchor there so the button holds a steady height.
        const centreX = r.left + r.width / 2;
        const left = Math.max(8, centreX - 250 - b.width);
        const top = r.bottom - b.height;
        btn.style.left = `${Math.round(left)}px`;
        btn.style.top = `${Math.round(top)}px`;
    }

    private _ensure(): HTMLButtonElement {
        if (this._button) {
            return this._button;
        }
        const button = document.createElement('button');
        button.className = 'savi-replay-button';
        button.title = 'Replay this subtitle line (like the S key)';

        const icon = document.createElement('span');
        icon.className = 'savi-replay-icon';
        icon.textContent = '↻';
        const label = document.createElement('span');
        label.textContent = 'Replay';
        button.appendChild(icon);
        button.appendChild(label);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._onReplay();
        });

        document.body.appendChild(button);
        this._button = button;
        return button;
    }
}
