import { canHostChildren, hostOverlay, needsTopLayer, neutralizePopoverChrome, overlayParent } from './top-layer';

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

describe('hostOverlay', () => {
    // The pieces above, composed. jsdom has neither fullscreen nor a top layer,
    // so both are faked at the seams hostOverlay reads them from: a
    // `document.fullscreenElement` getter, and showPopover/hidePopover that keep
    // the open state and throw on a double call, like the real ones.
    let fullscreen: Element | null = null;
    let calls: string[] = [];

    beforeEach(() => {
        fullscreen = null;
        calls = [];
        document.body.innerHTML = '';
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
        (HTMLElement.prototype as any).showPopover = function (this: HTMLElement) {
            if (this.dataset.popoverOpen === '1') throw new Error('InvalidStateError');
            this.dataset.popoverOpen = '1';
            calls.push(`show:${this.parentElement?.tagName ?? 'detached'}`);
        };
        (HTMLElement.prototype as any).hidePopover = function (this: HTMLElement) {
            if (this.dataset.popoverOpen !== '1') throw new Error('InvalidStateError');
            delete this.dataset.popoverOpen;
            calls.push(`hide:${this.parentElement?.tagName ?? 'detached'}`);
        };
    });

    afterEach(() => {
        delete (document as any).fullscreenElement;
        delete (HTMLElement.prototype as any).showPopover;
        delete (HTMLElement.prototype as any).hidePopover;
    });

    const KEEP = { border: '1px solid red', maxHeight: '72vh' };
    const overlay = () => {
        const el = document.createElement('div');
        Object.assign(el.style, { position: 'fixed', left: '10px', top: '20px', ...KEEP });
        return el;
    };

    it('windowed: lives on body, not promoted', () => {
        const el = overlay();
        expect(hostOverlay(el, false, KEEP)).toBe(false);
        expect(el.parentElement).toBe(document.body);
        expect(el.hasAttribute('popover')).toBe(false);
    });

    it('streaming-site fullscreen: moves into the fullscreen container, still not promoted', () => {
        const player = document.createElement('div');
        document.body.appendChild(player);
        const el = overlay();
        hostOverlay(el, false, KEEP); // created windowed
        fullscreen = player;
        expect(hostOverlay(el, false, KEEP)).toBe(false);
        expect(el.parentElement).toBe(player);
        expect(calls).toEqual([]);
    });

    it('bare-video fullscreen: stays on body, lifted into the top layer, with its own chrome kept', () => {
        const video = document.createElement('video');
        document.body.appendChild(video);
        fullscreen = video;
        const el = overlay();
        expect(hostOverlay(el, false, KEEP)).toBe(true);
        expect(el.parentElement).toBe(document.body);
        expect(el.getAttribute('popover')).toBe('manual');
        expect(calls).toEqual(['show:BODY']);
        // neutralizePopoverChrome reset these to 0 / none; `keep` put them back…
        expect(el.style.border).toBe('1px solid red');
        expect(el.style.maxHeight).toBe('72vh');
        // …and a computed edge is left alone. (The `right`/`bottom: auto` half
        // of the inset reset is neutralizePopoverChrome's, tested there as far
        // as jsdom allows — its cssstyle has no `right`/`bottom` at all.)
        expect(el.style.left).toBe('10px');
    });

    it('leaving fullscreen demotes and restores the chrome again', () => {
        const video = document.createElement('video');
        document.body.appendChild(video);
        fullscreen = video;
        const el = overlay();
        const promoted = hostOverlay(el, false, KEEP);
        el.style.border = '0'; // what a stray reset would leave behind
        fullscreen = null;
        expect(hostOverlay(el, promoted, KEEP)).toBe(false);
        expect(el.hasAttribute('popover')).toBe(false);
        expect(calls).toEqual(['show:BODY', 'hide:BODY']);
        expect(el.style.border).toBe('1px solid red');
    });

    it('demotes a shown popover BEFORE moving it into a new parent', () => {
        // Promoted over a bare video, then a container goes fullscreen instead.
        // Moving an open popover closes it behind our back; demoting first is
        // what keeps the bookkeeping (and the attribute) honest.
        const video = document.createElement('video');
        const player = document.createElement('div');
        document.body.append(video, player);
        fullscreen = video;
        const el = overlay();
        const promoted = hostOverlay(el, false, KEEP);
        fullscreen = player;
        expect(hostOverlay(el, promoted, KEEP)).toBe(false);
        expect(calls).toEqual(['show:BODY', 'hide:BODY']); // hidden while still on body
        expect(el.parentElement).toBe(player);
        expect(el.hasAttribute('popover')).toBe(false);
    });

    it('re-attaches an overlay a page wipe removed', () => {
        const el = overlay();
        hostOverlay(el, false, KEEP);
        el.remove();
        hostOverlay(el, false, KEEP);
        expect(el.isConnected).toBe(true);
        expect(el.parentElement).toBe(document.body);
    });

    it('is a no-op when nothing changed', () => {
        const player = document.createElement('div');
        document.body.appendChild(player);
        fullscreen = player;
        const el = overlay();
        hostOverlay(el, false, KEEP);
        const before = Array.from(player.childNodes);
        hostOverlay(el, false, KEEP);
        expect(Array.from(player.childNodes)).toEqual(before);
        expect(calls).toEqual([]);
    });
});
