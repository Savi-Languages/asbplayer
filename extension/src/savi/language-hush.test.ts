import { SaviLanguageHush } from './language-hush';

const row = () => document.querySelector<HTMLElement>('.savi-language-hush');
const acceptButton = () => document.querySelector<HTMLButtonElement>('.savi-language-hush-accept');
const dismissButton = () => document.querySelector<HTMLButtonElement>('.savi-language-hush-dismiss');

describe('SaviLanguageHush', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('offers both an accept and a dismiss control', () => {
        // The prompt used to have one answer — "switch savi off here" — which
        // is no answer at all on a site the user wants savi on.
        new SaviLanguageHush(
            () => {},
            () => {}
        ).show();

        expect(acceptButton()?.textContent).toContain("Don't use Savi on this site");
        expect(dismissButton()?.textContent).toBe('✕');
    });

    it('calls onDismiss — and NOT onHush — when the ✕ is clicked', () => {
        const called: string[] = [];
        new SaviLanguageHush(
            () => called.push('hush'),
            () => called.push('dismiss')
        ).show();

        dismissButton()!.click();

        expect(called).toEqual(['dismiss']);
    });

    it('calls onHush when the main button is clicked', () => {
        const called: string[] = [];
        new SaviLanguageHush(
            () => called.push('hush'),
            () => called.push('dismiss')
        ).show();

        acceptButton()!.click();

        expect(called).toEqual(['hush']);
    });

    it('hides the prompt on either answer', () => {
        for (const click of [() => acceptButton()!.click(), () => dismissButton()!.click()]) {
            document.body.innerHTML = '';
            const hush = new SaviLanguageHush(
                () => {},
                () => {}
            );
            hush.show();
            expect(row()!.style.display).toBe('flex');
            click();
            expect(row()!.style.display).toBe('none');
        }
    });

    it('swallows the click so the video underneath does not toggle', () => {
        // The prompt floats over a player; a click reaching the page would
        // pause or play whatever the user is watching.
        let reachedPage = false;
        document.body.addEventListener('click', () => {
            reachedPage = true;
        });
        new SaviLanguageHush(
            () => {},
            () => {}
        ).show();

        dismissButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(reachedPage).toBe(false);
    });

    it('is idempotent — repeated shows do not stack prompts', () => {
        // show() is called from every data sync while the gate is guessing.
        const hush = new SaviLanguageHush(
            () => {},
            () => {}
        );
        hush.show();
        hush.show();
        hush.show();

        expect(document.querySelectorAll('.savi-language-hush')).toHaveLength(1);
    });

    it('removes itself on destroy', () => {
        const hush = new SaviLanguageHush(
            () => {},
            () => {}
        );
        hush.show();
        hush.destroy();

        expect(row()).toBeNull();
    });
});
