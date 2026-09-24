// Keep the subtitles clear of the streaming player's control bar — by never
// being where it appears, not by dodging it.
//
// asbplayer anchors the bottom subtitle's bottom edge a fixed offset above the
// video's bottom (the `subtitlePositionOffset` setting, default 75px) — which is
// exactly the strip where Netflix's progress bar lives when the controls are up.
// Both layers are interactive, so they fight over the mouse: the progress bar is
// hard to click under the subtitle, and hovering subtitle words gets flaky.
//
// This used to lift the subtitles while the controls were visible and drop them
// back when they hid. That is the one thing a hover tool cannot do: hovering a
// word moves the mouse, the mouse brings the controls up, and within a poll the
// text jumped out from under the cursor — then jumped back when they hid. (It
// also stuck: a settings reload reset the offset while the last-applied value
// still read "lifted", so nothing re-lifted and the translation line sat on the
// progress bar until the controls next toggled.)
//
// Now the lift is where the subtitles REST. How tall the control strip is gets
// learned by measuring it whenever it happens to be up, remembered per player
// height across sessions, and applied whether or not the controls are showing —
// so the text does not move when they come and go. Before the first measurement
// a per-site estimate stands in, and it is only replaced by a measurement that
// differs by more than a few pixels, so the worst case is a single small settle
// the first time a site is ever used. Runtime-only: the setting itself is never
// written, and stays the floor the lift never goes below.
//
// Site coverage is a pure hostname → site map (same pattern as
// native-subtitle-hider); unknown hosts are a no-op.

/** A site whose bottom controls we know how to find. `restingRatio` is the
 *  control strip's height as a fraction of the player's, used only until the
 *  strip has actually been measured at (or near) the current player height. */
export interface ControlsSite {
    readonly key: string;
    readonly selector: string;
    readonly restingRatio: number;
}

const SITES: readonly (ControlsSite & { readonly host: string })[] = [
    // Progress bar + button row + title: about a sixth of the player.
    { host: 'netflix.com', key: 'netflix', selector: '.watch-video--bottom-controls-container', restingRatio: 0.17 },
    { host: 'youtube.com', key: 'youtube', selector: '.ytp-chrome-bottom', restingRatio: 0.09 },
];

/** The site for this hostname, or undefined when we don't know it. Pure. */
export function controlsSiteForHost(host: string): ControlsSite | undefined {
    return SITES.find((site) => host === site.host || host.endsWith('.' + site.host));
}

/** CSS selector for the site's bottom controls (progress bar + buttons), or
 *  undefined when we don't know this site. Pure — unit-testable. */
export function controlsSelectorForHost(host: string): string | undefined {
    return controlsSiteForHost(host)?.selector;
}

/** The bottom offset (px above the video's bottom edge) that places the
 *  subtitle's bottom just above controls whose top edge is at `controlsTop`.
 *  Pure — unit-testable. */
export function clearanceOffsetPx(videoBottom: number, controlsTop: number, marginPx: number): number {
    return Math.max(0, Math.ceil(videoBottom - controlsTop) + marginPx);
}

/** Visible enough to matter: laid out with height, not display/visibility/opacity
 *  hidden. Netflix unmounts its controls entirely (height 0 when absent);
 *  YouTube fades them via opacity. */
export function controlsVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.height < 1) {
        return false;
    }
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05;
}

/** Measured lifts, keyed by the player height (px) they were measured at. */
export type MeasuredLifts = Record<string, number>;

/** The lift to rest at for a player `height` px tall: the measurement taken at
 *  this height if there is one, else the nearest measured height scaled to this
 *  one (the strip grows with the player), else the site's estimate. Pure. */
export function restingLiftPx(measured: MeasuredLifts, height: number, restingRatio: number): number {
    const exact = measured[String(height)];
    if (exact !== undefined) {
        return exact;
    }
    let nearest: number | undefined;
    for (const key of Object.keys(measured)) {
        const at = Number(key);
        if (at > 0 && (nearest === undefined || Math.abs(at - height) < Math.abs(nearest - height))) {
            nearest = at;
        }
    }
    const ratio = nearest === undefined ? restingRatio : measured[String(nearest)] / nearest;
    return Math.ceil(ratio * height);
}

