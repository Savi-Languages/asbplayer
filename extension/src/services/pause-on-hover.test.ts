import { shouldPauseForAsbplayerHover } from './pause-on-hover';
import { SaviGlossHover, type GlossHoverSources } from '../savi/gloss-hover';

describe('shouldPauseForAsbplayerHover', () => {
    it('defers to Savi end-of-line hold while Savi gloss hover is active', () => {
        expect(
            shouldPauseForAsbplayerHover({
                overSubtitleText: true,
                pauseOnHoverEnabled: true,
                videoPaused: false,
                saviGlossHoverActive: true,
            })
        ).toBe(false);
    });

    it('pauses immediately when Savi is not handling the hover', () => {
        expect(
            shouldPauseForAsbplayerHover({
                overSubtitleText: true,
                pauseOnHoverEnabled: true,
                videoPaused: false,
                saviGlossHoverActive: false,
            })
        ).toBe(true);
    });

    it('lets a hovered subtitle keep playing until Savi receives the line-end event', async () => {
        const video = document.createElement('video');
        let paused = false;
        Object.defineProperty(video, 'paused', { get: () => paused });
        const pause = jest.fn(() => {
            paused = true;
        });
        const hover = new SaviGlossHover({
            gloss: { glossable: true, targetLang: 'es' } as GlossHoverSources['gloss'],
            settings: { get: jest.fn().mockResolvedValue({ saviHoverGloss: true }) },
            video: () => video,
            subtitles: () => [{ text: 'el gato' }],
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
                    saviGlossHoverActive: hover.isActive(),
                })
            ) {
                pause();
            }
            expect(pause).not.toHaveBeenCalled();
            expect(video.paused).toBe(false);

            hover.onWillStopShowing();
            expect(pause).toHaveBeenCalledTimes(1);
            expect(video.paused).toBe(true);
            hover.onWillStopShowing();
            expect(pause).toHaveBeenCalledTimes(1);
        } finally {
            hover.stop();
            line.remove();
        }
    });
});
