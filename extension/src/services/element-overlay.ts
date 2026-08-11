import { OffscreenDomCache } from '@project/common';

/**
 * Whether the overlay has to be lifted into the browser's TOP LAYER to be seen
 * (SV-44).
 *
 * The normal fullscreen path appends the overlay to an ancestor of the video,
 * which works on streaming sites because they fullscreen a CONTAINER: the
 * overlay ends up inside the fullscreen element's subtree and paints with it.
 *
 * A bare `file://` video has no such container. Chrome's built-in viewer
 * fullscreens the `<video>` ELEMENT itself, and nothing outside a fullscreen
 * element's subtree is rendered — so the overlay silently vanished the moment a
 * local video went fullscreen. A `<video>` cannot host children, so there is
 * nowhere inside to put it either.
 *
 * The top layer is the way out: it sits above fullscreen content, and a popover
 * opened after the fullscreen element stacks on top of it. Verified visually
 * against a fullscreened video — a plain sibling is invisible there and a
 * popover is not.
 *
 * Deliberately narrow: promotion happens ONLY when the overlay is not already
 * inside the fullscreen element, so every site that already worked keeps the
 * untouched code path.
 */
export function needsTopLayer(fullscreenElement: Element | null, container: Element): boolean {
    return fullscreenElement !== null && !fullscreenElement.contains(container);
}

export enum OffsetAnchor {
    bottom,
    top,
}

export interface KeyedHtml {
    key?: string;
    html: () => string;
}

export interface ElementOverlayParams {
    targetElement: HTMLElement;
    nonFullscreenContainerClassName: string;
    nonFullscreenContentClassName: string;
    fullscreenContainerClassName: string;
    fullscreenContentClassName: string;
    offsetAnchor: OffsetAnchor;
    contentPositionOffset?: number;
    contentWidthPercentage: number;
    onContainerStyles?: (container: HTMLElement) => void;
    onMouseOver: (event: MouseEvent) => void;
    onMouseOut: (event: MouseEvent) => void;
}

export interface ElementOverlay {
    setHtml(htmls: KeyedHtml[]): void;
    appendHtml(html: string): void;
    refresh(): void;
    hide(): void;
    dispose(): void;
    nonFullscreenContainerClassName: string;
    nonFullscreenContentClassName: string;
    fullscreenContainerClassName: string;
    fullscreenContentClassName: string;
    offsetAnchor: OffsetAnchor;
    contentPositionOffset: number;
    contentWidthPercentage: number;
    displayingElements: () => Iterable<HTMLElement>;
    containerElement: HTMLElement | undefined;
}

export class CachingElementOverlay implements ElementOverlay {
    private readonly targetElement: HTMLElement;

    private readonly domCache: OffscreenDomCache = new OffscreenDomCache();

    private fullscreenContainerElement?: HTMLElement;
    private defaultContentElement?: HTMLElement;
    private nonFullscreenContainerElement?: HTMLElement;
    private nonFullscreenElementFullscreenChangeListener?: (this: any, event: Event) => any;
    private nonFullscreenStylesInterval?: NodeJS.Timeout;
    private nonFullscreenElementFullscreenPollingInterval?: NodeJS.Timeout;
    private fullscreenElementFullscreenChangeListener?: (this: any, event: Event) => any;
    private fullscreenElementFullscreenPollingInterval?: NodeJS.Timeout;
    private fullscreenStylesInterval?: NodeJS.Timeout;
    /** Whether the fullscreen container is currently lifted into the top layer
     *  (SV-44). Tracked here rather than read back with `:popover-open`, so the
     *  logic stays testable and cannot throw where the API is absent. */
    private fullscreenContainerInTopLayer = false;
    private onMouseOver: (event: MouseEvent) => void;
    private onMouseOut: (event: MouseEvent) => void;
    private onContainerStyles?: (container: HTMLElement) => void;

    nonFullscreenContainerClassName: string;
    nonFullscreenContentClassName: string;
    fullscreenContainerClassName: string;
    fullscreenContentClassName: string;
    offsetAnchor: OffsetAnchor = OffsetAnchor.bottom;
    contentPositionOffset: number;
    contentWidthPercentage: number;

