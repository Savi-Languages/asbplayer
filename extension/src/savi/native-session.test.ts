import { EXPIRY_SKEW_SECONDS, isUsable, parseHostResponse, requestNativeSession } from './native-session';

const session = (over: Partial<Record<string, unknown>> = {}) => ({
    kind: 'session',
    accessToken: 'jwt-abc',
    expiresAt: 2_000,
    email: 'me@example.com',
    userId: 'u1',
    ...over,
});

describe('parseHostResponse', () => {
    it('reads a session the host published', () => {
        expect(parseHostResponse(session())).toEqual({
            accessToken: 'jwt-abc',
            expiresAt: 2_000,
            email: 'me@example.com',
            userId: 'u1',
        });
    });

    it('treats signed-out as simply no session', () => {
        expect(parseHostResponse({ kind: 'signedOut' })).toBeUndefined();
    });

    it('treats a host error as no session rather than throwing', () => {
        // The extension's own sign-in is the fallback; a broken handoff must
        // degrade quietly, never break the caller.
        expect(parseHostResponse({ kind: 'error', message: 'unknown request kind' })).toBeUndefined();
    });

    it('rejects a malformed payload instead of trusting it', () => {
        expect(parseHostResponse(undefined)).toBeUndefined();
        expect(parseHostResponse(null)).toBeUndefined();
        expect(parseHostResponse('nope')).toBeUndefined();
        expect(parseHostResponse({})).toBeUndefined();
        expect(parseHostResponse(session({ accessToken: '' }))).toBeUndefined();
        expect(parseHostResponse(session({ accessToken: 123 }))).toBeUndefined();
        expect(parseHostResponse(session({ expiresAt: 'soon' }))).toBeUndefined();
    });

    it('tolerates missing optional identity fields', () => {
        const parsed = parseHostResponse({ kind: 'session', accessToken: 'jwt', expiresAt: 10 });
        expect(parsed).toEqual({ accessToken: 'jwt', expiresAt: 10, email: '', userId: '' });
    });

    it('never surfaces a refresh token even if one appeared in the payload', () => {
        // The design guarantees the app publishes only an access token. If that
        // ever changed, nothing here would carry it into extension storage.
        const parsed = parseHostResponse(session({ refreshToken: 'should-be-ignored' })) as any;
        expect(parsed.refreshToken).toBeUndefined();
        expect(Object.keys(parsed).sort()).toEqual(['accessToken', 'email', 'expiresAt', 'userId']);
    });
});

describe('isUsable', () => {
    it('accepts a token with room to spare', () => {
        expect(isUsable({ accessToken: 'j', expiresAt: 1_000, email: '', userId: '' }, 0)).toBe(true);
    });

    it('rejects one inside the expiry skew, so a call in flight cannot straddle expiry', () => {
        const nearly = { accessToken: 'j', expiresAt: 1_000, email: '', userId: '' };
        expect(isUsable(nearly, 1_000 - EXPIRY_SKEW_SECONDS)).toBe(false);
        expect(isUsable(nearly, 1_000 - EXPIRY_SKEW_SECONDS - 1)).toBe(true);
    });

    it('rejects expired, empty and absent sessions', () => {
        expect(isUsable({ accessToken: 'j', expiresAt: 10, email: '', userId: '' }, 1_000)).toBe(false);
        expect(isUsable({ accessToken: '', expiresAt: 9_999, email: '', userId: '' }, 0)).toBe(false);
        expect(isUsable(undefined, 0)).toBe(false);
    });
});

describe('requestNativeSession', () => {
    const withRuntime = (runtime: unknown) => {
        (globalThis as any).chrome = runtime === undefined ? undefined : { runtime };
    };

    afterEach(() => {
        delete (globalThis as any).chrome;
    });

    it('returns undefined when the browser has no native messaging', async () => {
        withRuntime(undefined);
        await expect(requestNativeSession()).resolves.toBeUndefined();
        withRuntime({});
        await expect(requestNativeSession()).resolves.toBeUndefined();
    });

    it('asks the host for a session and returns it', async () => {
        const sendNativeMessage = jest.fn((_host: string, _msg: unknown, cb: (r: unknown) => void) => cb(session()));
        withRuntime({ sendNativeMessage, lastError: undefined });

        await expect(requestNativeSession()).resolves.toEqual({
            accessToken: 'jwt-abc',
            expiresAt: 2_000,
            email: 'me@example.com',
            userId: 'u1',
        });
        expect(sendNativeMessage).toHaveBeenCalledWith(
            'dev.leoncao.savi',
            { kind: 'getSession' },
            expect.any(Function)
        );
    });

    it('returns undefined when the host is not installed', async () => {
        // The ordinary state on a machine with no desktop app — must not look
        // like a failure.
        const runtime: any = {
            sendNativeMessage: (_h: string, _m: unknown, cb: (r: unknown) => void) => {
                runtime.lastError = { message: 'Specified native messaging host not found.' };
                cb(undefined);
            },
        };
        withRuntime(runtime);
        await expect(requestNativeSession()).resolves.toBeUndefined();
    });

    it('returns undefined when the app is signed out', async () => {
        withRuntime({
            sendNativeMessage: (_h: string, _m: unknown, cb: (r: unknown) => void) => cb({ kind: 'signedOut' }),
            lastError: undefined,
        });
        await expect(requestNativeSession()).resolves.toBeUndefined();
    });

    it('survives a host that throws synchronously', async () => {
        withRuntime({
            sendNativeMessage: () => {
                throw new Error('boom');
            },
        });
        await expect(requestNativeSession()).resolves.toBeUndefined();
    });
});
