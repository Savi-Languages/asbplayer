jest.mock('./i18n', () => ({ i18nInit: jest.fn() }));
jest.mock('./pages', () => ({ currentPageDelegate: jest.fn() }));
jest.mock('./build-flags', () => ({ isFirefoxBuild: false }));
jest.mock('@project/common/subtitle-reader', () => ({}));
jest.mock('../savi/account', () => ({ daemonCredentials: jest.fn() }));
(globalThis as any).browser = {
    storage: { local: { get: jest.fn(), set: jest.fn() } },
    runtime: { getURL: (path: string) => path },
};
import Binding from './binding';
import { SaviHoverPause } from '../savi/hover-pause';
import { PauseOnHoverMode } from '@project/common/settings';

it('binding defers an actual subtitle mousemove to the line-end hold and clears hover ownership on play', async () => {
    jest.useFakeTimers();
    const beforeUnload: EventListener[] = [];
    const pageHide: EventListener[] = [];
    const addWindow = window.addEventListener.bind(window);
    jest.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: any, options?: any) => {
        if (type === 'beforeunload') beforeUnload.push(listener);
        if (type === 'pagehide') pageHide.push(listener);
        addWindow(type, listener, options);
    });
    (globalThis as any).browser = { runtime: { sendMessage: jest.fn(), onMessage: { addListener: jest.fn() } } };
    const video = document.createElement('video');
    let paused = false;
    Object.defineProperty(video, 'paused', { get: () => paused });
    video.currentTime = 1;
    const cues = [{ text: '猫', start: 0, end: 2000, track: 0 }];
    const pause = jest.fn(() => {
        paused = true;
        video.dispatchEvent(new Event('pause'));
    });
    const hover = new SaviHoverPause({
        video,
        subtitles: () => cues,
        enabled: () => true,
        overPopup: () => false,
        pause,
        play: jest.fn(),
    });
    const binding = Object.create(Binding.prototype) as any;
    Object.assign(binding, {
        video,
        _playModes: new Set(),
        hasPageScript: false,
        subtitleController: {},
        dictionary: { onRequestStatisticsSeek: jest.fn(), onRequestStatisticsMineSentences: jest.fn() },
        hoveredToken: { handleMouseOver: jest.fn() },
        saviHoverPause: hover,
        saviHoverDictionary: { isOverHoverSurface: () => false },
        pauseOnHoverMode: PauseOnHoverMode.inAndOut,
        pause,
    });
    const line = document.createElement('span');
    line.className = 'asbplayer-subtitle-text';
    line.dataset.track = '0';
    line.textContent = '猫';
    document.body.appendChild(line);
    try {
        binding._subscribe();
        await hover.start();
        line.addEventListener('mousemove', binding.subtitleController.onMouseOver);
        line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        expect(pause).not.toHaveBeenCalled();
        video.currentTime = 2;
        jest.advanceTimersByTime(100);
        expect(pause).toHaveBeenCalledTimes(1);
        binding.pausedDueToHover = true;
        paused = false;
        video.dispatchEvent(new Event('play'));
        expect(binding.pausedDueToHover).toBe(false);
    } finally {
        hover.stop();
        clearInterval(binding.heartbeatInterval);
        for (const listener of beforeUnload) window.removeEventListener('beforeunload', listener);
        for (const listener of pageHide) window.removeEventListener('pagehide', listener);
        line.remove();
        jest.restoreAllMocks();
        jest.useRealTimers();
    }
});
