// The manual escape hatch for savi's language gate (SV-41).
//
// The gate fails open: when the page cannot tell us what is being spoken, savi
// runs. That is deliberate — silence loses exposure the user never sees. The
// cost is that on a site with no signal, an English video still gets the full
// learning layer, and the user has no recourse but to disable savi wholesale.
//
// This is that recourse: one click switches savi off FOR THE WHOLE SITE. It
// appears ONLY when the verdict is `unknown`, because that is the only case
// where savi is guessing. On a positive match it would be noise, and on a
// mismatch savi is already off.
//
// SV-44 widened it from this-video to this-site. The narrow version was built
// when savi only bound to sites with a delegate, where "this video is not my
// language" was the whole problem. Now that any page with a <video> can arm
// the learning layer, the common complaint is a SITE that should never run it
// — and clicking through video after video on such a site is not a recourse.
// Existing per-video mutes are still honoured by the gate (muted-episodes.ts);
// only what this button WRITES has changed.
//
// Inline-styled + appended to document.body, mirroring record-button.ts.

export class SaviLanguageHush {
    private _button: HTMLButtonElement | null = null;
    private readonly _onHush: () => void;

    constructor(onHush: () => void) {
        this._onHush = onHush;
    }

    /** Show the control. Idempotent — safe to call on every data sync. */
    show() {
        this._ensure().style.display = 'flex';
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
        button.className = 'savi-language-hush';
        button.textContent = "🔇 Don't use Savi on this site";
        button.title =
            'Turn Savi off for every video on this site (it cannot tell what language is spoken here). Undo in Settings → Savi.';
        Object.assign(button.style, {
            position: 'fixed',
            right: '16px',
            bottom: '96px',
            zIndex: '2147483646',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: '6px',
            background: 'rgba(20,20,20,0.82)',
            color: '#e6e6e6',
            font: '500 12px/1.2 system-ui, sans-serif',
            cursor: 'pointer',
        } as Partial<CSSStyleDeclaration>);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.hide();
            this._onHush();
        });

        document.body.appendChild(button);
        this._button = button;
        return button;
    }
}
