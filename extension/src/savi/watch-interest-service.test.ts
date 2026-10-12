jest.mock('./account', () => ({ storedAccount: jest.fn() }));
jest.mock('./cloud-client', () => ({ resolveCloudBase: (url: string) => url }));
jest.mock('./target-service', () => ({ targetCloud: jest.fn() }));
import { storedAccount } from './account';
import { targetCloud } from './target-service';
import {
    queueWatchInterest,
    drainWatchInterest,
    setImmersionMode,
    watchInterestConfig,
} from './watch-interest-service';
const pending: Record<string, any> = {};
const request = jest.fn();
beforeEach(() => {
    Object.keys(pending).forEach((k) => delete pending[k]);
    jest.clearAllMocks();
    (globalThis as any).browser = {
        storage: {
            local: {
                get: jest.fn(async (key: string | null) => (key ? { [key]: pending[key] } : { ...pending })),
                set: jest.fn(async (values: any) => Object.assign(pending, values)),
                remove: jest.fn(async (key: string) => {
                    delete pending[key];
                }),
            },
        },
    };
    (storedAccount as jest.Mock).mockResolvedValue({ userId: 'a' });
    (targetCloud as jest.Mock).mockResolvedValue({ user: 'a', check: async () => {}, request });
    request.mockImplementation(async (path: string) => {
        if (path === '/v2/settings')
            return { settings: { saviSavePausedHovers: { value: true }, saviImmersionMode: { value: 'explore' } } };
        throw new Error('offline');
    });
});
test('queue survives offline and drains only to its account and backend', async () => {
    const item = {
        lang: 'ja',
        episodeId: 'netflix:1',
        kind: 'hover',
        dwellMs: 1500,
        lineText: '準備に手間取った',
        lineStartMs: 1000,
        lineEndMs: 2000,
    };
    expect(await queueWatchInterest('local', 'b', item)).toEqual({ ok: false });
    expect(await queueWatchInterest('local', 'a', item)).toEqual({ ok: true });
    await drainWatchInterest('local').catch(() => {});
    const keys = () => Object.keys(pending).filter((k) => k.startsWith('saviWatchInterest:'));
    expect(keys()).toHaveLength(1);
    await drainWatchInterest('production');
    expect(keys()).toHaveLength(1);
    request.mockImplementation(async (path: string) =>
        path === '/v2/settings'
            ? { settings: { saviSavePausedHovers: { value: true }, saviImmersionMode: { value: 'explore' } } }
            : {}
    );
    expect(pending[keys()[0]].retryAt).toBeGreaterThan(Date.now());
    pending[keys()[0]].retryAt = Date.now() - 1;
    await drainWatchInterest('local');
    expect(keys()).toHaveLength(0);
});

test("never caches a switched account's consent under the previous account", async () => {
    (storedAccount as jest.Mock).mockResolvedValueOnce({ userId: 'a' }).mockResolvedValueOnce({ userId: 'b' });
    (targetCloud as jest.Mock).mockResolvedValue({
        user: 'b',
        check: async () => {},
        request: async () => ({
            settings: { saviSavePausedHovers: { value: true }, saviImmersionMode: { value: 'explore' } },
        }),
    });

    await expect(watchInterestConfig('local')).resolves.toEqual({ account: 'b', mode: 'watch', enabled: false });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
});

test('Watch blocks automatic hover mining but permits deliberate bookmarks', async () => {
    request.mockImplementation(async (path: string) =>
        path === '/v2/settings'
            ? { settings: { saviSavePausedHovers: { value: true }, saviImmersionMode: { value: 'watch' } } }
            : {}
    );
    const item = {
        lang: 'ja',
        episodeId: 'netflix:2',
        kind: 'hover',
        dwellMs: 1500,
        lineText: 'そうなんだ',
        lineStartMs: 1000,
        lineEndMs: 2000,
    };
    expect(await queueWatchInterest('local', 'a', item)).toEqual({ ok: false });
    expect(await queueWatchInterest('local', 'a', { ...item, kind: 'bookmark' })).toEqual({ ok: true });
});
test('rejects untimed interests that the cloud contract cannot store', async () => {
    const base = {
        lang: 'ja',
        episodeId: 'spotify:track:1234567890123456789012',
        kind: 'bookmark',
        lineText: '最初の行',
        textTiming: 'untimed',
        lineStartMs: 0,
        lineEndMs: 0,
    };
    expect(await queueWatchInterest('local', 'a', base)).toEqual({ ok: false });
    expect(Object.keys(pending).filter((k) => k.startsWith('saviWatchInterest:'))).toHaveLength(0);
    expect(await queueWatchInterest('local', 'a', { ...base, lineEndMs: 1000 })).toEqual({ ok: false });
});

test('keeps an explicit bookmark when the same line already has a hover job', async () => {
    const item = {
        lang: 'ja',
        episodeId: 'netflix:2',
        kind: 'hover',
        dwellMs: 1500,
        lineText: 'そうなんだ',
        lineStartMs: 1000,
        lineEndMs: 2000,
    };
    expect(await queueWatchInterest('local', 'a', item)).toEqual({ ok: true });
    expect(await queueWatchInterest('local', 'a', { ...item, kind: 'bookmark' })).toEqual({ ok: true });
    expect(Object.keys(pending).filter((key) => key.startsWith('saviWatchInterest:'))).toHaveLength(2);
});

