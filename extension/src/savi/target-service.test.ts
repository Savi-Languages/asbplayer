import { prepareTargets, drainTargetFeedback, drainTargetMines, queueTargetMines } from './target-service';
import { storedAccount, currentAccessToken } from './account';
import { mineHeardTarget } from './daemon-client';
jest.mock('./account', () => ({ storedAccount: jest.fn(), currentAccessToken: jest.fn() }));
jest.mock('./cloud-client', () => ({ resolveCloudBase: (url: string) => url || 'https://test.invalid' }));
jest.mock('./daemon-client', () => ({ mineHeardTarget: jest.fn() }));
let data: Record<string, any>;
beforeEach(() => {
    jest.resetAllMocks();
    data = {};
    Object.defineProperty(global, 'crypto', { configurable: true, value: require('crypto').webcrypto });
    (global as any).TextEncoder = require('util').TextEncoder;
    (storedAccount as jest.Mock).mockResolvedValue({ userId: 'alice', accessToken: 'token' });
    (currentAccessToken as jest.Mock).mockResolvedValue('token');
    const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
    const storage = {
        get: jest.fn(async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] })),
        set: jest.fn(async (values: any) => {
            const changes = Object.fromEntries(
                Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue }])
            );
            Object.assign(data, values);
            listeners.forEach((listener) => listener(changes, 'local'));
        }),
        remove: jest.fn(async (key: string) => {
            delete data[key];
        }),
    };
    (global as any).browser = {
        storage: {
            local: storage,
            session: { get: async () => ({}), set: async () => {} },
            onChanged: {
                addListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
                    listeners.add(listener),
                removeListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
                    listeners.delete(listener),
            },
        },
    };
});
const action = { id: 'dismissal', kind: 'target_dismissed_known', lang: 'ja', lemma: '関与', source: 'episode:1:S1E1' };
it('keeps a dismissal hidden when its outbox entry drains during a stale target response', async () => {
    data['saviTargetFeedback:dismissal'] = { base: 'https://test.invalid', account: 'alice', action };
    const identity = { mediaType: 'tv', tmdbId: 1, season: 1, episode: 1, title: 'Dark' };
    browser.storage.session.get = jest.fn().mockResolvedValue({});
    (global as any).fetch = jest.fn(async (url: string) => {
        let value: any = {};
        if (url.endsWith('/v2/settings')) value = { settings: {} };
        else if (url.includes('/v2/shows/search')) value = { results: [{ id: 1, name: 'Dark' }] };
        else if (url.includes('/targets?')) {
            delete data['saviTargetFeedback:dismissal'];
            value = { targets: [{ lemma: '関与' }, { lemma: '証拠' }] };
        }
        return { ok: true, json: async () => value };
    });
    browser.storage.session.get = jest.fn(async (key: any) => ({ [key]: { account: 'alice', identity } }));
    const result = await prepareTargets('', { episodeId: 'netflix:1', title: 'S1:E1', lang: 'ja' });
    expect(result?.targets.map((t) => t.lemma)).toEqual(['証拠']);
});
it('isolates target feedback failures so one row cannot poison the outbox', async () => {
    const feedback = (id: string, occurredAtMs: number) => ({ ...action, id, occurredAtMs });
    data['saviTargetFeedback:permanent'] = {
        base: 'https://test.invalid',
        account: 'alice',
        action: feedback('permanent', 1),
    };
    data['saviTargetFeedback:retryable'] = {
        base: 'https://test.invalid',
        account: 'alice',
        action: feedback('retryable', 2),
    };
    data['saviTargetFeedback:delivered'] = {
        base: 'https://test.invalid',
        account: 'alice',
        action: feedback('delivered', 3),
    };
    (global as any).fetch = jest.fn(async (_url: string, init: RequestInit) => {
        const id = JSON.parse(String(init.body)).actions[0].id;
        const status = id === 'permanent' ? 422 : id === 'retryable' ? 500 : 200;
        return { ok: status === 200, status, json: async () => ({}) };
    });

    await drainTargetFeedback('');

    expect((global as any).fetch).toHaveBeenCalledTimes(3);
    expect(data['saviTargetFeedback:permanent']).toBeUndefined();
    expect(data['saviTargetFeedback:delivered']).toBeUndefined();
    expect(data['saviTargetFeedback:retryable']).toBeDefined();
});
const mine = (lemma: string) => ({
    account: 'alice',
    episodeId: 'netflix:1',
    tmdb: 1,
    lineStartMs: 1000,
    occurredAtMs: 2000,
    lang: 'ja',
    lineText: lemma,
    surface: lemma,
    lemma,
    exportToAnki: false,
});
it('deduplicates enqueue and lets later lines progress past a retryable failure', async () => {
    await Promise.all([
        queueTargetMines('', 'alice', [mine('関与')]),
        queueTargetMines('', 'alice', [mine('関与'), mine('証拠')]),
    ]);
    expect(Object.keys(data)).toHaveLength(2);
    (mineHeardTarget as jest.Mock)
        .mockRejectedValueOnce(new Error('heard event not yet available'))
        .mockResolvedValueOnce({ ok: true });
    (global as any).fetch = jest.fn(async (url: string) => ({
        ok: true,
        json: async () => ({ account: 'alice', eligible: [url && '証拠'], autoMineToAnki: true }),
    }));
    await drainTargetMines('', async () => ({}) as any);
    expect(mineHeardTarget).toHaveBeenCalledTimes(2);
    expect(mineHeardTarget).toHaveBeenCalledWith({}, expect.objectContaining({ eligible: true, autoMineToAnki: true }));
    expect(Object.values(data).filter((v) => v.done)).toHaveLength(1);
    expect(Object.values(data).filter((v) => v.payload)).toHaveLength(1);
});
it('checks new local dismissals for each queued line and never delivers another account', async () => {
    await queueTargetMines('', 'alice', [mine('証拠'), mine('関与')]);
    data['saviTargetMine:other'] = {
        base: 'https://test.invalid',
        account: 'bob',
        payload: { ...mine('秘密'), account: 'bob' },
    };
    (mineHeardTarget as jest.Mock).mockImplementation(async () => {
        await browser.storage.local.set({
            'saviTargetFeedback:dismissal': { base: 'https://test.invalid', account: 'alice', action },
        });
        return { ok: true };
    });
    (global as any).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ account: 'alice', eligible: ['証拠', '関与'], autoMineToAnki: false }),
    }));
    await drainTargetMines('', async () => ({}) as any);
    expect(mineHeardTarget).toHaveBeenCalledTimes(1);
    expect(data['saviTargetMine:other'].payload.account).toBe('bob');
});

