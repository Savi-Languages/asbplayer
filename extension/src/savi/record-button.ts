// A small floating "Record" control overlaid on the video for savi capture.
// It only toggles capture and reflects its state — starting/stopping (and the
// browser audio permission a manual start needs) is the capture controller's
// job. Appended to document.body; styled by video.css (.savi-record-button).
//
// Note: clicking an in-page button does NOT grant the per-tab audio permission
// (the browser only grants that for action/command/context-menu gestures), so
// the first start of a page load still needs the Ctrl+Shift+S shortcut or the
// toolbar icon. When a click can't start, the controller calls flashHint() to
// say so on the button itself. Once the permission is in place, the button
// starts/stops directly.

export type RecordButtonState = 'idle' | 'recording';

export class SaviRecordButton {
    private readonly _onToggle: () => void;
    private _button: HTMLButtonElement | null = null;
    private _label: HTMLSpanElement | null = null;
    private _state: RecordButtonState = 'idle';
    private _hintTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(onToggle: () => void) {
        this._onToggle = onToggle;
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

    setState(state: RecordButtonState) {
        this._state = state;
        clearTimeout(this._hintTimer); // a real state change supersedes any hint
        if (!this._button || !this._label) {
            return;
        }
        const recording = state === 'recording';
        this._button.classList.toggle('recording', recording);
        this._button.classList.remove('hint');
        // Show both the state and the action: idle invites a start; recording
        // says so plainly and that clicking stops it.
        this._label.textContent = recording ? 'Recording — Stop' : 'Start recording';
        this._button.title = recording
            ? 'Recording this tab for savi — click to stop'
            : 'Start recording this tab for savi (first start of a page load needs Ctrl+Shift+S)';
    }

    /** Briefly replace the label with a hint (e.g. how to enable recording),
     *  then restore the current state's label. Used when a start can't proceed
     *  — most often because the audio permission hasn't been granted yet. */
    flashHint(text: string) {
        clearTimeout(this._hintTimer);
        if (!this._button || !this._label) {
            return;
        }
        this._button.classList.add('hint');
        this._label.textContent = text;
        this._hintTimer = setTimeout(() => {
            this._button?.classList.remove('hint');
            this.setState(this._state);
        }, 3500);
    }

    destroy() {
        clearTimeout(this._hintTimer);
        this._button?.remove();
        this._button = null;
        this._label = null;
    }

    private _ensure(): HTMLButtonElement {
        if (this._button) {
            return this._button;
        }
        const button = document.createElement('button');
        button.className = 'savi-record-button';

        const dot = document.createElement('span');
        dot.className = 'savi-record-dot';
        const label = document.createElement('span');
        label.className = 'savi-record-label';
        button.appendChild(dot);
        button.appendChild(label);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._onToggle();
        });

        document.body.appendChild(button);
        this._button = button;
        this._label = label;
        this.setState(this._state);
        return button;
    }
}
