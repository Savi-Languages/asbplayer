// A "Replay" control that appears at the RIGHT end of the current subtitle line
// — Language-Reactor style — and only while the cursor is over the subtitle (or
// the button itself). Clicking it replays the current line: seek to its start +
// play, mirroring asbplayer's "S" key. Because it's revealed on hover, it never
// clutters passive watching and its per-line repositioning is never seen.
//
// Appended to document.body; styled by video.css (.savi-replay-button). The
// replay logic lives in the capture controller, which owns the video + subtitle
// list; this class only handles the button + its hover-gated placement.

const BOTTOM_SUBTITLES = '.asbplayer-subtitles-container-bottom';
const HIDE_GRACE_MS = 220;

export class SaviReplayButton {
    private readonly _onReplay: () => void;
    private _button: HTMLButtonElement | null = null;
    private _active = false;
    private _mouseMove?: (event: MouseEvent) => void;
    private _hideTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(onReplay: () => void) {
        this._onReplay = onReplay;
    }

    /** Arm the control: it stays hidden until the cursor is over the subtitle,
     *  then appears at the line's right edge. (Named show()/hide() to match the
     *  record button's lifecycle in the capture controller.) */
    show() {
        this._ensure();
        if (this._active) {
            return;
        }
        this._active = true;
        this._mouseMove = (event) => this._handleMove(event);
        document.addEventListener('mousemove', this._mouseMove, true);
    }

    hide() {
        this._active = false;
        if (this._mouseMove) {
            document.removeEventListener('mousemove', this._mouseMove, true);
            this._mouseMove = undefined;
        }
        this._cancelHide();
        this._conceal();
    }

    destroy() {
        this.hide();
        this._button?.remove();
        this._button = null;
    }

    private _handleMove(event: MouseEvent) {
        // Stay revealed while over the subtitle OR the button itself, so reaching
        // for it across the small gap doesn't dismiss it. A short grace covers
        // that gap when neither is under the cursor for an instant.
        if (this._overSubtitle(event.clientX, event.clientY) || this._overButton(event.clientX, event.clientY)) {
            this._cancelHide();
            this._reveal();
        } else {
            this._scheduleHide();
        }
    }

    /** Show the button just past the right edge of the current subtitle's first
     *  (target-language) line, vertically centred on it — matching Language
     *  Reactor's inline control. */
    private _reveal() {
        const btn = this._ensure();
        const line = this._lineRect();
        if (!line) {
            return;
        }
        btn.style.display = 'inline-flex';
        const b = btn.getBoundingClientRect();
        const gap = 8;
        btn.style.left = `${Math.round(line.right + gap)}px`;
        btn.style.top = `${Math.round(line.top + line.height / 2 - b.height / 2)}px`;
    }

    private _scheduleHide() {
        if (this._hideTimer !== undefined) {
            return;
        }
        this._hideTimer = setTimeout(() => {
            this._hideTimer = undefined;
            this._conceal();
        }, HIDE_GRACE_MS);
    }

    private _cancelHide() {
        if (this._hideTimer !== undefined) {
            clearTimeout(this._hideTimer);
            this._hideTimer = undefined;
        }
    }

    private _conceal() {
        if (this._button) {
            this._button.style.display = 'none';
        }
    }

    /** Rect of the current top/target-language subtitle line — the first cue
     *  span — falling back to the whole bottom container. `null` when nothing is
     *  on screen. */
    private _lineRect(): DOMRect | null {
        const container = document.querySelector(BOTTOM_SUBTITLES);
        if (!(container instanceof HTMLElement)) {
            return null;
        }
        const line = container.querySelector('[data-track]');
        const target = line instanceof HTMLElement ? line : container;
        const r = target.getBoundingClientRect();
        return r.width >= 1 && r.height >= 1 ? r : null;
    }

    private _overSubtitle(x: number, y: number): boolean {
        const container = document.querySelector(BOTTOM_SUBTITLES);
        if (!(container instanceof HTMLElement)) {
            return false;
        }
        const r = container.getBoundingClientRect();
        return r.width >= 1 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    private _overButton(x: number, y: number): boolean {
        if (!this._button || this._button.style.display === 'none') {
            return false;
        }
        const r = this._button.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
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
