import { isTopLevelFrame } from './capture-context';

describe('isTopLevelFrame', () => {
    it('allows a top-level page and rejects a third-party iframe', () => {
        const top = {} as Window;
        Object.defineProperty(top, 'top', { value: top });
        const frame = {} as Window;
        Object.defineProperty(frame, 'top', { value: top });

        expect(isTopLevelFrame(top)).toBe(true);
        expect(isTopLevelFrame(frame)).toBe(false);
    });

    it('fails closed when the browsing context cannot be inspected', () => {
        const inaccessible = {} as Window;
        Object.defineProperty(inaccessible, 'top', {
            get: () => {
                throw new Error('cross-origin');
            },
        });
        expect(isTopLevelFrame(inaccessible)).toBe(false);
    });
});
