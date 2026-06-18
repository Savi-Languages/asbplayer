import { SaviRecordButton } from './record-button';

describe('SaviRecordButton', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    const el = () => document.querySelector('.savi-record-button') as HTMLButtonElement;

    it('shows a Record control that toggles via click', () => {
        let toggles = 0;
        const button = new SaviRecordButton(() => {
            toggles++;
        });
        button.show();

        expect(el()).not.toBeNull();
        expect(el().querySelector('.savi-record-label')!.textContent).toBe('Record');
        expect(el().classList.contains('recording')).toBe(false);

        el().click();
        expect(toggles).toBe(1);
    });

    it('reflects the capture state', () => {
        const button = new SaviRecordButton(() => {});
        button.show();

        button.setState('recording');
        expect(el().querySelector('.savi-record-label')!.textContent).toBe('Recording');
        expect(el().classList.contains('recording')).toBe(true);

        button.setState('idle');
        expect(el().querySelector('.savi-record-label')!.textContent).toBe('Record');
        expect(el().classList.contains('recording')).toBe(false);
    });

    it('hides and destroys', () => {
        const button = new SaviRecordButton(() => {});
        button.show();
        button.hide();
        expect(el().style.display).toBe('none');

        button.destroy();
        expect(el()).toBeNull();
    });
});
