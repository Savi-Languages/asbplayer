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

    constructor(onReplay: () => void) {
        this._onReplay = onReplay;
    }

    /** Make the control visible, creating it on first call. */
    show() {
        this._ensure().style.display = 'inline-flex';
    }

    hide() {
        if (this._button) {
            this._button.style.display = 'none';
        }
    }

    destroy() {
        this._button?.remove();
        this._button = null;
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
