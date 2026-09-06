jest.mock('./account', () => ({ storedAccount: jest.fn() }));
jest.mock('./cloud-client', () => ({ resolveCloudBase: (url: string) => url }));
jest.mock('./target-service', () => ({ targetCloud: jest.fn() }));
import { storedAccount } from './account';
import { targetCloud } from './target-service';
import { queueWatchInterest, drainWatchInterest } from './watch-interest-service';
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
        if (path === '/v2/settings') return { settings: { saviSavePausedHovers: { value: true } } };
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
        path === '/v2/settings' ? { settings: { saviSavePausedHovers: { value: true } } } : {}
    );
    await drainWatchInterest('local');
    expect(keys()).toHaveLength(0);
});
