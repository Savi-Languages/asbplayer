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
// The prompt only ever offered one answer — "switch savi off here" — so on a
// site the user WANTS savi on, there was nothing to say but "no thanks", and
// it asked again on every video. The ✕ is that missing answer: it closes the
// prompt for the whole site (hush-dismissed.ts) without muting anything.
//
// Inline-styled + appended to document.body, mirroring record-button.ts. A
// row of two buttons rather than one, because a button inside a button is
// invalid HTML and browsers do not deliver the inner click reliably.

const ROW_STYLE: Partial<CSSStyleDeclaration> = {
    position: 'fixed',
    right: '16px',
    bottom: '96px',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'stretch',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '6px',
    background: 'rgba(20,20,20,0.82)',
    color: '#e6e6e6',
    font: '500 12px/1.2 system-ui, sans-serif',
    overflow: 'hidden',
};

const BUTTON_RESET: Partial<CSSStyleDeclaration> = {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
};

export class SaviLanguageHush {
    private _row: HTMLDivElement | null = null;
    private readonly _onHush: () => void;
    private readonly _onDismiss: () => void;

    /** @param onHush the user accepted: switch savi off for this site.
     *  @param onDismiss the user declined: stop asking here, change nothing. */
    constructor(onHush: () => void, onDismiss: () => void = () => {}) {
        this._onHush = onHush;
        this._onDismiss = onDismiss;
    }

    /** Show the control. Idempotent — safe to call on every data sync. */
    show() {
        this._ensure().style.display = 'flex';
    }

    hide() {
        if (this._row) {
            this._row.style.display = 'none';
        }
    }

    destroy() {
        this._row?.remove();
        this._row = null;
    }

    private _ensure(): HTMLDivElement {
        if (this._row) {
            return this._row;
        }
        const row = document.createElement('div');
        row.className = 'savi-language-hush';
        Object.assign(row.style, ROW_STYLE);

        const hush = document.createElement('button');
        hush.className = 'savi-language-hush-accept';
        hush.textContent = "🔇 Don't use Savi on this site";
        hush.title =
            'Turn Savi off for every video on this site (it cannot tell what language is spoken here). Undo in Settings → Savi.';
        Object.assign(hush.style, {
            ...BUTTON_RESET,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
        } as Partial<CSSStyleDeclaration>);
        hush.addEventListener(
            'click',
            this._handler(() => this._onHush())
        );

        const dismiss = document.createElement('button');
        dismiss.className = 'savi-language-hush-dismiss';
        dismiss.textContent = '✕';
        dismiss.setAttribute('aria-label', 'Close — keep using Savi on this site');
        dismiss.title = 'Close. Savi keeps running here and stops asking on this site.';
        Object.assign(dismiss.style, {
            ...BUTTON_RESET,
            padding: '6px 9px',
            borderLeft: '1px solid rgba(255,255,255,0.2)',
            opacity: '0.75',
        } as Partial<CSSStyleDeclaration>);
        dismiss.addEventListener(
            'click',
            this._handler(() => this._onDismiss())
        );

        row.append(hush, dismiss);
        document.body.appendChild(row);
        this._row = row;
        return row;
    }

    /** Both buttons swallow the event: the prompt floats over a video player,
     *  and a click reaching the page underneath would toggle playback. */
    private _handler(act: () => void): (event: MouseEvent) => void {
        return (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.hide();
            act();
        };
    }
}
