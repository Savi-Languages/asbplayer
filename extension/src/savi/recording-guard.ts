// Orchestrates the "you're not recording" guard: a loud record button, a central
// banner, and a one-shot audio chime. Raised when a video is playing but capture
// is OFF — either a reload silently dropped it, or it was never started this
// episode — and dropped the moment recording resumes. The loud button persists as
// the standing signal; the banner can be dismissed. Owns no capture logic; the
// capture controller decides when to activate()/clear() it.

import { SaviRecordButton } from './record-button';
import { GuardReason, SaviRecordingGuardBanner } from './recording-guard-banner';

export class SaviRecordingGuard {
    private readonly _recordButton: SaviRecordButton;
    private readonly _banner = new SaviRecordingGuardBanner();
    private _active = false;
    private _reason: GuardReason = 'reload-drop';
    private _audioCtx: AudioContext | null = null;
    private _armedGesture?: () => void;

    constructor(recordButton: SaviRecordButton) {
        this._recordButton = recordButton;
    }

    /** Raise all signals. Idempotent for the same reason. */
    activate(reason: GuardReason) {
        if (this._active && this._reason === reason) {
            return;
        }
        this._active = true;
        this._reason = reason;
        this._recordButton.setState('alert');
        this._banner.show(reason, () => {
            // Dismissed: the banner hides itself; the loud record button stays as
            // the standing "not recording" signal.
        });
        this._chime();
    }

    /** Drop all signals — call when recording resumes, or on reset/unbind. Does
     *  NOT touch the record button's recording/idle state (the controller owns
     *  that); it only stops asserting the alert. */
    clear() {
        if (!this._active) {
            return;
        }
        this._active = false;
        this._banner.hide();
        this._disarmGesture();
    }

    destroy() {
        this.clear();
        this._banner.destroy();
        this._audioCtx?.close().catch(() => {});
        this._audioCtx = null;
    }

    // A short two-tone beep. A fresh-reload AudioContext starts suspended (no user
    // gesture yet) and autoplay policy blocks it: try now, and if still suspended,
    // arm a one-shot gesture (the resume keypress/any click satisfies it) so it
    // plays then; later re-nag ticks succeed directly once a gesture has occurred.
    private _chime() {
        const ctx = this._ctx();
        if (!ctx) {
            return;
        }
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        if (ctx.state === 'suspended') {
            this._armGesture();
            return;
        }
        this._beep(ctx);
    }

    private _ctx(): AudioContext | null {
        if (this._audioCtx) {
            return this._audioCtx;
        }
        try {
            this._audioCtx = new AudioContext();
        } catch {
            this._audioCtx = null;
        }
        return this._audioCtx;
    }

    private _beep(ctx: AudioContext) {
        try {
            const now = ctx.currentTime;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
            gain.connect(ctx.destination);
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(660, now);
            osc.frequency.setValueAtTime(520, now + 0.18);
            osc.connect(gain);
            osc.start(now);
            osc.stop(now + 0.5);
        } catch {
            /* best effort — the visual signals are primary */
        }
    }

    private _armGesture() {
        if (this._armedGesture) {
            return;
        }
        const handler = () => {
            this._disarmGesture();
            const ctx = this._ctx();
            if (ctx) {
                ctx.resume()
                    .then(() => this._beep(ctx))
                    .catch(() => {});
            }
        };
        this._armedGesture = handler;
        window.addEventListener('pointerdown', handler, { once: true, capture: true });
        window.addEventListener('keydown', handler, { once: true, capture: true });
    }

    private _disarmGesture() {
        if (this._armedGesture) {
            window.removeEventListener('pointerdown', this._armedGesture, true);
            window.removeEventListener('keydown', this._armedGesture, true);
            this._armedGesture = undefined;
        }
    }
}
