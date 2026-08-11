// Making overlays survive fullscreen (SV-44).
//
// Fullscreen renders ONLY the fullscreen element's subtree. Anything else in
// the document exists, gets positioned, and is never painted. Every savi
// overlay therefore has to end up either INSIDE the fullscreen element or in
// the browser's TOP LAYER, which sits above it.
//
// Parenting into the fullscreen element is the cheaper of the two and is what
// the overlays already do. It works on streaming sites because they fullscreen
// a CONTAINER. It fails on a bare `file://` video, where Chrome's built-in
// viewer fullscreens the `<video>` ELEMENT — and a video is a *replaced*
// element: `appendChild` succeeds, the child is simply never rendered. That is
// a silent failure, which is why it survived so long as "the subtitles just
// disappear in fullscreen".
//
// The top layer is the fallback. Verified in a real browser: over a
// fullscreened video, a plain positioned sibling is invisible while a popover
// paints on top. (`elementsFromPoint` disagrees — it does not report top-layer
// elements — so that API is not a valid way to check this.)

/**
 * Whether `el` can actually RENDER children.
 *
 * Replaced elements — video, img, canvas, and friends — draw their own content
 * and never paint child nodes, even though the DOM accepts them. Appending an
 * overlay to one is the silent failure described above.
 */
export function canHostChildren(el: Element | null): boolean {
    if (el === null) {
        return false;
    }
    const replaced = ['VIDEO', 'IMG', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'INPUT', 'TEXTAREA', 'SELECT'];
    return !replaced.includes(el.tagName);
}

/**
 * Whether an overlay must be lifted into the top layer to be seen: something is
 * fullscreen, and the overlay is not inside it.
 *
 * False whenever the overlay already lives in the fullscreen subtree, so every
 * site that works today keeps its existing, untouched path.
 */
export function needsTopLayer(fullscreenElement: Element | null, container: Element): boolean {
    return fullscreenElement !== null && !fullscreenElement.contains(container);
}

/**
 * Where an overlay should be parented for the current fullscreen state: inside
 * the fullscreen element when it can host children, else `<body>` (from which
 * the caller promotes it to the top layer).
 */
export function overlayParent(fullscreenElement: Element | null): HTMLElement {
    return fullscreenElement instanceof HTMLElement && canHostChildren(fullscreenElement)
        ? fullscreenElement
        : document.body;
}

/**
 * Undo the parts of the `[popover]` UA stylesheet that no overlay wants.
 *
 * It ships `inset: 0`, a border and `overflow: auto`. `inset` is the dangerous
 * one: it fights whatever left/top the caller computed and would stretch the
 * overlay across the viewport. Inline styles beat the UA sheet, so setting them
 * is enough.
 *
 * Background and padding are deliberately NOT touched — they differ per overlay
 * (the hover label wants its own; the subtitle container wants none), so each
 * caller owns them.
 */
export function neutralizePopoverChrome(el: HTMLElement): void {
    el.style.margin = '0';
    el.style.border = '0';
    el.style.overflow = 'visible';
    el.style.maxHeight = 'none';
    // Neutralize only the sides the caller left unset, so a computed edge is
    // never overwritten.
    //
    // Via setProperty rather than the named accessors: jsdom's CSS shim does
    // not implement `right`/`bottom` as properties, so `el.style.right = …`
    // silently does nothing there. Browsers accept both; this form works in
    // both, which keeps the behaviour testable.
    for (const side of ['top', 'right', 'bottom', 'left']) {
        if (el.style.getPropertyValue(side) === '') {
            el.style.setProperty(side, 'auto');
        }
    }
}

/**
 * Move `el` into or out of the top layer, returning whether it is now promoted.
 *
 * `currentlyPromoted` is passed in rather than read back from
 * `:popover-open`, so the caller's bookkeeping stays authoritative and this
 * never throws where the selector is unsupported. A no-op when the Popover API
 * is unavailable: the overlay is then no worse off than before.
 */
export function setTopLayer(el: HTMLElement, promote: boolean, currentlyPromoted: boolean): boolean {
    if (promote === currentlyPromoted) {
        return currentlyPromoted;
    }
    if (typeof (el as any).showPopover !== 'function') {
        return currentlyPromoted;
    }

    try {
        if (promote) {
            // `manual` so the browser never light-dismisses the overlay on an
            // Escape press or an outside click.
            el.setAttribute('popover', 'manual');
            (el as any).showPopover();
            neutralizePopoverChrome(el);
        } else {
            (el as any).hidePopover();
            el.removeAttribute('popover');
        }
    } catch {
        // Double show/hide throws rather than no-opping. Fall through and
        // report the intended state, so the caller does not get wedged.
    }

    return promote;
}
