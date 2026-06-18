import { SaviRecordButton } from './record-button';

describe('SaviRecordButton', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    const el = () => document.querySelector('.savi-record-button') as HTMLButtonElement;
    const labelText = () => el().querySelector('.savi-record-label')!.textContent;

    it('shows a clear "Start recording" control that toggles via click', () => {
        let toggles = 0;
        const button = new SaviRecordButton(() => {
            toggles++;
        });
        button.show();

        expect(el()).not.toBeNull();
        expect(labelText()).toBe('Start recording');
        expect(el().classList.contains('recording')).toBe(false);

        el().click();
        expect(toggles).toBe(1);
    });

    it('reflects the capture state in the label', () => {
        const button = new SaviRecordButton(() => {});
        button.show();

        button.setState('recording');
        expect(labelText()).toBe('Recording — Stop');
        expect(el().classList.contains('recording')).toBe(true);

        button.setState('idle');
        expect(labelText()).toBe('Start recording');
        expect(el().classList.contains('recording')).toBe(false);
    });

    it('flashes a hint, then restores the state label', () => {
        jest.useFakeTimers();
        try {
            const button = new SaviRecordButton(() => {});
            button.show();

            button.flashHint('Press Ctrl+Shift+S');
            expect(labelText()).toBe('Press Ctrl+Shift+S');
            expect(el().classList.contains('hint')).toBe(true);

            jest.advanceTimersByTime(3500);
            expect(labelText()).toBe('Start recording');
            expect(el().classList.contains('hint')).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a real state change supersedes a pending hint', () => {
        jest.useFakeTimers();
        try {
            const button = new SaviRecordButton(() => {});
            button.show();

            button.flashHint('Press Ctrl+Shift+S');
            button.setState('recording'); // capture actually started
            expect(labelText()).toBe('Recording — Stop');
            expect(el().classList.contains('hint')).toBe(false);

            // The hint's timer must not fire and clobber the recording label.
            jest.advanceTimersByTime(3500);
            expect(labelText()).toBe('Recording — Stop');
        } finally {
            jest.useRealTimers();
        }
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
