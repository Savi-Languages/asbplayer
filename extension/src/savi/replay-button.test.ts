import { SaviReplayButton } from './replay-button';

describe('SaviReplayButton fullscreen', () => {
    let fullscreen: Element | null;
    let button: SaviReplayButton;
    const replay = () => document.querySelector<HTMLButtonElement>('.savi-replay-button')!;

    beforeEach(() => {
        fullscreen = null;
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
        button = new SaviReplayButton(jest.fn());
    });

    afterEach(() => {
        button.destroy();
        Reflect.deleteProperty(document, 'fullscreenElement');
        document.body.innerHTML = '';
    });

    it('moves into and out of the fullscreen layer without leaving a stale visible button', () => {
        const player = document.createElement('div');
        document.body.append(player);
        button.show();
        const control = replay();
        control.style.display = 'inline-flex';
        fullscreen = player;
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(player.contains(control)).toBe(true);
        expect(control.style.display).toBe('none');

        fullscreen = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(control.parentElement).toBe(document.body);
        expect(replay()).toBe(control);
    });

    it('uses the fullscreen subtitle when a stale windowed container exists first', () => {
        const stale = document.createElement('div');
        stale.className = 'asbplayer-subtitles-container-bottom';
        document.body.append(stale);
        const player = document.createElement('div');
        player.innerHTML = '<div class="asbplayer-subtitles-container-bottom"><span data-track="0">字幕</span></div>';
        document.body.append(player);
        fullscreen = player;
        const rect = { left: 100, right: 300, top: 200, bottom: 240, width: 200, height: 40 } as DOMRect;
        player.firstElementChild!.getBoundingClientRect = () => rect;
        player.querySelector('span')!.getBoundingClientRect = () => rect;
        button.show();
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, clientY: 220 }));
        expect(player.contains(replay())).toBe(true);
        expect(replay().style.display).toBe('inline-flex');
        expect(replay().style.left).toBe('308px');
    });

    it('stops following fullscreen changes while hidden and remounts when shown', () => {
        const player = document.createElement('div');
        document.body.append(player);
        button.show();
        button.hide();
        fullscreen = player;
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(replay().parentElement).toBe(document.body);
        button.show();
        expect(replay().parentElement).toBe(player);
        button.destroy();
        document.dispatchEvent(new Event('fullscreenchange'));
        expect(replay()).toBeNull();
    });
});
