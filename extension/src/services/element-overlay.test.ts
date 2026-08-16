import { needsTopLayer } from './element-overlay';

// SV-44. The DOM plumbing around this (showPopover, the UA-style resets) is not
// unit-testable — jsdom implements neither fullscreen nor the top layer — so the
// decision itself is factored out and tested, and the mechanism was verified in
// a real browser instead.
describe('needsTopLayer', () => {
    const container = () => document.createElement('div');

    it('is false when nothing is fullscreen', () => {
        expect(needsTopLayer(null, container())).toBe(false);
    });

    it('is false when the overlay lives inside the fullscreen element', () => {
        // Every streaming site: the page fullscreens a container and the
        // overlay is appended within it, so it paints normally. This path must
        // stay untouched.
        const player = document.createElement('div');
        const overlay = container();
        player.appendChild(overlay);
        expect(needsTopLayer(player, overlay)).toBe(false);
    });

    it('is true when a bare video is the fullscreen element', () => {
        // Chrome's built-in file:// viewer. The overlay is a sibling in <body>,
        // and a <video> cannot host children, so there is nowhere inside to go.
        const video = document.createElement('video');
        const overlay = container();
        document.body.append(video, overlay);
        expect(needsTopLayer(video, overlay)).toBe(true);
    });

    it('is true for any fullscreen element that does not contain the overlay', () => {
        const other = document.createElement('div');
        const overlay = container();
        document.body.append(other, overlay);
        expect(needsTopLayer(other, overlay)).toBe(true);
    });

    it('treats the element as containing itself, per Node.contains', () => {
        const el = container();
        expect(needsTopLayer(el, el)).toBe(false);
    });
});
