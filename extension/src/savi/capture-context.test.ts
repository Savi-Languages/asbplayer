import { allowsAutomaticCapture } from './capture-context';

describe('allowsAutomaticCapture', () => {
    const context = (href: string, top?: Window) => {
        const frame = { location: new URL(href) } as unknown as Window;
        Object.defineProperty(frame, 'top', { value: top ?? frame });
        return frame;
    };

    it('allows a top-level YouTube page but rejects its third-party embed frame', () => {
        const top = {} as Window;
        Object.defineProperty(top, 'top', { value: top });
        Object.defineProperty(top, 'location', { value: new URL('https://www.youtube.com/watch?v=abc') });
        const frame = context('https://www.youtube.com/embed/abc', top);

        expect(allowsAutomaticCapture(top)).toBe(true);
        expect(allowsAutomaticCapture(frame)).toBe(false);
    });

    it('preserves automatic capture and idle restart in a non-YouTube iframe player', () => {
        const top = context('https://www.crunchyroll.com/watch/episode');
        const player = context('https://static.crunchyroll.com/player/frame', top);
        expect(allowsAutomaticCapture(player)).toBe(true);
    });

    it('rejects alternate YouTube embed hosts but allows lookalike domains', () => {
        const top = context('https://example.com/article');
        expect(allowsAutomaticCapture(context('https://www.youtube-nocookie.com/embed/abc', top))).toBe(false);
        expect(allowsAutomaticCapture(context('https://youtube.googleapis.com/embed/abc', top))).toBe(false);
        expect(allowsAutomaticCapture(context('https://notyoutube-nocookie.com/embed/abc', top))).toBe(true);
    });

    it('allows an inaccessible non-YouTube browsing context instead of disabling every iframe player', () => {
        const inaccessible = { location: new URL('https://player.example.com/embed/1') } as unknown as Window;
        Object.defineProperty(inaccessible, 'top', {
            get: () => {
                throw new Error('cross-origin');
            },
        });
        expect(allowsAutomaticCapture(inaccessible)).toBe(true);
    });
});
