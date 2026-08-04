import {
    DEFAULT_ROAMING_SETTINGS,
    getCachedRoamingSettings,
    loadRoamingSettings,
    putRoamingSetting,
    ROAMING_CACHE_KEY,
} from './cloud-settings';
import { currentAccessToken } from './account';

jest.mock('./account', () => ({ currentAccessToken: jest.fn() }));

const tokenMock = currentAccessToken as jest.Mock;

// In-memory browser.storage.local + fetch fake, following account.test.ts.
// Since SV-30 a refresh makes TWO reads: /v2/settings (targetLanguage KV) and
// /v2/api-keys?provider=opensubtitles (the key rows managed in savi Settings).
describe('savi roaming cloud settings', () => {
    let store: Record<string, unknown>;
    let fetchMock: jest.Mock;

    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

    /** Dispatch the fake fetch by path: settings body vs api-keys body. */
    const mockCloud = (settingsBody: unknown, apiKeysBody: unknown) => {
        fetchMock.mockImplementation(async (url: string) =>
            url.includes('/v2/api-keys') ? apiKeysBody : settingsBody
        );
    };

    beforeEach(() => {
        store = {};
        fetchMock = jest.fn();
        (globalThis as any).fetch = fetchMock;
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
        tokenMock.mockReset();
        tokenMock.mockResolvedValue('jwt-1');
    });

    it('returns defaults when nothing is cached', async () => {
        expect(await getCachedRoamingSettings()).toEqual(DEFAULT_ROAMING_SETTINGS);
    });

    it('loads the language from the KV store and the key from api-keys', async () => {
        mockCloud(
            okJson({
                settings: {
                    targetLanguage: { value: 'es', version: 1, updatedAtMs: 1 },
                    audioSync: { value: { enabled: true }, version: 1, updatedAtMs: 1 },
                },
            }),
            okJson({ keys: [{ id: 'k1', provider: 'opensubtitles', key: 'k-123', exhaustedUntilMs: 0 }] })
        );

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded).toEqual({ targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: 'k-123' });
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: 'k-123' });
        const urls = fetchMock.mock.calls.map((c) => c[0]);
        expect(urls).toContain('https://cloud.example/v2/settings');
        expect(urls).toContain('https://cloud.example/v2/api-keys?provider=opensubtitles');
        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers.Authorization).toBe('Bearer jwt-1');
    });

    it('skips quota-exhausted keys and rotates to the next usable one', async () => {
        mockCloud(
            okJson({ settings: {} }),
            okJson({
                keys: [
                    { id: 'k1', key: 'spent', exhaustedUntilMs: Date.now() + 60_000 },
                    { id: 'k2', key: 'fresh', exhaustedUntilMs: 0 },
                ],
            })
        );

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded.openSubtitlesApiKey).toBe('fresh');
    });

    it('falls back to an exhausted key when nothing else exists', async () => {
        mockCloud(
            okJson({ settings: {} }),
            okJson({ keys: [{ id: 'k1', key: 'spent', exhaustedUntilMs: Date.now() + 60_000 }] })
        );

        expect((await loadRoamingSettings('https://cloud.example')).openSubtitlesApiKey).toBe('spent');
    });

    it('keeps the cached key when the api-keys read fails, clears it when the account has none', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: 'local-key' };

        // A failed read is indistinguishable from offline — keep the cache.
        mockCloud(okJson({ settings: {} }), { ok: false, status: 500, json: async () => ({}) });
        expect((await loadRoamingSettings('https://cloud.example')).openSubtitlesApiKey).toBe('local-key');

        // An empty list is authoritative: the keys live in savi Settings and
        // this extension can no longer write them, so absence means deleted.
        mockCloud(okJson({ settings: {} }), okJson({ keys: [] }));
        expect((await loadRoamingSettings('https://cloud.example')).openSubtitlesApiKey).toBe('');
    });

    it('keeps a locally-set language when the cloud has no row for it', async () => {
        // EVERY roaming language must survive this, not just the ones the merge
        // happens to name. A key left out of the merge is not merely ignored:
        // normalize() defaults it to '' and the result is written back over the
        // cache, so each settings load silently destroys what the user set.
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'es', nativeLanguage: 'en', openSubtitlesApiKey: '' };
        mockCloud(okJson({ settings: {} }), okJson({ keys: [] }));

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded.targetLanguage).toBe('es');
        expect(loaded.nativeLanguage).toBe('en');
        // ...and the write-back must not have clobbered it either.
        expect((store[ROAMING_CACHE_KEY] as any).nativeLanguage).toBe('en');
    });

    it('takes the cloud value for the native language when the cloud has one', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'ja', nativeLanguage: 'en', openSubtitlesApiKey: '' };
        mockCloud(okJson({ settings: { nativeLanguage: { value: 'fr', version: 2, updatedAtMs: 2 } } }), okJson({ keys: [] }));

        expect((await loadRoamingSettings('https://cloud.example')).nativeLanguage).toBe('fr');
    });

    it('strips a trailing slash from the cloud base URL', async () => {
        mockCloud(okJson({ settings: {} }), okJson({ keys: [] }));
        await loadRoamingSettings('https://cloud.example/');
        expect(fetchMock.mock.calls[0][0]).toBe('https://cloud.example/v2/settings');
    });

    it('keeps the cache when signed out (no token)', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'ja', nativeLanguage: '', openSubtitlesApiKey: 'k-9' };
        tokenMock.mockResolvedValue(undefined);

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded).toEqual({ targetLanguage: 'ja', nativeLanguage: '', openSubtitlesApiKey: 'k-9' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the cache when the cloud errors', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'ja', nativeLanguage: '', openSubtitlesApiKey: '' };
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

        expect(await loadRoamingSettings('https://cloud.example')).toEqual({
            targetLanguage: 'ja',
            nativeLanguage: '',
            openSubtitlesApiKey: '',
        });
    });

    it('write-through updates the cache and PUTs the value with an LWW timestamp', async () => {
        fetchMock.mockResolvedValue(okJson({ value: 'es-419', version: 2, updatedAtMs: 2 }));

        const next = await putRoamingSetting('https://cloud.example', 'targetLanguage', 'es-419');

        expect(next.targetLanguage).toBe('es-419');
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'es-419', nativeLanguage: '', openSubtitlesApiKey: '' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://cloud.example/v2/settings/targetLanguage');
        expect(init.method).toBe('PUT');
        const body = JSON.parse(init.body);
        expect(body.value).toBe('es-419');
        expect(typeof body.updatedAtMs).toBe('number');
    });

    it('still caches locally but throws when signed out', async () => {
        tokenMock.mockResolvedValue(undefined);

        await expect(putRoamingSetting('https://cloud.example', 'targetLanguage', 'ja')).rejects.toThrow(/sign in/i);
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'ja', nativeLanguage: '', openSubtitlesApiKey: '' });
    });

    it('caches locally but throws when the cloud rejects the write', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

        await expect(putRoamingSetting('https://cloud.example', 'targetLanguage', 'es')).rejects.toThrow(/savi cloud/i);
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'es', nativeLanguage: '', openSubtitlesApiKey: '' });
    });
});
