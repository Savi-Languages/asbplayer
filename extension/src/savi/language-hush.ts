// The manual escape hatch for savi's language gate (SV-41).
//
// The gate fails open: when the page cannot tell us what is being spoken, savi
// runs. That is deliberate — silence loses exposure the user never sees. The
// cost is that on a site with no signal, an English video still gets the full
// learning layer, and the user has no recourse but to disable savi wholesale.
//
// This is that recourse: one click, this video only. It appears ONLY when the
// verdict is `unknown`, because that is the only case where savi is guessing.
// On a positive match it would be noise, and on a mismatch savi is already off.
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
        button.textContent = '🔇 Not my language';
        button.title = 'Turn savi off for this video (it cannot tell what language is spoken here)';
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
