// Pick up the desktop app's account session over native messaging, so signing
// in once — in the app — signs you in here too.
//
// The app publishes its ACCESS token; the browser hands it to us because our
// extension id is named in the host manifest it installed. Two consequences
// worth stating, because they are the reason this design was chosen over the
// obvious alternatives:
//
//   - We never receive a refresh token. GoTrue rotates them, so refreshing the
//     app's lineage from here would sign one of us out at random. The app is
//     the only refresher; we just read whatever it last published.
//   - There is no socket involved. An endpoint on the daemon would have been
//     simpler, but the daemon's bearer is a static LAN token that the phone
//     player shares over the network — putting the account behind it would
//     make sniffing the LAN equivalent to taking the account.
//
// Sign-out in the app stops the publishing, so our access dies with the token.

/** Must match `HOST_NAME` in savi-daemon's native_host module. */
export const HOST_NAME = 'dev.leoncao.savi';

/** Refresh a little before expiry, so a call in flight doesn't straddle it. */
export const EXPIRY_SKEW_SECONDS = 60;

export interface NativeSession {
    readonly accessToken: string;
    /** Unix seconds. */
    readonly expiresAt: number;
    readonly email: string;
    readonly userId: string;
}

type HostResponse =
    | { kind: 'session'; accessToken: string; expiresAt: number; email: string; userId: string }
    | { kind: 'signedOut' }
    | { kind: 'error'; message: string };

/**
 * Is this session usable a moment from now?
 *
 * Exported for the caller's cache check as well as ours, so both sides agree
 * on what "expired" means and a token can't be judged live here and dead there.
 */
export const isUsable = (session: NativeSession | undefined, nowSeconds: number): boolean =>
    session !== undefined && session.accessToken.length > 0 && session.expiresAt > nowSeconds + EXPIRY_SKEW_SECONDS;

/**
 * Interpret the host's reply.
 *
 * Anything unexpected — an error, a malformed payload, a shape we don't know —
 * reads as "no session" rather than throwing. The extension's own sign-in is
 * always the fallback, so a broken handoff must degrade rather than break.
 */
export const parseHostResponse = (raw: unknown): NativeSession | undefined => {
    const response = raw as HostResponse | undefined;

    if (response === undefined || response === null || typeof response !== 'object') {
        return undefined;
    }

    if (response.kind !== 'session') {
        return undefined;
    }

    const { accessToken, expiresAt, email, userId } = response;

    if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof expiresAt !== 'number') {
        return undefined;
    }

    return {
        accessToken,
        expiresAt,
        email: typeof email === 'string' ? email : '',
        userId: typeof userId === 'string' ? userId : '',
    };
};

/**
 * Ask the desktop app for its current token.
 *
 * `undefined` covers every "can't have one" case identically: the app isn't
 * installed, the host manifest was never written, the browser refuses, the app
 * is signed out. The caller can't act differently on any of them, and treating
 * a missing desktop app as an error would make the common case — extension
 * without the app — look broken.
 */
export const requestNativeSession = async (): Promise<NativeSession | undefined> => {
    const runtime = (globalThis as any)?.chrome?.runtime ?? (globalThis as any)?.browser?.runtime;

    if (typeof runtime?.sendNativeMessage !== 'function') {
        return undefined;
    }

    try {
        const reply = await new Promise<unknown>((resolve, reject) => {
            runtime.sendNativeMessage(HOST_NAME, { kind: 'getSession' }, (response: unknown) => {
                const error = runtime.lastError;
                if (error) {
                    reject(new Error(error.message ?? 'native messaging failed'));
                    return;
                }
                resolve(response);
            });
        });

        return parseHostResponse(reply);
    } catch (e) {
        // "Specified native messaging host not found" is the ordinary state on
        // a machine without the desktop app — not worth surfacing as an error.
        return undefined;
    }
};
