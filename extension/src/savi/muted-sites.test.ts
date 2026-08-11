import {
    LOCAL_FILE_SITE_KEY,
    isSiteMuted,
    muteSite,
    mutedSites,
    resetMutedSitesMemo,
    siteKeyForUrl,
    unmuteSite,
} from './muted-sites';

describe('siteKeyForUrl', () => {
    it('reduces a URL to its bare hostname', () => {
        expect(siteKeyForUrl('https://www.youtube.com/watch?v=abc')).toBe('youtube.com');
        expect(siteKeyForUrl('https://youtube.com/watch?v=abc')).toBe('youtube.com');
        expect(siteKeyForUrl('http://EXAMPLE.com/a/b')).toBe('example.com');
    });

    it('does not let a subdomain mute its parent', () => {
        // Muting a company webmail must not take savi off the main site.
        expect(siteKeyForUrl('https://mail.example.com/x')).toBe('mail.example.com');
        expect(siteKeyForUrl('https://mail.example.com/x')).not.toBe(siteKeyForUrl('https://example.com/x'));
    });

    it('gives every local file one shared key', () => {
        // A file has no host, and "don't run savi on files I open from disk" is
        // one switch, not one per file.
        expect(siteKeyForUrl('file:///Users/me/a.mkv')).toBe(LOCAL_FILE_SITE_KEY);
        expect(siteKeyForUrl('file:///elsewhere/b.mp4')).toBe(LOCAL_FILE_SITE_KEY);
    });

    it('is undefined when there is no site to mute, rather than throwing', () => {
        for (const url of ['', '   ', 'not a url', 'about:blank', undefined as unknown as string]) {
            expect(() => siteKeyForUrl(url)).not.toThrow();
            expect(siteKeyForUrl(url)).toBeUndefined();
        }
    });
});

// In-memory browser.storage.local, following muted-episodes.test.ts.
describe('savi muted sites', () => {
    let store: Record<string, unknown>;

    beforeEach(() => {
        store = {};
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
        resetMutedSitesMemo();
    });

    it('starts empty', async () => {
        expect(await mutedSites()).toEqual([]);
        expect(await isSiteMuted('youtube.com')).toBe(false);
    });

    it('mutes and unmutes a site', async () => {
        await muteSite('youtube.com');
        expect(await isSiteMuted('youtube.com')).toBe(true);
        expect(await isSiteMuted('example.com')).toBe(false);

        await unmuteSite('youtube.com');
        expect(await isSiteMuted('youtube.com')).toBe(false);
    });

    it('does not duplicate a site muted twice', async () => {
        await muteSite('youtube.com');
        await muteSite('youtube.com');
        expect(await mutedSites()).toEqual(['youtube.com']);
    });

    it('survives storage being unavailable by failing open', async () => {
        // The gate's posture everywhere: a broken read must not be the reason
        // savi goes quiet, so "nothing muted" is the safe answer.
        (globalThis as any).browser.storage.local.get = async () => {
            throw new Error('storage gone');
        };
        resetMutedSitesMemo();
        expect(await mutedSites()).toEqual([]);
    });

    it('keeps the mute for the session when the write fails', async () => {
        (globalThis as any).browser.storage.local.set = async () => {
            throw new Error('quota');
        };
        await muteSite('example.com');
        // The click has to take effect now even if it cannot be persisted.
        expect(await isSiteMuted('example.com')).toBe(true);
    });
});