test.each([400, 413, 422])(
    'drops a queued row after validation HTTP %s instead of retrying forever',
    async (status) => {
        const item = {
            lang: 'ja',
            episodeId: 'spotify:track:1234567890123456789012',
            kind: 'bookmark',
            lineText: '時間のある行',
            textTiming: 'timed',
            lineStartMs: 1000,
            lineEndMs: 2000,
        };
        expect(await queueWatchInterest('local', 'a', item)).toEqual({ ok: true });
        await drainWatchInterest('local').catch(() => {});
        request.mockImplementation(async (path: string) => {
            if (path === '/v2/settings')
                return { settings: { saviSavePausedHovers: { value: true }, saviImmersionMode: { value: 'explore' } } };
            throw { status };
        });
        const key = Object.keys(pending).find((candidate) => candidate.startsWith('saviWatchInterest:'))!;
        pending[key].retryAt = Date.now() - 1;
        await drainWatchInterest('local');
        expect(pending[key]).toBeUndefined();
    }
);

test.each([401, 403, 408, 429, 500])('retains a queued row after retryable HTTP %s', async (status) => {
    const item = {
        lang: 'ja',
        episodeId: 'spotify:track:1234567890123456789012',
        kind: 'bookmark',
        lineText: '時間のある行',
        textTiming: 'timed',
        lineStartMs: 1000,
        lineEndMs: 2000,
    };
    expect(await queueWatchInterest('local', 'a', item)).toEqual({ ok: true });
    await drainWatchInterest('local').catch(() => {});
    request.mockImplementation(async (path: string) => {
        if (path === '/v2/settings')
            return { settings: { saviSavePausedHovers: { value: true }, saviImmersionMode: { value: 'explore' } } };
        throw { status };
    });
    const key = Object.keys(pending).find((candidate) => candidate.startsWith('saviWatchInterest:'))!;
    pending[key].retryAt = Date.now() - 1;
    await drainWatchInterest('local');
    expect(pending[key].retryAt).toBeGreaterThan(Date.now());
});

describe('local immersion modes', () => {
    test('switches and restores modes without an account or cloud requests', async () => {
        (storedAccount as jest.Mock).mockResolvedValue(null);
        expect(await setImmersionMode('local', 'listen')).toMatchObject({ ok: true, mode: 'listen' });
        expect(await watchInterestConfig('local')).toMatchObject({ enabled: false, mode: 'listen' });
        expect(targetCloud).not.toHaveBeenCalled();
    });
    test('an offline account can switch modes without enabling hover collection', async () => {
        (targetCloud as jest.Mock).mockRejectedValue(new Error('offline'));
        expect(await setImmersionMode('local', 'explore')).toMatchObject({ ok: true });
        expect(await watchInterestConfig('local')).toMatchObject({ mode: 'explore', enabled: false });
    });
    test('local choices survive older cloud settings and stay scoped to account and backend', async () => {
        await setImmersionMode('local', 'listen');
        expect(await watchInterestConfig('local')).toMatchObject({ mode: 'listen' });
        expect(await watchInterestConfig('other')).toMatchObject({ mode: 'explore' });
        (storedAccount as jest.Mock).mockResolvedValue(null);
        expect(await watchInterestConfig('local')).toMatchObject({ mode: 'watch' });
    });
    test('writes locally first and then syncs the timestamped choice to cloud', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1234);
        await expect(setImmersionMode('local', 'listen')).resolves.toMatchObject({ ok: true, mode: 'listen' });
        expect(Object.values(pending)).toContainEqual({ mode: 'listen', at: 1234 });
        await Promise.resolve();
        await Promise.resolve();
        expect(request).toHaveBeenCalledWith('/v2/settings/saviImmersionMode', 'PUT', {
            value: 'listen',
            updatedAtMs: 1234,
        });
        jest.restoreAllMocks();
    });
    test('a newer cloud timestamp replaces stale local shadow state', async () => {
        pending['saviLocalImmersionMode:["local","a"]'] = { mode: 'listen', at: 100 };
        request.mockImplementation(async (path: string) => {
            if (path === '/v2/settings')
                return {
                    settings: {
                        saviSavePausedHovers: { value: true },
                        saviImmersionMode: { value: 'explore', updatedAtMs: 200 },
                    },
                };
            return {};
        });
        expect(await watchInterestConfig('local')).toMatchObject({ mode: 'listen' });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(await watchInterestConfig('local')).toMatchObject({ mode: 'explore' });
    });
});

test('honors bookmark retry backoff even when automatic hover saving is disabled', async () => {
    const item = {
        lang: 'ja',
        episodeId: 'netflix:5',
        kind: 'bookmark',
        lineText: 'retry later',
        lineStartMs: 1000,
        lineEndMs: 2000,
    };
    expect(await queueWatchInterest('local', 'a', item)).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const key = Object.keys(pending).find((candidate) => candidate.startsWith('saviWatchInterest:'))!;
    pending[key].retryAt = Date.now() + 60_000;
    request.mockClear();
    request.mockImplementation(async (path: string) => {
        if (path === '/v2/settings') return { settings: { saviSavePausedHovers: { value: false } } };
        throw new Error('must not retry during backoff');
    });

    await drainWatchInterest('local');

    expect(request).toHaveBeenCalledTimes(1);
    expect(pending[key]).toBeDefined();
});
