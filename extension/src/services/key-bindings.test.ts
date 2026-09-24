import { adjustedBaseSubtitleOffset } from './key-bindings';

describe('adjustedBaseSubtitleOffset', () => {
    it('nudges the saved base rather than a temporary controls-clearance lift', () => {
        expect(adjustedBaseSubtitleOffset(75, true)).toBe(95);
        expect(adjustedBaseSubtitleOffset(75, false)).toBe(55);
    });
});
