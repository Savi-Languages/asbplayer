import { isUsableRect, placeInVideo } from './anchor';

// The YouTube watch page at 1440x900 — the layout that exposed the bug: the
// video occupies only the left ~70% of the viewport, so viewport-anchored
// controls land on the masthead / sidebar instead of the player.
const YOUTUBE_VIDEO = { x: 16, y: 68, width: 996, height: 560 };
const VIEWPORT = { width: 1440, height: 900 };
const RECORD = { width: 138, height: 27 };

describe('placeInVideo', () => {
    it('puts a top-right control inside the video, not the viewport corner', () => {
        const { left, top } = placeInVideo(YOUTUBE_VIDEO, RECORD, 'top-right', 18, VIEWPORT);

        // Inside the video's right edge (16 + 996 = 1012), not at 1440 - 138 - 18 = 1284,
        // which is where `right: 18px` put it — on top of YouTube's Sign-in button.
        expect(left).toBe(1012 - 138 - 18);
        expect(top).toBe(68 + 18);
        expect(left + RECORD.width).toBeLessThanOrEqual(YOUTUBE_VIDEO.x + YOUTUBE_VIDEO.width);
    });

    it('centres a top-center control on the video, not the viewport', () => {
        const speed = { width: 220, height: 26 };
        const { left } = placeInVideo(YOUTUBE_VIDEO, speed, 'top-center', 18, VIEWPORT);

        const videoCentre = YOUTUBE_VIDEO.x + YOUTUBE_VIDEO.width / 2;
        expect(left + speed.width / 2).toBe(videoCentre);
        // `left: 50%` would have centred on 720 — over the recommendations rail.
        expect(left + speed.width / 2).not.toBe(VIEWPORT.width / 2);
    });

    it('tracks a full-bleed player (fullscreen) to the viewport corner', () => {
        const full = { x: 0, y: 0, width: 1440, height: 900 };
        const { left, top } = placeInVideo(full, RECORD, 'top-right', 18, VIEWPORT);
        expect(left).toBe(1440 - 138 - 18);
        expect(top).toBe(18);
    });

    it('clamps a control that would fall outside the viewport', () => {
        // A player scrolled mostly off-screen to the right must not drag the
        // control out of reach.
        const offscreen = { x: 1380, y: 800, width: 900, height: 500 };
        const { left, top } = placeInVideo(offscreen, RECORD, 'top-right', 18, VIEWPORT);
        expect(left).toBeLessThanOrEqual(VIEWPORT.width - RECORD.width);
        expect(top).toBeLessThanOrEqual(VIEWPORT.height - RECORD.height);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(top).toBeGreaterThanOrEqual(0);
    });

    it('never returns a negative coordinate for a video wider than the viewport', () => {
        const wide = { x: -200, y: -50, width: 2000, height: 1200 };
        const { left, top } = placeInVideo(wide, RECORD, 'top-center', 18, VIEWPORT);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(top).toBeGreaterThanOrEqual(0);
    });
});

describe('isUsableRect', () => {
    it('rejects unlaid-out videos so controls are not pinned to 0,0', () => {
        expect(isUsableRect(undefined)).toBe(false);
        expect(isUsableRect({ x: 0, y: 0, width: 0, height: 0 })).toBe(false);
        expect(isUsableRect({ x: 0, y: 0, width: 996, height: 0 })).toBe(false);
        expect(isUsableRect(YOUTUBE_VIDEO)).toBe(true);
    });
});
