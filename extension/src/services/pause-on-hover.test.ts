import { shouldPauseForAsbplayerHover } from './pause-on-hover';

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
});
