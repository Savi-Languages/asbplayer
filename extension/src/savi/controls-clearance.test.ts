import {
    ClearanceStore,
    MeasuredLifts,
    SaviControlsClearance,
    clearanceOffsetPx,
    controlsSelectorForHost,
    controlsVisible,
    pruneMeasuredLifts,
    restingLiftPx,
} from './controls-clearance';

describe('controlsSelectorForHost', () => {
    it('maps netflix hosts to the bottom-controls container', () => {
        expect(controlsSelectorForHost('www.netflix.com')).toBe('.watch-video--bottom-controls-container');
        expect(controlsSelectorForHost('netflix.com')).toBe('.watch-video--bottom-controls-container');
    });

    it('maps youtube hosts to the chrome-bottom bar', () => {
        expect(controlsSelectorForHost('www.youtube.com')).toBe('.ytp-chrome-bottom');
    });

    it('returns undefined for unknown hosts (feature no-ops)', () => {
        expect(controlsSelectorForHost('example.com')).toBeUndefined();
        expect(controlsSelectorForHost('notnetflix.com')).toBeUndefined();
    });
});

describe('clearanceOffsetPx', () => {
    it('is the distance from the video bottom to the controls top, plus margin', () => {
        // Video bottom at 900, controls top at 800 → 100px of controls + 10 margin.
        expect(clearanceOffsetPx(900, 800, 10)).toBe(110);
    });

    it('rounds up fractional layout values', () => {
        expect(clearanceOffsetPx(900.4, 800.1, 10)).toBe(111);
    });

    it('never goes negative when the controls sit below the video', () => {
        expect(clearanceOffsetPx(700, 800, 10)).toBe(0);
    });
});

describe('controlsVisible', () => {
    const el = (height: number, style: Partial<CSSStyleDeclaration> = {}): Element => {
        const div = document.createElement('div');
        Object.assign(div.style, style);
        // jsdom has no layout — stub the rect.
        div.getBoundingClientRect = () => ({ height, width: 100, top: 0, bottom: height }) as DOMRect;
        document.body.appendChild(div);
        return div;
    };

    it('is false for an unmounted-style zero-height element (netflix hides by unmount)', () => {
        expect(controlsVisible(el(0))).toBe(false);
    });

    it('is false when faded out via opacity (youtube autohide)', () => {
        expect(controlsVisible(el(80, { opacity: '0' }))).toBe(false);
    });

    it('is false when visibility: hidden', () => {
        expect(controlsVisible(el(80, { visibility: 'hidden' }))).toBe(false);
    });

    it('is true for a laid-out, opaque element', () => {
        expect(controlsVisible(el(80))).toBe(true);
    });
});

describe('restingLiftPx', () => {
    it('uses the measurement taken at this player height', () => {
        expect(restingLiftPx({ '1000': 210, '500': 90 }, 1000, 0.17)).toBe(210);
    });

    it('scales the nearest measured height when this one has never been measured', () => {
        // Nearest to 520 is 500 (90px → 18%), not 1000 (210px → 21%).
        expect(restingLiftPx({ '1000': 210, '500': 90 }, 520, 0.17)).toBe(Math.ceil(0.18 * 520));
    });

    it("falls back to the site's estimate when nothing has ever been measured", () => {
        expect(restingLiftPx({}, 1000, 0.17)).toBe(170);
    });
});

describe('pruneMeasuredLifts', () => {
    it('keeps the measurements nearest the current height', () => {
        const measured: MeasuredLifts = { '400': 70, '900': 150, '1000': 170, '1100': 190 };
        expect(pruneMeasuredLifts(measured, 1000, 2)).toEqual({ '1000': 170, '900': 150 });
    });

    it('leaves a map within the cap alone', () => {
        expect(pruneMeasuredLifts({ '1000': 170 }, 1000, 8)).toEqual({ '1000': 170 });
    });
});

