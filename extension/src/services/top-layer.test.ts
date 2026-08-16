import { canHostChildren, needsTopLayer, neutralizePopoverChrome, overlayParent } from './top-layer';

// SV-44. The browser half of this (showPopover, actual painting) is not
// unit-testable — jsdom implements neither fullscreen nor a top layer — so the
// DECISIONS are factored out and tested here, and the mechanism was verified in
// a real browser instead.

describe('canHostChildren', () => {
    it('rejects replaced elements, which never paint children', () => {
        // The whole bug: appendChild succeeds on a <video> and the child is
        // simply never rendered, so the failure is silent.
        for (const tag of ['video', 'img', 'canvas', 'iframe', 'input']) {
            expect(canHostChildren(document.createElement(tag))).toBe(false);
        }
    });

    it('accepts ordinary containers', () => {
        for (const tag of ['div', 'section', 'span', 'body']) {
            expect(canHostChildren(document.createElement(tag))).toBe(true);
        }
    });

    it('is false for nothing at all', () => {
        expect(canHostChildren(null)).toBe(false);
    });
});

describe('overlayParent', () => {
    it('nests inside a fullscreen container, the streaming-site case', () => {
        const player = document.createElement('div');
        expect(overlayParent(player)).toBe(player);
    });

    it('falls back to body when the fullscreen element cannot paint children', () => {
        // A bare file:// video. Parenting here is what broke hover gloss.
        expect(overlayParent(document.createElement('video'))).toBe(document.body);
    });

    it('falls back to body when nothing is fullscreen', () => {
        expect(overlayParent(null)).toBe(document.body);
    });
});

describe('needsTopLayer', () => {
    it('is false when nothing is fullscreen', () => {
        expect(needsTopLayer(null, document.createElement('div'))).toBe(false);
    });

    it('is false once the overlay is inside the fullscreen element', () => {
        // Every site that already works must keep its untouched path.
        const player = document.createElement('div');
        const overlay = document.createElement('div');
        player.appendChild(overlay);
        expect(needsTopLayer(player, overlay)).toBe(false);
    });

    it('is true when a bare video is fullscreen and the overlay sits outside', () => {
        const video = document.createElement('video');
        const overlay = document.createElement('div');
        document.body.append(video, overlay);
        expect(needsTopLayer(video, overlay)).toBe(true);
    });
});

describe('neutralizePopoverChrome', () => {
    it('clears the UA border and overflow that a popover brings', () => {
        const el = document.createElement('div');
        neutralizePopoverChrome(el);
        // CSSOM normalizes lengths, so `0` reads back as `0px`.
        expect(el.style.margin).toBe('0px');
        expect(el.style.border).toBe('0px');
        expect(el.style.overflow).toBe('visible');
    });

    it('leaves a computed edge alone', () => {
        // `inset: 0` is the dangerous part of the UA sheet — it would stretch
        // the overlay across the viewport — but the fix must not trample an
        // edge the caller positioned. This is the half that matters: getting it
        // wrong moves the subtitles.
        const el = document.createElement('div');
        el.style.left = '120px';
        el.style.top = '40px';
        neutralizePopoverChrome(el);
        expect(el.style.left).toBe('120px');
        expect(el.style.top).toBe('40px');
    });

    // NOT asserted here: that the UNSET edges become `auto`. jsdom's CSS shim
    // stores neither `right` nor `bottom` — by either accessor or
    // `setProperty` — so the assertion would test the shim, not the fix.
    // Browsers do store them, and the real behaviour was checked there: the
    // overlay renders correctly positioned over a fullscreened video rather
    // than stretched across it.

    it('leaves background and padding to the caller', () => {
        // They differ per overlay — the hover label wants its own pill
        // background; the subtitle container wants none.
        const el = document.createElement('div');
        el.style.background = 'rgba(0, 0, 0, 0.72)';
        el.style.padding = '1px 7px';
        neutralizePopoverChrome(el);
        expect(el.style.background).toBe('rgba(0, 0, 0, 0.72)');
        expect(el.style.padding).toBe('1px 7px');
    });
});
