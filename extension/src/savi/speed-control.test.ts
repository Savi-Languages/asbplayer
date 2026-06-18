import { SaviSpeedControl } from './speed-control';

describe('SaviSpeedControl', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    const buttons = () => Array.from(document.querySelectorAll('.savi-speed-button')) as HTMLButtonElement[];

    it('renders the speed options and sets playbackRate on click', () => {
        const video = document.createElement('video');
        const control = new SaviSpeedControl(() => video);
        control.show();

        const labels = buttons().map((b) => b.textContent);
        expect(labels).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×']);

        // Click 0.75×.
        buttons()[1].click();
        expect(video.playbackRate).toBe(0.75);
        expect(buttons()[1].classList.contains('active')).toBe(true);
        expect(buttons()[2].classList.contains('active')).toBe(false);
    });

    it('highlights the button matching the current rate', () => {
        const video = document.createElement('video');
        video.playbackRate = 0.5;
        const control = new SaviSpeedControl(() => video);
        control.show();

        expect(buttons()[0].classList.contains('active')).toBe(true); // 0.5×
    });

    it('hides and destroys, detaching its listener', () => {
        const video = document.createElement('video');
        const removeSpy = jest.spyOn(video, 'removeEventListener');
        const control = new SaviSpeedControl(() => video);
        control.show();

        control.hide();
        expect((document.querySelector('.savi-speed-control') as HTMLElement).style.display).toBe('none');

        control.destroy();
        expect(document.querySelector('.savi-speed-control')).toBeNull();
        expect(removeSpy).toHaveBeenCalledWith('ratechange', expect.any(Function));
    });
});
