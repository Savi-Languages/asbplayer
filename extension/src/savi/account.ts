// The savi ACCOUNT session (Supabase Auth). The user signs in once (options
// page / popup) and daemon requests carry the credential split: the LAN token
// as the Authorization bearer (capability — may this browser talk to this
// daemon) and the account's JWT in `X-Savi-Account` (identity — which cloud
// account owns the request). The daemon verifies the identity against the
// account the desktop app pinned as the machine's owner (savi
// `POST /v2/auth/trust`); a wrong account degrades AI with a typed reason
// instead of 401-ing every local endpoint.
//
// Deliberately NOT @supabase/supabase-js: we need exactly three GoTrue REST
// calls (password grant, refresh grant, logout), storage must be
// extension-wide (`browser.storage.local`, readable from the background
// worker, content scripts, and the options page — supabase-js wants a
// per-context localStorage), and its timer-based auto-refresh dies with the
// MV3 service worker anyway. Refresh here is on-demand (any reader refreshes
// a stale session, single-flight per context) plus a background
// `browser.alarms` heartbeat so the common case never even hits the stale path.
//
// The OFFSCREEN DOCUMENT is the exception: Chrome gives it no extension APIs
// beyond `chrome.runtime` messaging — `browser.storage` is undefined there —
// so it must use `remoteDaemonCredentials` (asks the background) instead of
// `daemonCredentials`.
//
// The Supabase URL + publishable key are public client config (like a
// Firebase web config) — the same values savi commits in apps/.env.

const SUPABASE_URL = 'https://rggkecrujhncogumixdf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ew-eAEZCJBd3MCZaPHCXxA_l45-GCcG';

const storageKey = 'saviAccount';
// On-demand readers refresh when this close to expiry (absorbs clock skew and
// the request's own flight time).
const readMarginSeconds = 120;
// The background alarm refreshes further ahead, so with hour-long tokens and a
// 20-minute alarm cadence the session stays perpetually fresh.
const alarmMarginSeconds = 25 * 60;
const alarmName = 'savi-account-refresh';
const alarmPeriodMinutes = 20;

export interface SaviAccount {
    readonly accessToken: string;
    readonly refreshToken: string;
    /** Unix seconds at which accessToken expires. */
    readonly expiresAt: number;
    readonly userId: string;
    readonly email: string;
}

export type SaviSignInResult = { ok: true } | { ok: false; errorMessage: string };

/** A GoTrue HTTP error. `denied` = the server rejected the credentials or
 *  refresh token (4xx) as opposed to a transport failure. */
class AuthRequestError extends Error {
    constructor(
        message: string,
        readonly denied: boolean
    ) {
        super(message);
    }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const tokenRequest = async (
    grantType: 'password' | 'refresh_token',
    body: Record<string, string>
): Promise<SaviAccount> => {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json: any = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = json?.error_description ?? json?.msg ?? json?.error ?? `HTTP ${response.status}`;
        throw new AuthRequestError(String(message), response.status >= 400 && response.status < 500);
    }

    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: json.expires_at ?? nowSeconds() + (json.expires_in ?? 3600),
        userId: json.user?.id ?? '',
        email: json.user?.email ?? '',
    };
};

export const storedAccount = async (): Promise<SaviAccount | undefined> => {
    const result = await browser.storage.local.get(storageKey);
    return (result?.[storageKey] as SaviAccount | undefined) ?? undefined;
};

export const signIn = async (email: string, password: string): Promise<SaviSignInResult> => {
    try {
        const account = await tokenRequest('password', { email, password });
        await browser.storage.local.set({ [storageKey]: account });
        return { ok: true };
    } catch (e) {
        return { ok: false, errorMessage: e instanceof Error ? e.message : String(e) };
    }
};

