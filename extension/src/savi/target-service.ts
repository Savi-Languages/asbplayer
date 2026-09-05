// Background-only cloud calls and an account-bound, per-event offline outbox.
import { currentAccessToken, storedAccount } from './account';
import { resolveCloudBase } from './cloud-client';
import { resolveTargetEpisode } from './episode-resolver';
import type { TargetEpisode, TargetFeedback, TargetPreparation, TargetWord } from './target-types';

const OUTBOX = 'saviTargetFeedback:';
export async function targetCloud(cloudUrl: string) {
    const token = await currentAccessToken();
    const account = await storedAccount();
    if (!token || !account || token !== account.accessToken) throw new Error('Sign in to prepare target words');
    const user = account.userId;
    const check = async () => {
        if ((await storedAccount())?.userId !== user) throw new Error('Account changed');
    };
    const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
        await check();
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 90000);
        try {
            const res = await fetch(`${resolveCloudBase(cloudUrl)}${path}`, {
                method,
                signal: abort.signal,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (!res.ok) throw new Error(`Target words unavailable (${res.status})`);
            const value = await res.json();
            await check();
            return value;
        } finally {
            clearTimeout(timer);
        }
    };
    return { user, check, request };
}
const validIdentity = (raw: any): raw is TargetEpisode =>
    raw?.mediaType === 'tv' &&
    Number.isSafeInteger(raw.tmdbId) &&
    raw.tmdbId > 0 &&
    Number.isInteger(raw.season) &&
    raw.season >= 0 &&
    Number.isInteger(raw.episode) &&
    raw.episode > 0;
const hash = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 48);

export async function prepareTargets(
    cloudUrl: string,
    message: { episodeId: string; title: string; show?: string; lang: string }
): Promise<TargetPreparation | null> {
    const cloud = await targetCloud(cloudUrl);
    const settings = (await cloud.request('/v2/settings')).settings ?? {};
    const source = `capture:${message.episodeId}`;
    // Player captureId uses the daemon's filesystem-safe form; accept both aliases.
    const safe = message.episodeId.replace(/[^a-zA-Z0-9._-]+/g, '_');
    let identity: TargetEpisode | null = null;
    for (const alias of [source, `capture:${!safe || /^\.+$/.test(safe) ? '_' : safe}`]) {
        const mapped = settings.mediaIdentity?.value?.[await hash(alias)];
        if (mapped?.schema === 1 && mapped.source === alias && validIdentity(mapped.identity)) {
            identity = mapped.identity;
            break;
        }
    }
    const cacheKey = `saviTargetIdentity:${await hash(JSON.stringify([cloud.user, message.episodeId]))}`;
    if (!identity) {
        const cached = (await browser.storage.session.get(cacheKey))[cacheKey] as
            | { account?: string; identity?: unknown }
            | undefined;
        if (cached?.account === cloud.user && validIdentity(cached.identity)) identity = cached.identity;
    }
    if (!identity) identity = await resolveTargetEpisode(cloud.request, message.show, message.title);
    if (!identity) return null;
    await cloud.check();
    await browser.storage.session.set({ [cacheKey]: { account: cloud.user, identity } });
    const before = await pendingFeedback(cloud.user);
    const result = await cloud.request(
        `/v2/episodes/${identity.tmdbId}/${identity.season}/${identity.episode}/targets?lang=${encodeURIComponent(message.lang)}`
    );
    const pending = [...before, ...(await pendingFeedback(cloud.user))];
    const hidden = new Set(
        pending
            .filter(
                (a) =>
                    a.lang === message.lang &&
                    (a.kind === 'target_dismissed_known' ||
                        (a.kind === 'target_dismissed_not_this' &&
                            a.source.startsWith(`episode:${identity!.tmdbId}:S`)))
            )
            .map((a) => a.lemma)
    );
    await cloud.check();
    return {
        account: cloud.user,
        identity,
        targets: (result.targets as TargetWord[]).filter((t) => !hidden.has(t.lemma)),
        cardEnabled: settings.saviTargetsCard?.value !== false,
        autoMineToAnki: settings.saviAutoMineToAnki?.value === true,
    };
}
async function pendingFeedback(account: string): Promise<TargetFeedback[]> {
    const stored = await browser.storage.local.get(null);
    return Object.entries(stored)
        .filter(
            ([key, value]) =>
                key.startsWith(OUTBOX) && (value as any)?.account === account && (value as any)?.action?.id
        )
        .map(([, value]) => (value as any).action);
}
let draining: Promise<void> | undefined;
export function drainTargetFeedback(cloudUrl: string): Promise<void> {
    if (draining) return draining;
    draining = (async () => {
        const cloud = await targetCloud(cloudUrl);
        const actions = (await pendingFeedback(cloud.user)).sort(
            (a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id)
        );
        for (const action of actions) {
            await cloud.request('/v2/events', 'POST', { actions: [action] });
            await browser.storage.local.remove(`${OUTBOX}${action.id}`);
        }
    })().finally(() => {
        draining = undefined;
    });
    return draining;
}
export async function queueTargetFeedback(cloudUrl: string, account: string, actions: TargetFeedback[]): Promise<void> {
    if ((await storedAccount())?.userId !== account) throw new Error('Account changed');
    if (
        actions.length > 15 ||
        actions.some(
            (a) => !['target_accepted', 'target_dismissed_known', 'target_dismissed_not_this'].includes(a.kind)
        )
    )
        throw new Error('Invalid target feedback');
    for (const action of actions) await browser.storage.local.set({ [`${OUTBOX}${action.id}`]: { account, action } });
    void drainTargetFeedback(cloudUrl).catch(() => {});
}
export function bindTargetFeedbackDrain(cloudUrl: () => Promise<string>): void {
    const drain = () => {
        void cloudUrl()
            .then(drainTargetFeedback)
            .catch(() => {});
    };
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'savi-target-feedback') drain();
    });
    void browser.alarms.create('savi-target-feedback', { periodInMinutes: 1 });
    drain();
}

