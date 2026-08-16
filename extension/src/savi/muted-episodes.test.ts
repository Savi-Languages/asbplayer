import {
    isEpisodeMuted,
    muteEpisode,
    mutedEpisodes,
    resetMutedEpisodesMemo,
    unmuteEpisode,
} from './muted-episodes';

// In-memory browser.storage.local, following cloud-settings.test.ts.
describe('savi muted episodes', () => {
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
        resetMutedEpisodesMemo();
    });

    it('starts empty', async () => {
        expect(await mutedEpisodes()).toEqual([]);
        expect(await isEpisodeMuted('youtube:abc')).toBe(false);
    });

    it('mutes and reports an episode', async () => {
        await muteEpisode('youtube:abc');
        expect(await isEpisodeMuted('youtube:abc')).toBe(true);
        expect(await isEpisodeMuted('youtube:def')).toBe(false);
    });

    it('survives a reload (persists through storage, not just memory)', async () => {
        await muteEpisode('youtube:abc');
        resetMutedEpisodesMemo();
        expect(await isEpisodeMuted('youtube:abc')).toBe(true);
    });

    it('unmutes', async () => {
        await muteEpisode('youtube:abc');
        await unmuteEpisode('youtube:abc');
        expect(await isEpisodeMuted('youtube:abc')).toBe(false);
    });

    it('does not duplicate a re-muted episode', async () => {
        await muteEpisode('youtube:abc');
        await muteEpisode('youtube:abc');
        expect(await mutedEpisodes()).toEqual(['youtube:abc']);
    });

    it('bounds the list, dropping the oldest', async () => {
        for (let i = 0; i < 520; i++) {
            await muteEpisode(`youtube:v${i}`);
        }
        const list = await mutedEpisodes();
        expect(list).toHaveLength(500);
        expect(list).not.toContain('youtube:v0');
        expect(list).toContain('youtube:v519');
    });

    it('fails open when storage throws', async () => {
        // A broken store must read as "nothing muted" — the gate then fails
        // open, rather than muting savi everywhere.
        (globalThis as any).browser.storage.local.get = async () => {
            throw new Error('storage unavailable');
        };
        resetMutedEpisodesMemo();
        expect(await mutedEpisodes()).toEqual([]);
        expect(await isEpisodeMuted('youtube:abc')).toBe(false);
    });

    it('ignores non-string junk in stored data', async () => {
        store['saviMutedEpisodes'] = ['youtube:abc', 42, null, { a: 1 }];
        resetMutedEpisodesMemo();
        expect(await mutedEpisodes()).toEqual(['youtube:abc']);
    });
});
