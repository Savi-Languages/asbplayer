// A small floating "Record" control overlaid on the video for savi capture.
// It only toggles capture and reflects its state — starting/stopping (and the
// browser audio permission a manual start needs) is the capture controller's
// job. Appended to document.body; styled by video.css (.savi-record-button).
//
// Note: clicking an in-page button does NOT grant the per-tab audio permission
// (the browser only grants that for action/command/context-menu gestures), so
// the first start of a page load still needs the Ctrl+Shift+S shortcut or the
// toolbar icon. This button is the visible control + a stop button, and works
// directly once the permission is in place.

export type RecordButtonState = 'idle' | 'recording';

export class SaviRecordButton {
    private readonly _onToggle: () => void;
    private _button: HTMLButtonElement | null = null;
    private _label: HTMLSpanElement | null = null;
    private _state: RecordButtonState = 'idle';

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
        if (!this._button || !this._label) {
            return;
        }
        const recording = state === 'recording';
        this._button.classList.toggle('recording', recording);
        this._label.textContent = recording ? 'Recording' : 'Record';
        this._button.title = recording ? 'Stop savi recording' : 'Record this tab for savi (or press Ctrl+Shift+S)';
    }

    destroy() {
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
