jest.mock('./account', () => ({ daemonCredentials: jest.fn(), storedAccount: jest.fn() }));
jest.mock('./daemon-client', () => ({ ...jest.requireActual('./daemon-client'), postWatchedLine: jest.fn() }));
import { daemonCredentials, storedAccount } from './account';
import { postWatchedLine, SaviDaemonHttpError } from './daemon-client';
// Direct coverage of SaviCommandHandler._warmProjections (SV-40 bind-time warm
// follow-up). The finding this closes: cloud-client.ts's warmProjections never
// checked response.ok, so a 401 (expired JWT), 404 (a cloud predating the
// route) or 500 all resolved as silent success — and this handler's own
// try/catch then always answered { ok: true } regardless of what actually
// happened, with nothing logged anywhere. Fixing cloud-client.ts to throw on a
// non-2xx response is only a real fix if this handler still (a) never lets
// that throw escape past it, and (b) stops claiming success once it does.
//
// cloud-client.ts is virtually mocked rather than imported for real: it reads
// import.meta.env (a Vite/WXT build-time construct) at module scope, which
// ts-jest cannot parse — so no test file can import it, or anything that
// imports it, without replacing it entirely first. That is also why no
// cloud-client.test.ts exists: the module cannot be loaded under Jest at all.
jest.mock('./cloud-client', () => ({
    DEFAULT_GLOSS_THRESHOLD: 0.8,
    glossThreshold: jest.fn(),
    resolveCloudBase: jest.fn((u: string) => u),
    glossLine: jest.fn(),
    translate: jest.fn(),
    wordBuckets: jest.fn(),
    wordsProficiency: jest.fn(),
    warmProjections: jest.fn(),
}));

import SaviCommandHandler from './background-handler';
import { warmProjections as mockWarmProjections } from './cloud-client';

describe('SaviCommandHandler._warmProjections', () => {
    const settings = { get: async () => ({ saviCloudUrl: 'https://cloud.example' }) } as any;

    const warm = (handler: SaviCommandHandler) =>
        (handler as unknown as { _warmProjections: (m: unknown) => Promise<{ ok?: boolean }> })._warmProjections({
            command: 'savi-warm-projections',
            lang: 'es',
        });

    beforeEach(() => {
        (mockWarmProjections as jest.Mock).mockReset();
    });

    it('reports { ok: true } when the cloud call actually succeeds', async () => {
        (mockWarmProjections as jest.Mock).mockResolvedValueOnce(undefined);
        const handler = new SaviCommandHandler(settings);

        await expect(warm(handler)).resolves.toEqual({ ok: true });
    });

    it('swallows a non-ok warm response (now a thrown error) without throwing, and stops claiming ok:true', async () => {
        // Simulates the post-fix cloud-client.ts behaviour: a non-2xx response
        // throws instead of resolving silently. Before the fix this branch was
        // unreachable — a 401/404/500 looked identical to success from here.
        (mockWarmProjections as jest.Mock).mockRejectedValueOnce(new Error('cloud warm failed: HTTP 401'));
        const handler = new SaviCommandHandler(settings);

        await expect(warm(handler)).resolves.toEqual({});
    });

    it('the public handle() dispatch never throws or leaves sendResponse uncalled on failure', async () => {
        (mockWarmProjections as jest.Mock).mockRejectedValueOnce(new Error('cloud warm failed: HTTP 500'));
        const handler = new SaviCommandHandler(settings);
        const sendResponse = jest.fn();

        const command = { sender: 'savi-video', message: { command: 'savi-warm-projections', lang: 'es' } };
        expect(() => handler.handle(command, {} as any, sendResponse)).not.toThrow();

        // handle() returns synchronously (true, meaning "async response
        // coming"); sendResponse fires once the promise chain settles.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(sendResponse).toHaveBeenCalledWith({});
    });
});

describe('Savi screenshot tab identity', () => {
    afterEach(() => {
        delete (globalThis as any).browser;
    });
    it('refuses an inactive sender tab', async () => {
        const capture = jest.fn();
        (globalThis as any).browser = {
            tabs: { get: async () => ({ active: false, windowId: 1 }), captureVisibleTab: capture },
        };
        const handler = new SaviCommandHandler({} as any);
        expect(await (handler as any)._captureFrame({ tab: { id: 5 } })).toEqual({});
        expect(capture).not.toHaveBeenCalled();
    });
    it('drops captured pixels if the active tab changed during capture', async () => {
        (globalThis as any).browser = {
            tabs: {
                get: async () => ({ active: true, windowId: 1 }),
                captureVisibleTab: async () => 'private-other-tab',
                query: async () => [{ id: 6 }],
            },
            windows: { get: async () => ({ focused: true }) },
        };
        const handler = new SaviCommandHandler({} as any);
        expect(await (handler as any)._captureFrame({ tab: { id: 5 } })).toEqual({});
    });
});