    constructor({
        targetElement,
        nonFullscreenContainerClassName,
        nonFullscreenContentClassName,
        fullscreenContainerClassName,
        fullscreenContentClassName,
        offsetAnchor,
        contentPositionOffset,
        contentWidthPercentage,
        onMouseOver,
        onMouseOut,
        onContainerStyles,
    }: ElementOverlayParams) {
        this.targetElement = targetElement;
        this.nonFullscreenContainerClassName = nonFullscreenContainerClassName;
        this.nonFullscreenContentClassName = nonFullscreenContentClassName;
        this.fullscreenContainerClassName = fullscreenContainerClassName;
        this.fullscreenContentClassName = fullscreenContentClassName;
        this.offsetAnchor = offsetAnchor;
        this.contentPositionOffset = contentPositionOffset ?? 75;
        this.contentWidthPercentage = contentWidthPercentage;
        this.onMouseOver = onMouseOver;
        this.onMouseOut = onMouseOut;
        this.onContainerStyles = onContainerStyles;

        // Necessary for token highlighting on hover
        document.body.classList.add('asbplayer-token-container');
        document.body.tabIndex = -1;
    }

    *displayingElements() {
        function* grandChildren(container: HTMLElement) {
            for (const content of container.childNodes) {
                for (const el of content.childNodes) {
                    if (el instanceof HTMLElement) {
                        yield el as HTMLElement;
                    }
                }
            }
        }

        const container = this.containerElement;

        if (container !== undefined) {
            for (const el of grandChildren(container)) {
                yield el;
            }
        }
    }

    get containerElement() {
        if (document.fullscreenElement && this.fullscreenContainerElement !== undefined) {
            return this.fullscreenContainerElement;
        } else if (!document.fullscreenElement && this.nonFullscreenContainerElement !== undefined) {
            return this.nonFullscreenContainerElement;
        }

        return undefined;
    }

    uncacheHtml() {
        this.domCache.clear();
    }

    cacheHtml(key: string, html: string) {
        this.domCache.add(key, html);
    }

    hasCachedHtml(key: string) {
        return this.domCache.has(key);
    }

    removeCachedHtml(key: string) {
        this.domCache.delete(key);
    }

    cachedHtmlKeys() {
        return this.domCache.keys();
    }

    setHtml(htmls: KeyedHtml[]) {
        if (document.fullscreenElement) {
            this._displayFullscreenContentElementsWithHtml(htmls);
        } else {
            this._displayNonFullscreenContentElementsWithHtml(htmls);
        }
    }

    private _displayNonFullscreenContentElementsWithHtml(htmls: KeyedHtml[]) {
        this._displayNonFullscreenContentElements(htmls.map((html) => this._cachedContentElement(html.html, html.key)));
    }

    private _displayNonFullscreenContentElements(contentElements: HTMLElement[]) {
        for (const contentElement of contentElements) {
            contentElement.className = this.nonFullscreenContentClassName;
        }

        this._setChildren(this._nonFullscreenContainerElement(), contentElements);
    }

    private _displayFullscreenContentElementsWithHtml(htmls: KeyedHtml[]) {
        this._displayFullscreenContentElements(htmls.map((html) => this._cachedContentElement(html.html, html.key)));
    }

    private _displayFullscreenContentElements(contentElements: HTMLElement[]) {
        for (const contentElement of contentElements) {
            contentElement.className = this.fullscreenContentClassName;
        }

        this._setChildren(this._fullscreenContainerElement(), contentElements);
    }

    private _nonFullscreenContainerElement() {
        if (this.nonFullscreenContainerElement) {
            return this.nonFullscreenContainerElement;
        }

        const container = document.createElement('div');
        container.className = this.nonFullscreenContainerClassName;
        container.onmouseover = this.onMouseOver;
        container.onmouseout = this.onMouseOut;
        this._applyContainerStyles(container);
        document.body.appendChild(container);

        const toggle = () => {
            if (document.fullscreenElement) {
                container.style.setProperty('display', 'none', 'important');
                this._transferChildren(container, this._fullscreenContainerElement());
            } else {
                container.style.display = '';

                if (this.fullscreenContainerElement) {
                    this._transferChildren(this.fullscreenContainerElement, container);
                }
            }
        };

        toggle();
        this.nonFullscreenElementFullscreenChangeListener = (e) => toggle();
        this.nonFullscreenStylesInterval = setInterval(() => this._applyContainerStyles(container), 1000);
        this.nonFullscreenElementFullscreenPollingInterval = setInterval(() => toggle(), 1000);
        document.addEventListener('fullscreenchange', this.nonFullscreenElementFullscreenChangeListener);
        this.nonFullscreenContainerElement = container;
        return container;
    }

