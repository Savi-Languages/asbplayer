import { clearanceOffsetPx, controlsSelectorForHost, controlsVisible } from './controls-clearance';

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
