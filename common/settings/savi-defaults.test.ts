import { defaultSettings } from './settings-provider';

// A savi default that is a decision, not a convenience.
//
// Defaults are invisible by construction — nothing renders them, no test
// touches them, and the only signal is a user eventually asking "why is it
// doing that?". Pinning it means a flip has to be deliberate and shows up in
// review as a changed expectation.
describe('savi setting defaults', () => {
    it('offers the "Don’t use Savi on this site" button by default', () => {
        // Briefly off, after an accidental tap muted all of netflix.com and the
        // undo list came back empty. Both halves of that are fixed — the list
        // refreshes live, always renders, and is no longer overwritten — and
        // the prompt grew a ✕ that declines it per-site. So it is offered
        // again; turning it off is now a preference, not damage control.
        expect(defaultSettings.saviLanguageHushButton).toBe(true);
    });
});