describe('SaviControlsClearance — the subtitles rest above the control strip and stay there', () => {
    const POLL_MS = 300;
    // A 1000px-tall player whose bottom edge is at y=1000, so a control strip
    // whose top is at y=T needs a lift of (1000 - T) + the 10px margin.
    let videoHeight: number;
    let controlsTop: number | undefined; // undefined → unmounted, as Netflix does
    let offset: number; // what the overlay actually has
    let applied: number[];
    let saved: MeasuredLifts[];
    let stored: MeasuredLifts;
    let clearance: SaviControlsClearance | undefined;

    const video = {
        getBoundingClientRect: () => ({ height: videoHeight, bottom: videoHeight, top: 0 }) as DOMRect,
    } as HTMLMediaElement;

    const store: ClearanceStore = {
        load: async () => ({ ...stored }),
        save: async (_site, measured) => {
            saved.push(measured);
        },
    };

    const start = (host = 'www.netflix.com', base = 75) => {
        clearance = new SaviControlsClearance({
            video: () => video,
            applyOffset: (px) => {
                offset = px;
                applied.push(px);
            },
            currentOffset: () => offset,
            store,
            host,
        });
        clearance.baseOffsetPx = base;
        clearance.start();
        return clearance;
    };

    // One poll, with the store's promise allowed to land first.
    const tick = async (times = 1) => {
        for (let n = 0; n < times; n++) {
            await Promise.resolve();
            jest.advanceTimersByTime(POLL_MS);
        }
        await Promise.resolve();
    };

    beforeEach(() => {
        jest.useFakeTimers();
        videoHeight = 1000;
        controlsTop = undefined;
        offset = 75;
        applied = [];
        saved = [];
        stored = {};
        const strip = document.createElement('div');
        strip.className = 'watch-video--bottom-controls-container';
        strip.getBoundingClientRect = () =>
            ({ height: controlsTop === undefined ? 0 : 1000 - controlsTop, top: controlsTop ?? 0 }) as DOMRect;
        document.body.appendChild(strip);
    });

    afterEach(() => {
        clearance?.stop();
        clearance = undefined;
        document.body.innerHTML = '';
        jest.useRealTimers();
    });

    it('rests above the strip before the controls have ever been seen', async () => {
        start();
        await tick();
        expect(offset).toBe(170); // 17% of the player — not the 75px that sits on the progress bar
    });

    it('does not move when the controls come and go', async () => {
        // The regression: hovering a word brought the controls up and the text
        // jumped out from under the cursor, then jumped back when they hid.
        start();
        await tick();
        controlsTop = 838; // needs 172 — the estimate on screen was right
        await tick(3);
        controlsTop = undefined;
        await tick(3);
        controlsTop = 838;
        await tick(3);
        expect(applied).toEqual([170]);
        // Confirming the estimate records what is ON SCREEN, so it cannot move later either.
        expect(saved[saved.length - 1]).toEqual({ '1000': 170 });
    });

    it('settles once, to a measurement that really differs, and then holds', async () => {
        start();
        await tick();
        controlsTop = 800; // needs 210
        await tick();
        expect(offset).toBe(170); // one reading is not believed yet
        await tick();
        expect(offset).toBe(210);
        controlsTop = undefined;
        await tick(3);
        expect(offset).toBe(210); // and it does NOT drop back when they hide
        expect(applied).toEqual([170, 210]);
        expect(saved[saved.length - 1]).toEqual({ '1000': 210 });
    });

    it('never learns a strip caught mid-transition', async () => {
        start();
        await tick();
        for (const top of [950, 900, 850]) {
            controlsTop = top;
            await tick();
        }
        expect(applied).toEqual([170]);
        expect(saved).toEqual([]);
    });

    it('rests at the height measured in an earlier session without waiting for the controls', async () => {
        stored = { '1000': 210 };
        start();
        await tick();
        expect(offset).toBe(210);
        expect(controlsTop).toBeUndefined(); // they never showed
    });

    it('puts back an offset that something else overwrote', async () => {
        // A settings reload used to reset the overlay to 75 while the module
        // still believed its lift was applied, so the text sat on the strip.
        start();
        await tick();
        offset = 75;
        await tick();
        expect(offset).toBe(170);
    });

    it('follows the player when it is resized, scaled from what it has measured', async () => {
        stored = { '1000': 210 };
        start();
        await tick();
        videoHeight = 500;
        await tick();
        expect(offset).toBe(105);
    });

    it("never goes below the user's own setting", async () => {
        start('www.netflix.com', 300);
        offset = 300;
        await tick();
        expect(offset).toBe(300);
        expect(clearance!.effectiveOffsetPx()).toBe(300);
    });

    it('is a no-op on a site it does not know', async () => {
        start('example.com');
        await tick(2);
        expect(applied).toEqual([]);
        expect(clearance!.effectiveOffsetPx()).toBe(75);
    });

    it('answers with the bare setting once stopped', async () => {
        const c = start();
        await tick();
        c.stop();
        expect(c.effectiveOffsetPx()).toBe(75);
    });
});