/** Keep the `max` measurements nearest `height`: a user has a windowed size and
 *  a fullscreen one, not dozens, and a window drag must not grow this forever.
 *  Mutates and returns `measured`. Pure. */
export function pruneMeasuredLifts(measured: MeasuredLifts, height: number, max: number): MeasuredLifts {
    const keys = Object.keys(measured);
    if (keys.length <= max) {
        return measured;
    }
    keys.sort((a, b) => Math.abs(Number(a) - height) - Math.abs(Number(b) - height));
    for (const key of keys.slice(max)) {
        delete measured[key];
    }
    return measured;
}

/** Where measurements survive a reload, so a site is only ever "first used" once. */
export interface ClearanceStore {
    load(siteKey: string): Promise<MeasuredLifts>;
    save(siteKey: string, measured: MeasuredLifts): Promise<void>;
}

const STORAGE_KEY = 'saviControlsClearance';

/** storage.local, the same backing persistent-cache uses. Failures are silent:
 *  the in-process measurements still serve this session. */
export const extensionClearanceStore: ClearanceStore = {
    async load(siteKey) {
        try {
            const got = await browser.storage.local.get(STORAGE_KEY);
            const bySite = (got?.[STORAGE_KEY] as Record<string, MeasuredLifts> | undefined) ?? {};
            return { ...(bySite[siteKey] ?? {}) };
        } catch {
            return {};
        }
    },
    async save(siteKey, measured) {
        try {
            const got = await browser.storage.local.get(STORAGE_KEY);
            const bySite = (got?.[STORAGE_KEY] as Record<string, MeasuredLifts> | undefined) ?? {};
            await browser.storage.local.set({ [STORAGE_KEY]: { ...bySite, [siteKey]: measured } });
        } catch {
            // Storage unavailable/full — nothing to do; see above.
        }
    },
};

export interface ControlsClearanceSources {
    /** The bound media element, for its bottom edge and height. */
    readonly video: () => HTMLMediaElement | null | undefined;
    /** Apply an effective bottom offset to the subtitle overlay (runtime only —
     *  never persisted; the binding routes this to the subtitle controller). */
    readonly applyOffset: (px: number) => void;
    /** The offset the overlay has RIGHT NOW. Compared against instead of a
     *  remembered "last applied", so an offset something else overwrote is put
     *  back on the next tick rather than trusted forever. */
    readonly currentOffset: () => number;
    /** Defaults to extension storage; tests pass their own. */
    readonly store?: ClearanceStore;
    /** Defaults to the page's hostname; tests name a site. */
    readonly host?: string;
}

const POLL_MS = 300;
const MARGIN_PX = 10;
/** A measurement within this of the lift already in use is the same strip seen
 *  through sub-pixel layout noise — not worth moving the text for. Well inside
 *  MARGIN_PX, so ignoring it can never let the two overlap. */
const SETTLE_PX = 3;
const MAX_MEASURED = 8;

export class SaviControlsClearance {
    private readonly _sources: ControlsClearanceSources;
    private readonly _store: ClearanceStore;

    /** The user's configured resting offset (the `subtitlePositionOffset`
     *  setting). The binding refreshes this whenever settings (re)load. */
    baseOffsetPx = 75;

    private _site?: ControlsSite;
    private _timer?: ReturnType<typeof setInterval>;
    private _measured: MeasuredLifts = {};
    private _storeLoaded = false;
    private _learnedWhileLoading = false;
    private _loadCycle = 0;
    /** The previous tick's raw reading. A reading is only believed once two
     *  consecutive ticks agree, so a strip caught mid-transition is never
     *  learned as its resting size. */
    private _lastReading?: { height: number; lift: number };

    constructor(sources: ControlsClearanceSources) {
        this._sources = sources;
        this._store = sources.store ?? extensionClearanceStore;
    }