    private _fullscreenContainerElement() {
        if (this.fullscreenContainerElement) {
            return this.fullscreenContainerElement;
        }

        const container = document.createElement('div');
        container.className = this.fullscreenContainerClassName;
        container.onmouseover = this.onMouseOver;
        container.onmouseout = this.onMouseOut;
        this._applyContainerStyles(container);
        this._findFullscreenParentElement(container).appendChild(container);
        container.style.setProperty('display', 'none', 'important');
        const that = this;

        const toggle = () => {
            if (document.fullscreenElement) {
                if (container.style.display === 'none') {
                    container.style.display = '';
                    container.remove();
                    that._findFullscreenParentElement(container).appendChild(container);
                }

                if (this.nonFullscreenContainerElement) {
                    this._transferChildren(this.nonFullscreenContainerElement, container);
                }

                // Only fires when the overlay landed outside the fullscreen
                // element — a bare <video> going fullscreen, with no container
                // to live in. See `needsTopLayer`.
                this._syncTopLayer(container);
            } else if (!document.fullscreenElement) {
                this._syncTopLayer(container);
                container.style.setProperty('display', 'none', 'important');
                this._transferChildren(container, this._nonFullscreenContainerElement());
            }
        };

        toggle();
        this.fullscreenElementFullscreenChangeListener = (e) => toggle();
        this.fullscreenStylesInterval = setInterval(() => this._applyContainerStyles(container), 1000);
        this.fullscreenElementFullscreenPollingInterval = setInterval(() => toggle(), 1000);
        document.addEventListener('fullscreenchange', this.fullscreenElementFullscreenChangeListener);
        this.fullscreenContainerElement = container;
        return this.fullscreenContainerElement;
    }

    /** Lift the overlay into the top layer, or drop it back, to match the
     *  current fullscreen state. No-op where the Popover API is unavailable —
     *  the overlay is then no worse off than before. */
    private _syncTopLayer(container: HTMLElement) {
        const promote = needsTopLayer(document.fullscreenElement, container);

        if (promote === this.fullscreenContainerInTopLayer) {
            return;
        }
        if (typeof (container as any).showPopover !== 'function') {
            return;
        }

        try {
            if (promote) {
                // `manual` so the browser never light-dismisses the subtitles
                // on an Escape press or an outside click.
                container.setAttribute('popover', 'manual');
                (container as any).showPopover();
                this.fullscreenContainerInTopLayer = true;
                this._applyTopLayerStyleResets(container);
            } else {
                (container as any).hidePopover();
                container.removeAttribute('popover');
                this.fullscreenContainerInTopLayer = false;
            }
        } catch (e) {
            // A double show/hide throws rather than no-ops. Keep the flag in
            // step with reality instead of leaving the overlay wedged.
            this.fullscreenContainerInTopLayer = promote;
        }
    }

    /** Undo the UA stylesheet a popover brings with it.
     *
     *  `[popover]` ships `inset: 0`, a border, padding, a background and
     *  `overflow: auto` — none of which a subtitle overlay wants, and `inset`
     *  in particular would fight the left/top this class computes. Inline
     *  styles beat the UA sheet, so setting them here is enough. */
    private _applyTopLayerStyleResets(container: HTMLElement) {
        container.style.margin = '0';
        container.style.border = '0';
        container.style.padding = '0';
        container.style.background = 'transparent';
        container.style.overflow = 'visible';
        container.style.maxHeight = 'none';
        container.style.right = 'auto';
        // Exactly one of top/bottom is set by `_applyContainerStyles`; the UA's
        // `inset: 0` would otherwise anchor the empty one to the viewport edge
        // and stretch the overlay across the screen.
        if (container.style.top === '') {
            container.style.top = 'auto';
        }
        if (container.style.bottom === '') {
            container.style.bottom = 'auto';
        }
    }

    private _findFullscreenParentElement(container: HTMLElement): HTMLElement {
        const testNode = container.cloneNode(true) as HTMLElement;
        testNode.innerHTML = '&nbsp;'; // The node needs to take up some space to perform test clicks
        let current = this.targetElement.parentElement;

        if (!current) {
            return document.body;
        }

        const targetElementRootNode = this.targetElement.getRootNode();
        const rootNode: ShadowRoot | Document =
            targetElementRootNode instanceof ShadowRoot ? targetElementRootNode : document;

        let chosen: HTMLElement | undefined = undefined;

        do {
            const rect = current.getBoundingClientRect();

            if (
                rect.height > 0 &&
                (typeof chosen === 'undefined' ||
                    // Typescript is not smart enough to know that it's possible for 'chosen' to be defined here
                    rect.height >= (chosen as HTMLElement).getBoundingClientRect().height) &&
                this._clickable(rootNode, current, testNode)
            ) {
                chosen = current;
                break;
            }

            current = current.parentElement;
        } while (current && !current.isSameNode(document.body.parentElement));

        if (chosen) {
            return chosen;
        }

        return document.body;
    }

