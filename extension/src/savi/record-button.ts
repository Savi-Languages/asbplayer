// A small floating "Record" control overlaid on the video for savi capture.
// It only toggles capture and reflects its state — starting/stopping is the
// capture controller's job. Appended to document.body; styled by video.css
// (.savi-record-button).
//
// Since SV-18 the daemon taps browser audio itself (no tabCapture), so a
// plain in-page click starts/stops directly — no permission gesture needed.
// When a start can't proceed (daemon unreachable, no subtitles), the
// controller calls flashHint() to say so on the button itself.

import { VideoAnchor } from './anchor';

export type RecordButtonState = 'idle' | 'recording' | 'alert';

type VideoSource = () => Element | null | undefined;

export class SaviRecordButton {
    private readonly _onToggle: () => void;
    private readonly _getVideo: VideoSource | undefined;
    private _button: HTMLButtonElement | null = null;
    private _label: HTMLSpanElement | null = null;
    private _state: RecordButtonState = 'idle';
    private _hintTimer: ReturnType<typeof setTimeout> | undefined;
    private _anchor: VideoAnchor | null = null;

    // `getVideo` is optional so existing callers/tests keep working; without it
    // the button falls back to the stylesheet's viewport corner.
    constructor(onToggle: () => void, getVideo?: VideoSource) {
        this._onToggle = onToggle;
        this._getVideo = getVideo;
    }

    /** Make the control visible, creating it on first call. */
    show() {
        const button = this._ensure();
        button.style.display = 'inline-flex';
        // Anchor after display is set: a hidden element measures 0x0.
        if (this._anchor === null && this._getVideo !== undefined) {
            this._anchor = new VideoAnchor(button, this._getVideo, 'top-right', 18);
        }
        this._anchor?.schedule();
    }

    hide() {
        if (this._button) {
            this._button.style.display = 'none';
        }
    }

    /** Re-measure against the video (player resized, theater/fullscreen). */
    reposition() {
        this._anchor?.schedule();
    }

    setState(state: RecordButtonState) {
        this._state = state;
        clearTimeout(this._hintTimer); // a real state change supersedes any hint
        if (!this._button || !this._label) {
            return;
        }
        this._button.classList.toggle('recording', state === 'recording');
        this._button.classList.toggle('alert', state === 'alert');
        this._button.classList.remove('hint');
        // idle invites a start; recording says so plainly and that clicking
        // stops it; alert shouts that a playing video is NOT being recorded
        // (e.g. a reload dropped it) and how to resume.
        let label = 'Start recording';
        let title = 'Start capturing this episode for savi';
        if (state === 'recording') {
            label = 'Recording — Stop';
            title = 'Capturing this episode for savi — click to stop';
        } else if (state === 'alert') {
            label = '● NOT RECORDING';
            title = 'Not recording — click to resume (or press Ctrl+Shift+S)';
        }
        this._label.textContent = label;
        this._button.title = title;
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
        this._anchor?.destroy();
        this._anchor = null;
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