    start(): void {
        if (this._timer !== undefined) {
            return; // already running
        }
        this._site = controlsSiteForHost(this._sources.host ?? location.hostname);
        if (this._site === undefined) {
            return; // unknown site (no-op)
        }
        const site = this._site;
        const loadCycle = ++this._loadCycle;
        this._storeLoaded = false;
        this._learnedWhileLoading = false;
        this._timer = setInterval(() => this._tick(), POLL_MS);
        void this._store.load(site.key).then((stored) => {
            if (this._loadCycle !== loadCycle || this._site?.key !== site.key) {
                return;
            }
            // Anything measured while this was loading is fresher than storage.
            this._measured = { ...stored, ...this._measured };
            this._storeLoaded = true;
            if (this._learnedWhileLoading) {
                this._learnedWhileLoading = false;
                void this._store.save(site.key, { ...this._measured });
            }
            this._tick();
        });
        this._tick();
    }

    stop(): void {
        if (this._timer !== undefined) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
        ++this._loadCycle;
        this._storeLoaded = false;
        this._learnedWhileLoading = false;
        this._lastReading = undefined;
    }

    /** The offset the subtitles should rest at for the player as it is laid out
     *  now — the same whether or not the controls are showing. The binding uses
     *  this when it (re)applies settings, so a reload never drops the text onto
     *  the control strip for a poll. */
    effectiveOffsetPx(): number {
        const video = this._sources.video();
        const height = video ? Math.round(video.getBoundingClientRect().height) : 0;
        if (this._site === undefined || this._timer === undefined || height < 1) {
            return this.baseOffsetPx;
        }
        // Never drop below the user's resting offset — only lift.
        return Math.max(this.baseOffsetPx, restingLiftPx(this._measured, height, this._site.restingRatio));
    }

    private _tick(): void {
        const video = this._sources.video();
        if (!video || this._site === undefined || this._timer === undefined) {
            return;
        }
        this._learn(video, this._site);
        const effective = this.effectiveOffsetPx();
        if (effective !== this._sources.currentOffset()) {
            this._sources.applyOffset(effective);
        }
    }

    /** Measure the control strip if it is up, and remember it once it holds still. */
    private _learn(video: HTMLMediaElement, site: ControlsSite): void {
        const controls = document.querySelector(site.selector);
        if (controls === null || !controlsVisible(controls)) {
            this._lastReading = undefined;
            return;
        }
        const rect = video.getBoundingClientRect();
        const height = Math.round(rect.height);
        if (height < 1) {
            return;
        }
        const lift = clearanceOffsetPx(rect.bottom, controls.getBoundingClientRect().top, MARGIN_PX);
        const previous = this._lastReading;
        this._lastReading = { height, lift };
        if (previous === undefined || previous.height !== height || previous.lift !== lift) {
            return; // not yet seen twice running
        }
        const key = String(height);
        const inUse = restingLiftPx(this._measured, height, site.restingRatio);
        const exact = this._measured[key];
        if (exact !== undefined && lift > exact + SETTLE_PX) {
            // A transient expanded player UI can look stable for two polls. An
            // established exact measurement may be safely lowered, but never
            // raised from that brief observation (which would persist excess
            // empty space across future sessions).
            return;
        }
        if (Math.abs(lift - inUse) <= SETTLE_PX) {
            if (this._measured[key] !== undefined) {
                return; // already known at this height; this is layout noise
            }
            // The estimate on screen was right. Record IT, not the reading, so
            // confirming an estimate never moves the text.
            this._measured[key] = inUse;
        } else {
            this._measured[key] = lift;
        }
        pruneMeasuredLifts(this._measured, height, MAX_MEASURED);
        if (this._storeLoaded) {
            void this._store.save(site.key, { ...this._measured });
        } else {
            // Wait for the stored map before saving so an early measurement at
            // one height cannot erase measurements from other player heights.
            this._learnedWhileLoading = true;
        }
    }
}