const MINES = 'saviTargetMine:';
let mineWrites: Promise<void> = Promise.resolve();
export function queueTargetMines(account: string, mines: import('./target-types').HeardTargetMine[]): Promise<void> {
    const write = mineWrites
        .catch(() => {})
        .then(async () => {
            if ((await storedAccount())?.userId !== account || mines.length > 15) throw new Error('Account changed');
            for (const mine of mines) {
                if (mine.account !== account) throw new Error('Account mismatch');
                const key =
                    MINES +
                    (await hash(JSON.stringify([account, mine.lang, mine.episodeId, mine.lineStartMs, mine.lemma])));
                if ((await browser.storage.local.get(key))[key]) continue;
                await browser.storage.local.set({ [key]: { account, payload: mine } });
            }
        });
    mineWrites = write;
    return write;
}
let mining: Promise<void> | undefined;
export function drainTargetMines(
    getConfig: () => Promise<import('./daemon-client').SaviDaemonConfig | null>
): Promise<void> {
    if (mining) return mining;
    mining = (async () => {
        const account = (await storedAccount())?.userId;
        if (!account) return;
        const entries = Object.entries(await browser.storage.local.get(null)).filter(
            ([key, value]) => key.startsWith(MINES) && (value as any)?.account === account && !(value as any)?.done
        );
        for (const [key, raw] of entries) {
            const mine = (raw as any).payload as import('./target-types').HeardTargetMine;
            if (!mine || mine.account !== account) continue;
            if ((await storedAccount())?.userId !== account) return;
            const pending = await pendingFeedback(account);
            const dismissed = pending.some(
                (a) =>
                    a.lang === mine.lang &&
                    a.lemma === mine.lemma &&
                    (a.kind === 'target_dismissed_known' ||
                        (a.kind === 'target_dismissed_not_this' && a.source.startsWith(`episode:${mine.tmdb}:S`)))
            );
            if (!dismissed) {
                const config = await getConfig();
                if (!config) return;
                if ((await storedAccount())?.userId !== account) return;
                const { mineHeardTarget } = await import('./daemon-client');
                try {
                    const result = await mineHeardTarget(config, mine);
                    if (!result.ok || result.ankiPending) continue;
                } catch {
                    continue;
                } // Keep this job, but let independent lines progress.
            }
            // Keep only a small dedupe marker once delivered; discard line/frame data.
            await browser.storage.local.set({ [key]: { account, done: true } });
        }
    })().finally(() => {
        mining = undefined;
    });
    return mining;
}
