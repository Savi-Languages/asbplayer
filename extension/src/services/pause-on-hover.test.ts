import { shouldPauseForAsbplayerHover, isSubtitleHoverTarget } from './pause-on-hover';
import { SaviHoverPause } from '../savi/hover-pause';

describe('shouldPauseForAsbplayerHover', () => {
    it('defers to Savi end-of-line hold while Savi hover pause is active', () => {
        expect(
            shouldPauseForAsbplayerHover({
                overSubtitleText: true,
                pauseOnHoverEnabled: true,
                videoPaused: false,
                saviHoverPauseActive: true,
            })
        ).toBe(false);
    });

    it('pauses immediately when Savi is not handling the hover', () => {
        expect(
            shouldPauseForAsbplayerHover({
                overSubtitleText: true,
                pauseOnHoverEnabled: true,
                videoPaused: false,
                saviHoverPauseActive: false,
            })
        ).toBe(true);
    });

    it('lets a hovered subtitle keep playing until Savi reaches the line end in every language', async () => {
        jest.useFakeTimers();
        const video = document.createElement('video');
        video.currentTime = 1;
        let paused = false;
        Object.defineProperty(video, 'paused', { get: () => paused });
        const pause = jest.fn(() => {
            paused = true;
        });
        const cues = [{ text: 'el gato', start: 0, end: 2000, track: 0 }];
        const hover = new SaviHoverPause({
            video,
            subtitles: () => cues,
            enabled: () => true,
            overPopup: () => false,
            pause,
            play: jest.fn(),
        });
        const line = document.createElement('span');
        line.className = 'asbplayer-subtitle-text';
        line.setAttribute('data-track', '0');
        line.textContent = 'el gato';
        document.body.appendChild(line);
        try {
            await hover.start();
            line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            if (
                shouldPauseForAsbplayerHover({
                    overSubtitleText: true,
                    pauseOnHoverEnabled: true,
                    videoPaused: video.paused,
                    saviHoverPauseActive: true,
                })
            ) {
                pause();
            }
            expect(pause).not.toHaveBeenCalled();
            expect(video.paused).toBe(false);

            video.currentTime = 2;
            jest.advanceTimersByTime(100);
            expect(pause).toHaveBeenCalledTimes(1);
            expect(video.paused).toBe(true);
            video.currentTime = 2;
            jest.advanceTimersByTime(100);
            expect(pause).toHaveBeenCalledTimes(1);
        } finally {
            hover.stop();
            line.remove();
            jest.useRealTimers();
        }
    });
});

it('notification text does not trigger the immediate subtitle hover fallback', () => {
    document.body.innerHTML =
        '<div class="asbplayer-notification"><span data-track="0">Loaded</span></div><div class="asbplayer-subtitles"><span data-track="0">猫</span></div>';
    expect(isSubtitleHoverTarget(document.querySelector('.asbplayer-notification span'))).toBe(false);
    expect(isSubtitleHoverTarget(document.querySelector('.asbplayer-subtitles span'))).toBe(true);
    document.body.replaceChildren();
});
