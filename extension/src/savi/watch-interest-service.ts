import { storedAccount } from './account';
import { resolveCloudBase } from './cloud-client';
import { targetCloud } from './target-service';
const PREFIX = 'saviWatchInterest:';
const cacheKey = (base: string, user: string) => `saviWatchInterestPreference:${base}:${user}`;
export async function watchInterestConfig(url: string) {
    const account = await storedAccount();
    if (!account) return { enabled: false };
    const base = resolveCloudBase(url);
    const key = cacheKey(base, account.userId);
    try {
        const cloud = await targetCloud(url);
        const settings = (await cloud.request('/v2/settings')).settings;
        const enabled = settings?.saviSavePausedHovers?.value === true;
        await cloud.check();
        await browser.storage.local.set({ [key]: { enabled, at: Date.now() } });
        return { account: cloud.user, enabled };
    } catch {
        // Offline continuation is allowed only after explicit opt-in on this backend/account.
        const cached = (await browser.storage.local.get(key))[key] as { enabled?: boolean; at: number } | undefined;
        return {
            account: account.userId,
            enabled: cached?.enabled === true && Date.now() - (cached?.at ?? 0) < 86400000,
        };
    }
}
export async function queueWatchInterest(url: string, account: string, item: any) {
    const config = await watchInterestConfig(url);
    if (!config.enabled || config.account !== account || (await storedAccount())?.userId !== account)
        return { ok: false };
    if (
        item?.kind !== 'hover' ||
        item.dwellMs < 1500 ||
        typeof item.lineText !== 'string' ||
        item.lineText.length > 16000 ||
        !Number.isSafeInteger(item.lineStartMs) ||
        !Number.isSafeInteger(item.lineEndMs) ||
        item.lineEndMs <= item.lineStartMs ||
        typeof item.episodeId !== 'string' ||
        typeof item.lang !== 'string'
    )
        return { ok: false };
    const base = resolveCloudBase(url);
    const key = PREFIX + JSON.stringify([base, account, item.lang, item.episodeId, item.lineStartMs]);
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
                if (enabled) await cloud.request('/v2/watch-review', 'POST', row.item);
                await browser.storage.local.remove(key);
            } catch {
                // Retain uncertain or unavailable assessments, with a bounded retry rate.
                await browser.storage.local.set({ [key]: { ...row, retryAt: Date.now() + 15 * 60000 } });
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