    private _transferChildren(source: HTMLElement, destination: HTMLElement) {
        if (!source) {
            return;
        }

        while (source.firstChild) {
            destination.appendChild(source.firstChild);
        }
    }

    private _setChildren(containerElement: HTMLElement, contentElements: HTMLElement[]) {
        while (containerElement.firstChild) {
            this.domCache.return(containerElement.lastChild! as HTMLElement);
        }

        for (const contentElement of contentElements) {
            containerElement.appendChild(contentElement);
        }
    }

    private _cachedContentElement(html: () => string, key: string | undefined) {
        if (key === undefined) {
            if (!this.defaultContentElement) {
                this.defaultContentElement = document.createElement('div');
            }

            this.defaultContentElement.innerHTML = html();
            return this.defaultContentElement;
        }

        return this.domCache.get(key, html);
    }

    appendHtml(html: string) {
        if (document.fullscreenElement) {
            this._appendHtml(`${html}\n`, this.fullscreenContentClassName, this._fullscreenContainerElement());
        } else {
            this._appendHtml(`${html}\n`, this.nonFullscreenContentClassName, this._nonFullscreenContainerElement());
        }
    }

    private _appendHtml(html: string, className: string, container: HTMLElement) {
        const breakLine = document.createElement('br');
        const content = document.createElement('div');
        content.innerHTML = html;
        content.className = className;
        container.appendChild(breakLine);
        container.appendChild(content);
    }

    refresh() {
        if (this.fullscreenContainerElement) {
            this._applyContainerStyles(this.fullscreenContainerElement);
        }

        if (this.nonFullscreenContainerElement) {
            this._applyContainerStyles(this.nonFullscreenContainerElement);
        }
    }

    hide() {
        if (this.nonFullscreenElementFullscreenChangeListener) {
            document.removeEventListener('fullscreenchange', this.nonFullscreenElementFullscreenChangeListener);
        }

        if (this.nonFullscreenStylesInterval) {
            clearInterval(this.nonFullscreenStylesInterval);
        }

        if (this.nonFullscreenElementFullscreenPollingInterval) {
            clearInterval(this.nonFullscreenElementFullscreenPollingInterval);
        }

        if (this.fullscreenElementFullscreenChangeListener) {
            document.removeEventListener('fullscreenchange', this.fullscreenElementFullscreenChangeListener);
        }

        if (this.fullscreenStylesInterval) {
            clearInterval(this.fullscreenStylesInterval);
        }

        if (this.fullscreenElementFullscreenPollingInterval) {
            clearInterval(this.fullscreenElementFullscreenPollingInterval);
        }

        this.defaultContentElement?.remove();
        this.defaultContentElement = undefined;
        this.nonFullscreenContainerElement?.remove();
        this.nonFullscreenContainerElement = undefined;
        this.fullscreenContainerElement?.remove();
        this.fullscreenContainerElement = undefined;
    }

    private _applyContainerStyles(container: HTMLElement) {
        // Re-assert the popover resets afterwards: this runs on a 1s interval
        // and rewrites top/bottom, which is exactly what the UA `inset` fights.
        if (this.fullscreenContainerInTopLayer && container === this.fullscreenContainerElement) {
            queueMicrotask(() => this._applyTopLayerStyleResets(container));
        }

        const rect = this.targetElement.getBoundingClientRect();
        container.style.left = rect.left + rect.width / 2 + 'px';

        if (this.contentWidthPercentage === -1) {
            container.style.maxWidth = rect.width + 'px';
            container.style.width = '';
        } else {
            container.style.maxWidth = '';
            container.style.width =
                Math.min(window.innerWidth, (rect.width * this.contentWidthPercentage) / 100) + 'px';
        }

        const clampedY = Math.max(rect.top + window.scrollY, 0);

        if (this.offsetAnchor === OffsetAnchor.bottom) {
            const clampedHeight = Math.min(clampedY + rect.height, window.innerHeight + window.scrollY);
            container.style.top = clampedHeight - this.contentPositionOffset + 'px';
            container.style.bottom = '';
        } else {
            container.style.top = clampedY + this.contentPositionOffset + 'px';
            container.style.bottom = '';
        }

        this.onContainerStyles?.(container);
    }

    private _clickable(rootNode: Document | ShadowRoot, container: HTMLElement, element: HTMLElement): boolean {
        container.appendChild(element);
        const rect = element.getBoundingClientRect();
        const clickedElement = rootNode.elementFromPoint(rect.x, rect.y);
        const clickable = element.isSameNode(clickedElement) || element.contains(clickedElement);
        element.remove();
        return clickable;
    }

    dispose() {
        this.hide();
        this.domCache.clear();
    }
}
