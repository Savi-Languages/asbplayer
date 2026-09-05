import { prepareTargets, drainTargetMines, queueTargetMines } from './target-service';
import { storedAccount, currentAccessToken } from './account';
import { mineHeardTarget } from './daemon-client';
jest.mock('./account', () => ({ storedAccount: jest.fn(), currentAccessToken: jest.fn() }));
jest.mock('./cloud-client', () => ({ resolveCloudBase: () => 'https://test.invalid' }));
jest.mock('./daemon-client', () => ({ mineHeardTarget: jest.fn() }));
let data: Record<string, any>;
beforeEach(() => {
    jest.resetAllMocks();
    data = {};
    Object.defineProperty(global, 'crypto', { configurable: true, value: require('crypto').webcrypto });
    (global as any).TextEncoder = require('util').TextEncoder;
    (storedAccount as jest.Mock).mockResolvedValue({ userId: 'alice', accessToken: 'token' });
    (currentAccessToken as jest.Mock).mockResolvedValue('token');
    const storage = {
        get: jest.fn(async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] })),
        set: jest.fn(async (values: any) => {
            Object.assign(data, values);
        }),
        remove: jest.fn(async (key: string) => {
            delete data[key];
        }),
    };
    (global as any).browser = { storage: { local: storage, session: { get: async () => ({}), set: async () => {} } } };
});
const action = { id: 'dismissal', kind: 'target_dismissed_known', lang: 'ja', lemma: '関与', source: 'episode:1:S1E1' };
it('keeps a dismissal hidden when its outbox entry drains during a stale target response', async () => {
    data['saviTargetFeedback:dismissal'] = { account: 'alice', action };
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
        queueTargetMines('alice', [mine('関与')]),
        queueTargetMines('alice', [mine('関与'), mine('証拠')]),
    ]);
    expect(Object.keys(data)).toHaveLength(2);
    (mineHeardTarget as jest.Mock)
        .mockRejectedValueOnce(new Error('heard event not yet available'))
        .mockResolvedValueOnce({ ok: true });
    await drainTargetMines(async () => ({}) as any);
    expect(mineHeardTarget).toHaveBeenCalledTimes(2);
    expect(Object.values(data).filter((v) => v.done)).toHaveLength(1);
    expect(Object.values(data).filter((v) => v.payload)).toHaveLength(1);
});
it('checks new local dismissals for each queued line and never delivers another account', async () => {
    await queueTargetMines('alice', [mine('証拠'), mine('関与')]);
    data['saviTargetMine:other'] = { account: 'bob', payload: { ...mine('秘密'), account: 'bob' } };
    (mineHeardTarget as jest.Mock).mockImplementation(async () => {
        data['saviTargetFeedback:dismissal'] = { account: 'alice', action };
        return { ok: true };
    });
    await drainTargetMines(async () => ({}) as any);
    expect(mineHeardTarget).toHaveBeenCalledTimes(1);
    expect(data['saviTargetMine:other'].payload.account).toBe('bob');
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
