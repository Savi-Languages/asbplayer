import { storedAccount } from './account';
import { resolveCloudBase } from './cloud-client';
import { targetCloud } from './target-service';
const localModeKey = (base: string, account?: string) =>
    `saviLocalImmersionMode:${JSON.stringify([base, account ?? null])}`;
const validMode = (mode: unknown): mode is string =>
    typeof mode === 'string' && ['watch', 'explore', 'listen'].includes(mode);
type LocalMode = { mode: string; at: number };
const localModeRecord = (value: unknown): LocalMode | undefined => {
    if (validMode(value)) return { mode: value, at: 0 }; // pre-timestamp builds
    if (
        typeof value === 'object' &&
        value !== null &&
        validMode((value as LocalMode).mode) &&
        Number.isFinite((value as LocalMode).at)
    )
        return { mode: (value as LocalMode).mode, at: Math.max(0, (value as LocalMode).at) };
    return undefined;
};
const PREFIX = 'saviWatchInterest:';
const cacheKey = (base: string, user: string) => `saviWatchInterestPreference:${base}:${user}`;
const definitiveClientError = (error: unknown) => {
    const status = (error as { status?: unknown } | null)?.status;
    return status === 400 || status === 413 || status === 422;
};
export async function watchInterestConfig(url: string) {
    const account = await storedAccount();
    const base = resolveCloudBase(url);
    const localKey = localModeKey(base, account?.userId);
    const localMode = localModeRecord((await browser.storage.local.get(localKey))[localKey]);
    if (!account) return { account: undefined, enabled: false, mode: localMode?.mode ?? 'watch' };
    if (localMode) {
        // A local choice never waits on the network. Refresh consent separately;
        // selecting Explore is not consent to collect paused hovers.
        void refreshAccountConfig(url, account.userId).catch(() => {});
        const key = cacheKey(base, account.userId);
        const cached = (await browser.storage.local.get(key))[key] as { enabled?: boolean; at?: number } | undefined;
        return {
            account: account.userId,
            mode: localMode.mode,
            enabled: cached?.enabled === true && Date.now() - (cached.at ?? 0) < 86400000,
        };
    }
    return refreshAccountConfig(url, account.userId);
}
async function refreshAccountConfig(url: string, userId: string) {
    const base = resolveCloudBase(url);
    const key = cacheKey(base, userId);
    try {
        const cloud = await targetCloud(url);
        if (cloud.user !== userId) throw new Error('Account changed');
        const settings = (await cloud.request('/v2/settings')).settings;
        const cloudMode = ['watch', 'explore', 'listen'].includes(settings?.saviImmersionMode?.value)
            ? settings.saviImmersionMode.value
            : 'watch';
        const cloudModeAt = Number.isFinite(settings?.saviImmersionMode?.updatedAtMs)
            ? settings.saviImmersionMode.updatedAtMs
            : 0;
        const enabled = settings?.saviSavePausedHovers?.value === true;
        await cloud.check();
        if ((await storedAccount())?.userId !== userId) throw new Error('Account changed');
        const localKey = localModeKey(base, userId);
        const local = localModeRecord((await browser.storage.local.get(localKey))[localKey]);
        const localWins = local !== undefined && local.at >= cloudModeAt;
        const mode = localWins ? local.mode : cloudMode;
        const modeAt = localWins ? local.at : cloudModeAt;
        if (localWins && local.at > cloudModeAt) {
            await cloud.request('/v2/settings/saviImmersionMode', 'PUT', {
                value: local.mode,
                updatedAtMs: local.at,
            });
        } else if (!localWins) {
            await browser.storage.local.set({ [localKey]: { mode: cloudMode, at: cloudModeAt } });
        }
        await browser.storage.local.set({ [key]: { enabled, mode, modeAt, at: Date.now() } });
        return { account: cloud.user, enabled, mode };
    } catch {
        // Offline continuation is allowed only after explicit opt-in on this backend/account.
        const cached = (await browser.storage.local.get(key))[key] as
            | { enabled?: boolean; mode?: string; at: number }
            | undefined;
        const localKey = localModeKey(base, userId);
        const latest = localModeRecord((await browser.storage.local.get(localKey))[localKey]);
        return {
            account: userId,
            mode: latest?.mode ?? cached?.mode ?? 'watch',
            enabled: cached?.enabled === true && Date.now() - (cached?.at ?? 0) < 86400000,
        };
    }
}
export async function queueWatchInterest(url: string, account: string, item: any) {
    const config = await watchInterestConfig(url);
    if (
        (item?.kind === 'hover' && (!config.enabled || config.mode !== 'explore')) ||
        config.account !== account ||
        (await storedAccount())?.userId !== account
    )
        return { ok: false };
    if (
        !['hover', 'bookmark'].includes(item?.kind) ||
        (item.kind === 'hover' && item.dwellMs < 1500) ||
        typeof item.lineText !== 'string' ||
        item.lineText.length > 16000 ||
        !Number.isSafeInteger(item.lineStartMs) ||
        !Number.isSafeInteger(item.lineEndMs) ||
        item.textTiming === 'untimed' ||
        item.lineStartMs < 0 ||
        item.lineEndMs <= item.lineStartMs ||
        item.lineEndMs - item.lineStartMs > 120000 ||
        (item.textTiming !== undefined && !['timed', 'untimed'].includes(item.textTiming)) ||
        typeof item.episodeId !== 'string' ||
        typeof item.lang !== 'string' ||
        (item.screenshotDataUrl !== undefined &&
            (typeof item.screenshotDataUrl !== 'string' ||
                item.screenshotDataUrl.length > 240000 ||
                !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(item.screenshotDataUrl)))
    )
        return { ok: false };
    const base = resolveCloudBase(url);
    const key =
        PREFIX +
        JSON.stringify([
            base,
            account,
            item.lang,
            item.episodeId,
            item.lineStartMs,
            ...(item.textTiming === 'untimed' ? [item.lineText.trim()] : []),
        ]);
    if (!(await browser.storage.local.get(key))[key])
        await browser.storage.local.set({ [key]: { base, account, item } });
    void drainWatchInterest(url).catch(() => {});
    return { ok: true };
}
let draining: Promise<void> | undefined;
export function drainWatchInterest(url: string): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
        const cloud = await targetCloud(url);
        const base = resolveCloudBase(url);
        const entries = await browser.storage.local.get(null);
        const settings = (await cloud.request('/v2/settings')).settings;
        const enabled = settings?.saviSavePausedHovers?.value === true;
        for (const [key, raw] of Object.entries(entries)) {
            const row = raw as any;
            if (!key.startsWith(PREFIX) || row.account !== cloud.user || row.base !== base) continue;
            await cloud.check();
            if (row.retryAt && row.retryAt > Date.now() && enabled) continue;
            try {
                if (enabled || row.item.kind === 'bookmark') await cloud.request('/v2/watch-review', 'POST', row.item);
                await browser.storage.local.remove(key);
            } catch (error) {
                if (definitiveClientError(error)) {
                    // These are validation-shaped permanent failures: retrying
                    // the same immutable outbox row can never make it valid.
                    await browser.storage.local.remove(key);
                } else {
                    // Auth expiry, throttling, timeouts, server faults, and
                    // network uncertainty may all recover; keep the evidence.
                    await browser.storage.local.set({ [key]: { ...row, retryAt: Date.now() + 15 * 60000 } });
                }
            }
        }
    })().finally(() => {
        draining = undefined;
    });
    return draining;
}
export function bindWatchInterestDrain(url: () => Promise<string>) {
    const drain = () => {
        void url()
            .then(drainWatchInterest)
            .catch(() => {});
    };
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'savi-watch-interest') drain();
    });
    void browser.alarms.create('savi-watch-interest', { periodInMinutes: 1 });
    drain();
}

/** Explicit mode choices belong to this browser and account, including signed-out use. */
export async function setImmersionMode(url: string, mode: string) {
    if (!validMode(mode)) return { ok: false };
    const account = await storedAccount();
    const at = Date.now();
    const key = localModeKey(resolveCloudBase(url), account?.userId);
    await browser.storage.local.set({ [key]: { mode, at } });
    if (account) {
        void targetCloud(url)
            .then(async (cloud) => {
                if (cloud.user !== account.userId || (await storedAccount())?.userId !== account.userId) return;
                await cloud.request('/v2/settings/saviImmersionMode', 'PUT', { value: mode, updatedAtMs: at });
            })
            .catch(() => {});
    }
    return { ok: true, mode };
}
