// A persistent, centered banner over the video warning that recording is OFF —
// the primary signal of the recording guard. Two variants: a reload DROPPED your
// recording (urgent, red), or you simply never started one this episode (calmer,
// amber). Because resuming needs an extension-level gesture (Ctrl+Shift+S or the
// toolbar icon), the banner is a PROMPT, not a button — an in-page click cannot
// grant tab-audio permission.
//
// Inline-styled + appended to document.body, mirroring the toast in hover-dict.ts.
// pointer-events are OFF except the dismiss "×", and it installs NO key listeners,
// so the record shortcut is never intercepted.

export type GuardReason = 'reload-drop' | 'never-started';

export class SaviRecordingGuardBanner {
    private _el: HTMLDivElement | null = null;
    private _mainEl: HTMLSpanElement | null = null;
    private _subEl: HTMLSpanElement | null = null;
    private _onDismiss?: () => void;

    /** Show the banner for the given reason. `onDismiss` fires when the user
     *  clicks "×" (the banner hides itself; the guard's re-nag re-shows it). */
    show(reason: GuardReason, onDismiss: () => void) {
        this._onDismiss = onDismiss;
        const el = this._ensure();
        const urgent = reason === 'reload-drop';
        el.style.background = urgent ? 'rgba(150, 22, 22, 0.96)' : 'rgba(122, 91, 22, 0.96)';
        el.style.borderColor = urgent ? '#f85149' : '#d9a441';
        if (this._mainEl) {
            this._mainEl.textContent = urgent ? '⏸ Recording stopped on reload' : '● You’re not recording';
        }
        if (this._subEl) {
            this._subEl.textContent = urgent
                ? 'Press Ctrl+Shift+S (or click the savi toolbar icon) to resume.'
                : 'Press Ctrl+Shift+S to record this episode.';
        }
        el.style.display = 'flex';
    }

    hide() {
        if (this._el) {
            this._el.style.display = 'none';
        }
    }

    destroy() {
        this._el?.remove();
        this._el = null;
        this._mainEl = null;
        this._subEl = null;
    }

    private _ensure(): HTMLDivElement {
        if (this._el) {
            return this._el;
        }
        const el = document.createElement('div');
        el.className = 'savi-recording-guard-banner';
        Object.assign(el.style, {
            position: 'fixed',
            left: '50%',
            top: '96px', // clears asbplayer's top control bar + the savi speed control
            transform: 'translateX(-50%)',
            // Same band as the subtitles (above the video + record button), but
            // below the hover-dict popup (2147483647) so it never covers a lookup.
            zIndex: '2147483646',
            display: 'none',
            alignItems: 'center',
            gap: '12px',
            padding: '10px 12px 10px 16px',
            borderRadius: '12px',
            border: '1px solid',
            color: '#fff',
            font: '600 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
            pointerEvents: 'none', // the prompt itself never eats clicks or keypresses…
            maxWidth: '88vw',
        });

        const textWrap = document.createElement('div');
        Object.assign(textWrap.style, { display: 'flex', flexDirection: 'column', gap: '2px' });
        const main = document.createElement('span');
        const sub = document.createElement('span');
        Object.assign(sub.style, { fontWeight: '400', opacity: '0.9', fontSize: '12.5px' });
        textWrap.appendChild(main);
        textWrap.appendChild(sub);

        const dismiss = document.createElement('button');
        dismiss.textContent = '×';
        dismiss.title = 'Dismiss (re-appears if you keep watching unrecorded)';
        Object.assign(dismiss.style, {
            pointerEvents: 'auto', // …except the dismiss control
            cursor: 'pointer',
            border: 'none',
            background: 'rgba(255,255,255,0.16)',
            color: '#fff',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            font: '700 16px/1 sans-serif',
            flex: '0 0 auto',
        });
        dismiss.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.hide();
            this._onDismiss?.();
        });

        el.appendChild(textWrap);
        el.appendChild(dismiss);
        document.body.appendChild(el);
        this._el = el;
        this._mainEl = main;
        this._subEl = sub;
        return el;
    }
}
