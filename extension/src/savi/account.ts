// The savi ACCOUNT session (Supabase Auth) — unified auth's replacement for
// the copy-pasted daemon LAN token. The user signs in once (options page /
// popup) and every daemon request carries the account's JWT; the daemon
// accepts it because the desktop app pinned this account as the machine's
// owner (savi `POST /v2/auth/trust`).
//
// Deliberately NOT @supabase/supabase-js: we need exactly three GoTrue REST
// calls (password grant, refresh grant, logout), storage must be
// extension-wide (`browser.storage.local`, readable from the background
// worker, the offscreen document, content scripts, and the options page —
// supabase-js wants a per-context localStorage), and its timer-based
// auto-refresh dies with the MV3 service worker anyway. Refresh here is
// on-demand (any reader refreshes a stale session, single-flight per context)
// plus a background `browser.alarms` heartbeat so the common case never even
// hits the stale path.
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

/** The signed-in account's access token, refreshed if it is about to expire.
 *  `undefined` when signed out or the session could not be kept alive. */
export const currentAccessToken = (): Promise<string | undefined> => accessTokenWithMargin(readMarginSeconds);

/** The bearer for a daemon request: the account's JWT when signed in, else the
 *  legacy LAN token from settings (the transition fallback — may be ''). Call
 *  this per REQUEST, not per session: JWTs expire ~hourly and a capture can
 *  outlive several of them. */
export const daemonToken = async (lanToken: string): Promise<string> => (await currentAccessToken()) ?? lanToken.trim();

/** Background-worker heartbeat: keep the session fresh so on-demand readers
 *  (chunk uploads, hover lookups) virtually never block on a refresh. Call at
 *  the service worker's top level — `alarms.create` with an existing name is a
 *  no-op, and MV3 requires the listener re-registered on every worker wake. */
export const bindSaviAccountRefresh = (): void => {
    void browser.alarms.create(alarmName, { periodInMinutes: alarmPeriodMinutes });
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === alarmName) {
            void accessTokenWithMargin(alarmMarginSeconds);
        }
    });
};
