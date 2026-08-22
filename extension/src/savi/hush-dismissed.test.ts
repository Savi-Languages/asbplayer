import { clearHushDismissal, dismissHushFor, isHushDismissed, resetHushDismissedMemo } from './hush-dismissed';
import { isSiteMuted, muteSite, resetMutedSitesMemo } from './muted-sites';

describe('savi hush dismissal', () => {
    beforeEach(() => {
        const store: Record<string, unknown> = {};
        (globalThis as any).browser = {
            storage: {
                local: {
                    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
                    set: async (items: Record<string, unknown>) => {
                        Object.assign(store, items);
                    },
                },
            },
        };
        resetHushDismissedMemo();
        resetMutedSitesMemo();
    });

    it('remembers the dismissal for the whole site, not one page', async () => {
        expect(await isHushDismissed('youtube.com')).toBe(false);
        await dismissHushFor('youtube.com');
        expect(await isHushDismissed('youtube.com')).toBe(true);
    });

    it('does NOT mute the site it dismisses the prompt for', async () => {
        // The whole point of the ✕: the user wants savi to keep running here.
        // If this ever conflates the two sets, closing the prompt would do the
        // exact thing the prompt was offering to do.
        await dismissHushFor('youtube.com');
        expect(await isSiteMuted('youtube.com')).toBe(false);
    });

    it('does not dismiss a site just because another was dismissed', async () => {
        await dismissHushFor('a.com');
        expect(await isHushDismissed('b.com')).toBe(false);
    });

    it('offers the prompt again once the dismissal is cleared', async () => {
        await dismissHushFor('a.com');
        await clearHushDismissal('a.com');
        expect(await isHushDismissed('a.com')).toBe(false);
    });

    it('is unaffected by muting a site', async () => {
        await muteSite('a.com');
        expect(await isHushDismissed('a.com')).toBe(false);
    });
});
