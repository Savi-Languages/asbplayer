import { SaviRecordButton } from './record-button';
import { SaviRecordingGuard } from './recording-guard';

// jsdom has no Web Audio, so `new AudioContext()` throws inside the guard's chime
// — which the guard swallows (ctx → null), making the chime a no-op here. The
// visual signals (button + banner) and the re-nag timer are what these cover.
describe('SaviRecordingGuard', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    const button = () => document.querySelector('.savi-record-button') as HTMLButtonElement;
    const banner = () => document.querySelector('.savi-recording-guard-banner') as HTMLElement | null;

    const make = () => {
        const recordButton = new SaviRecordButton(() => {});
        recordButton.show();
        return { recordButton, guard: new SaviRecordingGuard(recordButton) };
    };

    it('activate raises the loud button + banner with reason-specific copy', () => {
        const { guard } = make();
        guard.activate('reload-drop');

        expect(button().classList.contains('alert')).toBe(true);
        expect(banner()).not.toBeNull();
        expect(banner()!.style.display).toBe('flex');
        expect(banner()!.textContent).toContain('Recording stopped');

        guard.clear();
        guard.activate('never-started');
        expect(banner()!.textContent).toContain('not recording'); // calmer copy
    });

    it('clear hides the banner', () => {
        const { guard } = make();
        guard.activate('reload-drop');
        expect(banner()!.style.display).toBe('flex');
        guard.clear();
        expect(banner()!.style.display).toBe('none');
    });

    it('dismissing the banner hides it; the loud button remains the standing signal', () => {
        const { guard } = make();
        guard.activate('reload-drop');
        (banner()!.querySelector('button') as HTMLButtonElement).click();
        expect(banner()!.style.display).toBe('none');
        expect(button().classList.contains('alert')).toBe(true);
    });

    it('destroy removes the banner element', () => {
        const { guard } = make();
        guard.activate('reload-drop');
        guard.destroy();
        expect(banner()).toBeNull();
    });
});
