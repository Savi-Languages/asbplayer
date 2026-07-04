import { clearRecordingIntent, hasRecordingIntent, setRecordingIntent } from './recording-intent';

// recording-intent talks to browser.storage.session + browser.tabs.get; provide
// a self-contained in-memory fake (no existing test mocks `browser`).
describe('recording-intent', () => {
    let store: Record<string, unknown>;
    let openTabs: Set<number>;

    beforeEach(() => {
        store = {};
        openTabs = new Set<number>([7]);
        (globalThis as any).browser = {
            storage: {
                session: {
                    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
                    set: async (items: Record<string, unknown>) => {
                        Object.assign(store, items);
                    },
                    remove: async (key: string) => {
                        delete store[key];
                    },
                },
            },
            tabs: {
                get: async (tabId: number) => {
                    if (!openTabs.has(tabId)) {
                        throw new Error(`No tab with id ${tabId}`);
                    }
                    return { id: tabId };
                },
            },
        };
    });

    afterEach(() => {
        delete (globalThis as any).browser;
    });

    it('round-trips a per-tab intent marker', async () => {
        expect(await hasRecordingIntent(7)).toBe(false);
        await setRecordingIntent(7);
        expect(await hasRecordingIntent(7)).toBe(true);
        await clearRecordingIntent(7);
        expect(await hasRecordingIntent(7)).toBe(false);
    });

    it('is per-tab — one tab\'s intent does not leak to another', async () => {
        openTabs.add(8);
        await setRecordingIntent(7);
        expect(await hasRecordingIntent(7)).toBe(true);
        expect(await hasRecordingIntent(8)).toBe(false);
    });

    it('treats an undefined tab id as no intent', async () => {
        expect(await hasRecordingIntent(undefined)).toBe(false);
    });

    it('prunes a marker whose tab no longer exists (reused-id guard)', async () => {
        await setRecordingIntent(7);
        openTabs.delete(7); // tab closed; suppose onRemoved was missed
        expect(await hasRecordingIntent(7)).toBe(false);
        expect(store['saviRecordingIntent:7']).toBeUndefined(); // stale key swept
    });
});
