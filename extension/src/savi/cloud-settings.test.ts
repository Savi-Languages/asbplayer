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
describe('savi roaming cloud settings', () => {
    let store: Record<string, unknown>;
    let fetchMock: jest.Mock;

    const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

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

    it('loads both values from the cloud and caches them', async () => {
        fetchMock.mockResolvedValue(
            okJson({
                settings: {
                    targetLanguage: { value: 'es', version: 1, updatedAtMs: 1 },
                    openSubtitlesApiKey: { value: 'k-123', version: 1, updatedAtMs: 1 },
                    audioSync: { value: { enabled: true }, version: 1, updatedAtMs: 1 },
                },
            })
        );

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded).toEqual({ targetLanguage: 'es', openSubtitlesApiKey: 'k-123' });
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'es', openSubtitlesApiKey: 'k-123' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://cloud.example/v2/settings');
        expect(init.method).toBe('GET');
        expect(init.headers.Authorization).toBe('Bearer jwt-1');
    });

    it('keeps a locally-set value when the cloud has no row for that key', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'es', openSubtitlesApiKey: 'local-key' };
        fetchMock.mockResolvedValue(
            okJson({ settings: { targetLanguage: { value: 'ja', version: 3, updatedAtMs: 3 } } })
        );

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded).toEqual({ targetLanguage: 'ja', openSubtitlesApiKey: 'local-key' });
    });

    it('strips a trailing slash from the cloud base URL', async () => {
        fetchMock.mockResolvedValue(okJson({ settings: {} }));
        await loadRoamingSettings('https://cloud.example/');
        expect(fetchMock.mock.calls[0][0]).toBe('https://cloud.example/v2/settings');
    });

    it('keeps the cache when signed out (no token)', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'ja', openSubtitlesApiKey: '' };
        tokenMock.mockResolvedValue(undefined);

        const loaded = await loadRoamingSettings('https://cloud.example');

        expect(loaded).toEqual({ targetLanguage: 'ja', openSubtitlesApiKey: '' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the cache when the cloud errors', async () => {
        store[ROAMING_CACHE_KEY] = { targetLanguage: 'ja', openSubtitlesApiKey: '' };
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

        expect(await loadRoamingSettings('https://cloud.example')).toEqual({
            targetLanguage: 'ja',
            openSubtitlesApiKey: '',
        });
    });

    it('write-through updates the cache and PUTs the value with an LWW timestamp', async () => {
        fetchMock.mockResolvedValue(okJson({ value: 'es-419', version: 2, updatedAtMs: 2 }));

        const next = await putRoamingSetting('https://cloud.example', 'targetLanguage', 'es-419');

        expect(next.targetLanguage).toBe('es-419');
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'es-419', openSubtitlesApiKey: '' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://cloud.example/v2/settings/targetLanguage');
        expect(init.method).toBe('PUT');
        const body = JSON.parse(init.body);
        expect(body.value).toBe('es-419');
        expect(typeof body.updatedAtMs).toBe('number');
    });

    it('still caches locally but throws when signed out', async () => {
        tokenMock.mockResolvedValue(undefined);

        await expect(putRoamingSetting('https://cloud.example', 'openSubtitlesApiKey', 'k-9')).rejects.toThrow(
            /sign in/i
        );
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: '', openSubtitlesApiKey: 'k-9' });
    });

    it('caches locally but throws when the cloud rejects the write', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

        await expect(putRoamingSetting('https://cloud.example', 'targetLanguage', 'es')).rejects.toThrow(/savi cloud/i);
        expect(store[ROAMING_CACHE_KEY]).toEqual({ targetLanguage: 'es', openSubtitlesApiKey: '' });
    });
});
