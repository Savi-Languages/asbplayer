import { currentAccessToken, daemonToken, signIn, signOut, storedAccount } from './account';

// account.ts talks to browser.storage.local + fetch (GoTrue REST); both are
// faked in-memory, following recording-intent.test.ts's browser-fake pattern.
describe('savi account', () => {
    let store: Record<string, unknown>;
    let fetchMock: jest.Mock;

    const nowSeconds = () => Math.floor(Date.now() / 1000);

    const grantResponse = (overrides: Record<string, unknown> = {}) => ({
        ok: true,
        status: 200,
        json: async () => ({
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            expires_at: nowSeconds() + 3600,
            user: { id: 'user-1', email: 'leon@example.com' },
            ...overrides,
        }),
    });

    const storedSession = (expiresInSeconds: number, suffix = '1') => ({
        accessToken: `access-${suffix}`,
        refreshToken: `refresh-${suffix}`,
        expiresAt: nowSeconds() + expiresInSeconds,
        userId: 'user-1',
        email: 'leon@example.com',
    });

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
                    remove: async (key: string) => {
                        delete store[key];
                    },
                },
            },
        };
    });

    afterEach(() => {
        delete (globalThis as any).browser;
        delete (globalThis as any).fetch;
    });

    it('sign-in stores the session and serves its access token', async () => {
        fetchMock.mockResolvedValueOnce(grantResponse());

        expect(await signIn('leon@example.com', 'pw')).toEqual({ ok: true });
        expect((await storedAccount())?.email).toBe('leon@example.com');
        expect(await currentAccessToken()).toBe('access-1');
        // Fresh token → no refresh call beyond the sign-in itself.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('grant_type=password');
    });

    it('sign-in surfaces the GoTrue error message and stores nothing', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ error_description: 'Invalid login credentials' }),
        });

        expect(await signIn('leon@example.com', 'nope')).toEqual({
            ok: false,
            errorMessage: 'Invalid login credentials',
        });
        expect(await storedAccount()).toBeUndefined();
    });

    it('refreshes a near-expiry session and stores the rotated tokens', async () => {
        store['saviAccount'] = storedSession(30); // inside the 120s read margin
        fetchMock.mockResolvedValueOnce(grantResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }));

        expect(await currentAccessToken()).toBe('access-2');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain('grant_type=refresh_token');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refresh_token: 'refresh-1' });
        // Rotated pair persisted, so the NEXT reader gets it without a refresh.
        expect((await storedAccount())?.refreshToken).toBe('refresh-2');
        expect(await currentAccessToken()).toBe('access-2');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('concurrent readers share one refresh (single-flight)', async () => {
        store['saviAccount'] = storedSession(30);
        let resolveJson: (v: unknown) => void = () => {};
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: () => new Promise((resolve) => (resolveJson = resolve)),
        });

        const first = currentAccessToken();
        const second = currentAccessToken();
        // Let both readers reach the in-flight refresh before it resolves.
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolveJson({
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            expires_at: nowSeconds() + 3600,
            user: { id: 'user-1', email: 'leon@example.com' },
        });

        expect(await first).toBe('access-2');
        expect(await second).toBe('access-2');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a denied refresh signs the account out', async () => {
        store['saviAccount'] = storedSession(30);
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            json: async () => ({ msg: 'Invalid Refresh Token' }),
        });

        expect(await currentAccessToken()).toBeUndefined();
        expect(await storedAccount()).toBeUndefined();
        // ...and daemon requests fall back to the LAN token.
        expect(await daemonToken(' lan-token ')).toBe('lan-token');
    });

    it('a transient refresh failure keeps serving the still-valid token', async () => {
        // Inside the refresh margin but not actually expired.
        store['saviAccount'] = storedSession(60);
        fetchMock.mockRejectedValueOnce(new Error('offline'));

        expect(await currentAccessToken()).toBe('access-1');
        expect(await storedAccount()).toBeDefined();

        // Actually expired + still offline → no usable token.
        store['saviAccount'] = storedSession(-10, '3');
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        expect(await currentAccessToken()).toBeUndefined();
    });

    it('daemonToken prefers the account token and falls back to the LAN token', async () => {
        expect(await daemonToken('lan-token')).toBe('lan-token');
        expect(await daemonToken('   ')).toBe('');

        store['saviAccount'] = storedSession(3600);
        expect(await daemonToken('lan-token')).toBe('access-1');
    });

    it('sign-out clears the session and best-effort revokes it', async () => {
        store['saviAccount'] = storedSession(3600);
        fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });

        await signOut();
        expect(await storedAccount()).toBeUndefined();
        expect(fetchMock.mock.calls[0][0]).toContain('/auth/v1/logout');
        // Sign-out with no session does nothing.
        fetchMock.mockClear();
        await signOut();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