describe('watched-line daemon warning configuration', () => {
    let values: Record<string, any>;
    let token: string;
    let url: string;
    const send = (handler: SaviCommandHandler) =>
        (handler as any)._watchedLine({
            lang: 'ja',
            text: '猫',
            episodeId: 'netflix:1',
            lineStartMs: 1000,
            occurredAtMs: 1,
        });
    const handler = () =>
        new SaviCommandHandler({ get: async () => ({ saviDaemonUrl: url, saviDaemonToken: token }) } as any);
    beforeEach(() => {
        values = {};
        token = '';
        url = 'http://127.0.0.1:4030';
        (globalThis as any).browser = {
            storage: {
                local: {
                    get: jest.fn(async (key: string) => ({ [key]: values[key] })),
                    set: jest.fn(async (v: any) => Object.assign(values, v)),
                },
            },
        };
        (storedAccount as jest.Mock).mockResolvedValue({ userId: 'alice' });
        (daemonCredentials as jest.Mock).mockImplementation(async () => ({
            bearer: token || 'jwt',
            accountJwt: 'jwt',
        }));
        (postWatchedLine as jest.Mock).mockReset().mockRejectedValue(new TypeError('network failure'));
    });
    afterEach(() => {
        delete (globalThis as any).browser;
    });
    it('does not alarm for a signed-in default installation that never reached a daemon', async () => {
        expect(await send(handler())).toEqual({ ok: false, reason: 'not-configured' });
        expect(postWatchedLine).toHaveBeenCalled();
    });
    it('remembers a working JWT-only daemon across handler restarts, scoped to account and URL', async () => {
        (postWatchedLine as jest.Mock).mockResolvedValueOnce({});
        expect(await send(handler())).toEqual({ ok: true });
        expect(await send(handler())).toEqual({ ok: false, reason: 'unreachable' });
        (storedAccount as jest.Mock).mockResolvedValue({ userId: 'bob' });
        expect(await send(handler())).toEqual({ ok: false, reason: 'not-configured' });
    });
    it('still alarms for an explicitly configured LAN token or custom address', async () => {
        token = 'lan';
        expect(await send(handler())).toEqual({ ok: false, reason: 'unreachable' });
        token = '';
        url = 'http://desktop.local:4030';
        expect(await send(handler())).toEqual({ ok: false, reason: 'unreachable' });
    });
    it('does not mistake HTTP rejection for an unreachable daemon', async () => {
        (postWatchedLine as jest.Mock).mockRejectedValue(new SaviDaemonHttpError(401, 'Unauthorized'));
        expect(await send(handler())).toEqual({ ok: false, reason: 'rejected' });
    });
});

describe('watched-line daemon availability', () => {
    const message = { lang: 'ja', text: '猫', episodeId: 'episode', lineStartMs: 1200 };
    const handler = (saviDaemonToken = '', saviDaemonUrl = 'http://127.0.0.1:4030') =>
        new SaviCommandHandler({ get: async () => ({ saviDaemonToken, saviDaemonUrl }) } as any);
    const watched = (h: SaviCommandHandler) => (h as any)._watchedLine(message);
    beforeEach(() => {
        const values: Record<string, any> = {};
        (globalThis as any).browser = {
            storage: {
                local: {
                    get: jest.fn(async (key: string) => ({ [key]: values[key] })),
                    set: jest.fn(async (v: any) => Object.assign(values, v)),
                },
            },
        };
        jest.mocked(storedAccount).mockResolvedValue({ userId: 'alice' } as any);

        jest.mocked(daemonCredentials).mockImplementation(async (lanToken) => ({
            bearer: lanToken.trim() || 'account-jwt',
            accountJwt: 'account-jwt',
        }));
        jest.mocked(postWatchedLine).mockReset();
    });
    afterEach(() => {
        delete (globalThis as any).browser;
    });
    it('does not warn an extension-only user when the default daemon has never responded', async () => {
        jest.mocked(postWatchedLine).mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(watched(handler())).resolves.toEqual({ ok: false, reason: 'not-configured' });
    });
    it('still supports a working JWT-only daemon and reports a later disconnect', async () => {
        const h = handler();
        jest.mocked(postWatchedLine).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new TypeError('offline'));
        await expect(watched(h)).resolves.toEqual({ ok: true });
        await expect(watched(h)).resolves.toEqual({ ok: false, reason: 'unreachable' });
    });
    it.each([
        ['lan-token', 'http://127.0.0.1:4030'],
        ['', 'http://desktop.local:4030'],
    ])('warns on a configured daemon transport failure (%s, %s)', async (token, url) => {
        jest.mocked(postWatchedLine).mockRejectedValue(new TypeError('offline'));
        await expect(watched(handler(token, url))).resolves.toEqual({ ok: false, reason: 'unreachable' });
    });
    it('keeps HTTP rejection distinct even for JWT-only default connections', async () => {
        jest.mocked(postWatchedLine).mockRejectedValue(new SaviDaemonHttpError(401, 'unauthorized'));
        await expect(watched(handler())).resolves.toEqual({ ok: false, reason: 'rejected' });
    });
});
