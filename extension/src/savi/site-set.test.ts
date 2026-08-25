import { siteSet } from './site-set';

// In-memory browser.storage.local, following muted-sites.test.ts.
const useMemoryStorage = () => {
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
    return store;
};

describe('siteSet', () => {
    let store: Record<string, unknown>;

    beforeEach(() => {
        store = useMemoryStorage();
    });

    it('starts empty and round-trips an added site', async () => {
        const sites = siteSet('testKey', 10);
        expect(await sites.all()).toEqual([]);
        await sites.add('youtube.com');
        expect(await sites.all()).toEqual(['youtube.com']);
        expect(await sites.has('youtube.com')).toBe(true);
        expect(await sites.has('example.com')).toBe(false);
    });

    it('keeps one entry per site, most recent last', async () => {
        const sites = siteSet('testKey', 10);
        await sites.add('a.com');
        await sites.add('b.com');
        await sites.add('a.com');
        expect(await sites.all()).toEqual(['b.com', 'a.com']);
    });

    it('drops the oldest past the cap', async () => {
        // An unbounded list written from a content script is a leak waiting
        // to happen — the same reason the episode list is bounded.
        const sites = siteSet('testKey', 3);
        for (const s of ['a', 'b', 'c', 'd']) {
            await sites.add(s);
        }
        expect(await sites.all()).toEqual(['b', 'c', 'd']);
    });

    it('removes a site', async () => {
        const sites = siteSet('testKey', 10);
        await sites.add('a.com');
        await sites.add('b.com');
        await sites.remove('a.com');
        expect(await sites.all()).toEqual(['b.com']);
    });

    it('replaces the whole list, applying the cap', async () => {
        // The cloud mirror needs to overwrite wholesale, not merge: the
        // account's list is the winner of a last-write-wins race, so a merge
        // here would silently resurrect entries another device removed.
        const sites = siteSet('testKey', 2);
        await sites.add('old.com');
        await sites.replace(['x.com', 'y.com', 'z.com']);
        expect(await sites.all()).toEqual(['y.com', 'z.com']);
    });

    it('reads through storage again after the memo is dropped', async () => {
        // The options page and the content script are different contexts, so
        // a stale in-process mirror would show a list the user already changed.
        const sites = siteSet('testKey', 10);
        await sites.add('a.com');
        store['testKey'] = ['written-elsewhere.com'];
        expect(await sites.all()).toEqual(['a.com']); // memo still authoritative
        sites.resetMemo();
        expect(await sites.all()).toEqual(['written-elsewhere.com']);
    });

    it('survives storage being unavailable by failing open', async () => {
        (globalThis as any).browser = {
            storage: {
                local: {
                    get: async () => {
                        throw new Error('no storage');
                    },
                    set: async () => {
                        throw new Error('no storage');
                    },
                },
            },
        };
        const sites = siteSet('testKey', 10);
        expect(await sites.all()).toEqual([]);
        await expect(sites.add('a.com')).resolves.toBeUndefined();
        expect(await sites.all()).toEqual(['a.com']); // still holds for this session
    });

    it('ignores non-string junk in stored data', async () => {
        store['testKey'] = ['ok.com', 42, null, { a: 1 }];
        const sites = siteSet('testKey', 10);
        expect(await sites.all()).toEqual(['ok.com']);
    });
});