it('keeps a mine queued when the cloud eligibility response belongs to another account', async () => {
    await queueTargetMines('', 'alice', [mine('関与')]);
    (global as any).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ account: 'bob', eligible: ['関与'], autoMineToAnki: true }),
    }));
    await drainTargetMines('', async () => ({}) as any);
    expect(mineHeardTarget).not.toHaveBeenCalled();
    expect(Object.values(data).filter((v) => v.payload)).toHaveLength(1);
});

it('never drains a target mine into a different configured backend', async () => {
    await queueTargetMines('https://one.invalid', 'alice', [mine('関与')]);
    await drainTargetMines('https://two.invalid', async () => ({}) as any);
    expect(mineHeardTarget).not.toHaveBeenCalled();

    (global as any).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ account: 'alice', eligible: ['関与'], autoMineToAnki: false }),
    }));
    (mineHeardTarget as jest.Mock).mockResolvedValue({ ok: true });
    await drainTargetMines('https://one.invalid', async () => ({}) as any);
    expect(mineHeardTarget).toHaveBeenCalledTimes(1);
});

it('uses the UI filesystem-safe capture mapping before attempting metadata resolution', async () => {
    const source = 'capture:netflix_123';
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 48);
    const identity = { mediaType: 'tv', tmdbId: 99, season: 2, episode: 3, title: 'Corrected show' };
    (global as any).fetch = jest.fn(async (url: string) => ({
        ok: true,
        json: async () =>
            url.endsWith('/v2/settings')
                ? { settings: { mediaIdentity: { value: { [hash]: { schema: 1, source, identity } } } } }
                : { targets: [] },
    }));
    const result = await prepareTargets('', { episodeId: 'netflix:123', title: 'Unresolvable title', lang: 'ja' });
    expect(result?.identity).toEqual(identity);
    expect((global as any).fetch.mock.calls.map((c: any) => c[0])).toEqual([
        'https://test.invalid/v2/settings',
        'https://test.invalid/v2/episodes/99/2/3/targets?lang=ja',
    ]);
});