export const signOut = async (): Promise<void> => {
    const account = await storedAccount();
    await browser.storage.local.remove(storageKey);

    if (account !== undefined) {
        // Best-effort server-side revocation; the local sign-out already happened.
        await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${account.accessToken}` },
        }).catch(() => {});
    }
};

// Refreshes are single-flight per extension context; cross-context races are
// absorbed by GoTrue's refresh-token reuse window.
let refreshInFlight: Promise<string | undefined> | undefined;

const refresh = async (account: SaviAccount): Promise<string | undefined> => {
    try {
        const refreshed = await tokenRequest('refresh_token', { refresh_token: account.refreshToken });
        await browser.storage.local.set({ [storageKey]: refreshed });
        return refreshed.accessToken;
    } catch (e) {
        if (e instanceof AuthRequestError && e.denied) {
            // The refresh token was revoked/expired — the session is dead.
            // Clear it so the UI reads signed-out instead of failing forever.
            await browser.storage.local.remove(storageKey);
            return undefined;
        }
        // Transient failure (offline, Supabase down): keep the session and
        // serve the stored token for as long as it is actually valid.
        return account.expiresAt > nowSeconds() ? account.accessToken : undefined;
    }
};

const accessTokenWithMargin = async (marginSeconds: number): Promise<string | undefined> => {
    const account = await storedAccount();

    if (account === undefined) {
        return undefined;
    }

    if (account.expiresAt - nowSeconds() > marginSeconds) {
        return account.accessToken;
    }

    if (refreshInFlight === undefined) {
        refreshInFlight = refresh(account).finally(() => {
            refreshInFlight = undefined;
        });
    }

    return await refreshInFlight;
};

// ── Resolution observer ──────────────────────────────────────────────────
// The session moves without anyone signing in or out. `signIn`/`signOut` are
// the loud transitions; the quiet ones are the common ones:
//
//   - the `browser.alarms` heartbeat refreshes ahead of expiry, on its own
//     timer, in the background — no UI involved
//   - a denied refresh CLEARS the session right here in `refresh()`, so the
//     account goes from signed-in to signed-out with no `signOut()` call
//   - a transient failure serves the stored token until it lapses, then stops
//   - the browser was closed over the token's whole lifetime and the first
//     resolution after waking has to refresh before it can answer
//
// Anything hung off the ceremony misses all of that. So expose the STATE
// instead, at the one place every reader already funnels through: cloud calls
// take their bearer from here and daemon calls take their `X-Savi-Account`
// identity from here (via `daemonCredentials`), so the transition is observable
// with no new polling — and stays observable while glossing is dead, exactly
// when a gloss-driven trigger would go quiet. credential-watch.ts is the
// observer; see it for what happens on a rising edge.
//
// The credential split moved the JWT off the daemon Authorization header, but
// left it sourced from this function, so the signal is unchanged by it.
//
// One observer, not a list: there is exactly one interested party (the
// background), and a list would invite content scripts to register handlers
// that fire per-frame.

type TokenResolutionObserver = (hasAccountToken: boolean) => void;

let resolutionObserver: TokenResolutionObserver | undefined;

/** Watch every account-token resolution in THIS context. Registering in the
 *  background is what turns a session coming back into a re-arm; other contexts
 *  leave it unset and resolution stays a plain read. */
export const observeTokenResolution = (observer: TokenResolutionObserver | undefined): void => {
    resolutionObserver = observer;
};

/** The signed-in account's access token, refreshed if it is about to expire.
 *  `undefined` when signed out or the session could not be kept alive. */
export const currentAccessToken = async (): Promise<string | undefined> => {
    const token = await accessTokenWithMargin(readMarginSeconds);

    // Never let a broken observer take down a request that already resolved
    // its token — the token is the caller's whole reason for being here.
    try {
        resolutionObserver?.(token !== undefined);
    } catch (e) {
        console.warn('savi: token resolution observer failed', e);
    }

    return token;
};

/** The two credentials a daemon request carries — the credential split.
 *  `bearer` is capability (the LAN token from settings), `accountJwt` is
 *  identity (sent separately as `X-Savi-Account`). Keeping them apart is the
 *  point: a wrong-account identity costs AI only, where the old JWT-as-bearer
 *  scheme turned it into a 401 on every local endpoint.
 *
 *  With no LAN token configured the JWT doubles as the bearer — the daemon
 *  accepts the pinned owner's JWT as Authorization (the desktop webview's
 *  shape), so a signed-in extension works before any token is copied over.
 *  `bearer` may still be '' (signed out AND no LAN token) — callers gate on it.
 *
 *  Resolve per REQUEST, not per session: JWTs expire ~hourly and a capture can
 *  outlive several of them. */
export interface SaviDaemonCredentials {
    readonly bearer: string;
    readonly accountJwt?: string;
}

export const daemonCredentials = async (lanToken: string): Promise<SaviDaemonCredentials> => {
    const accountJwt = await currentAccessToken();
    const lan = lanToken.trim();
    return { bearer: lan.length > 0 ? lan : (accountJwt ?? ''), accountJwt };
};

// ── Offscreen-document access ────────────────────────────────────────────
// Offscreen documents have NO `browser.storage` (Chrome exposes only
// `chrome.runtime` messaging there), so they can't call `daemonCredentials`
// directly — chunk uploads crashed on `undefined.local`. Instead the
// background answers a token request over runtime messaging.

const currentTokenCommand = 'savi-current-account-token';

/** Background-side responder for `remoteDaemonCredentials`. Registered by
 *  `bindSaviAccountRefresh` on every worker wake. Ignores (returns undefined
 *  for) every other message so coexisting listeners are unaffected. */
const bindTokenServer = (): void => {
    browser.runtime.onMessage.addListener(
        (message: any, _sender: unknown, sendResponse: (response: unknown) => void) => {
            if (message?.command !== currentTokenCommand) {
                return undefined;
            }
            currentAccessToken().then(
                (accessToken) => sendResponse({ accessToken }),
                () => sendResponse({ accessToken: undefined })
            );
            return true; // async sendResponse
        }
    );
};

/** `daemonCredentials` for storage-less contexts (the offscreen document):
 *  asks the background for the current account token. Call per REQUEST, like
 *  `daemonCredentials`. */
export const remoteDaemonCredentials = async (lanToken: string): Promise<SaviDaemonCredentials> => {
    const lan = lanToken.trim();
    try {
        const response: any = await browser.runtime.sendMessage({ command: currentTokenCommand });
        const accountJwt = (response?.accessToken as string | undefined) ?? undefined;
        return { bearer: lan.length > 0 ? lan : (accountJwt ?? ''), accountJwt };
    } catch (e) {
        // No listener / worker unreachable — the LAN token still works.
        return { bearer: lan };
    }
};

/** Background-worker heartbeat: keep the session fresh so on-demand readers
 *  (chunk uploads, hover lookups) virtually never block on a refresh, plus the
 *  token server the offscreen document depends on. Call at the service
 *  worker's top level — `alarms.create` with an existing name is a no-op, and
 *  MV3 requires listeners re-registered on every worker wake. */
export const bindSaviAccountRefresh = (): void => {
    void browser.alarms.create(alarmName, { periodInMinutes: alarmPeriodMinutes });
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === alarmName) {
            void accessTokenWithMargin(alarmMarginSeconds);
        }
    });
    bindTokenServer();
};
