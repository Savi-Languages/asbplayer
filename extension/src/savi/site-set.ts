// A bounded, most-recently-used set of site keys in `browser.storage.local`.
//
// Two lists share this shape and neither is worth its own copy of it:
//
//  - `muted-sites.ts` — "never run savi here at all" (the language gate obeys it);
//  - `hush-dismissed.ts` — "stop OFFERING to switch savi off here" (the prompt).
//
// They are deliberately separate sets: dismissing the prompt is the opposite
// decision from acting on it, and conflating them would make the ✕ a mute.
//
// Bounded MRU because these are written from a content script, where an
// unbounded list is a leak waiting to happen (same reason as the episode list).
// Every operation fails OPEN — storage being unavailable degrades to "nothing
// recorded", matching the language gate's posture everywhere else, and the
// in-process value still holds for the rest of the session.

export interface SiteSet {
    /** Every recorded site, oldest first. */
    all(): Promise<string[]>;
    has(siteKey: string): Promise<boolean>;
    /** Record a site. Most-recent last; oldest dropped past the cap. */
    add(siteKey: string): Promise<void>;
    remove(siteKey: string): Promise<void>;
    /** Overwrite the whole list — the cloud mirror's write. */
    replace(siteKeys: string[]): Promise<void>;
    /** Test/refresh seam: drop the in-process mirror so the next read hits
     *  storage. The options page and the content script are different
     *  contexts, so a page left open would otherwise show a stale list. */
    resetMemo(): void;
}

export const siteSet = (storageKey: string, max: number): SiteSet => {
    // In-process mirror so the gate's hot path doesn't hit storage per video.
    let memo: string[] | undefined;

    const read = async (): Promise<string[]> => {
        if (memo !== undefined) {
            return memo;
        }
        try {
            const stored = await browser.storage.local.get(storageKey);
            const list = (stored as Record<string, unknown>)[storageKey];
            memo = Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : [];
        } catch {
            memo = [];
        }
        return memo;
    };

    const write = async (list: string[]): Promise<void> => {
        const capped = list.slice(-max);
        memo = capped;
        try {
            await browser.storage.local.set({ [storageKey]: capped });
        } catch {
            // Keep the in-process value: the decision still holds this session.
        }
    };

    return {
        all: async () => [...(await read())],
        has: async (siteKey) => (await read()).includes(siteKey),
        add: async (siteKey) => {
            const list = (await read()).filter((e) => e !== siteKey);
            list.push(siteKey);
            await write(list);
        },
        remove: async (siteKey) => write((await read()).filter((e) => e !== siteKey)),
        replace: (siteKeys) => write(siteKeys.filter((e) => typeof e === 'string')),
        resetMemo: () => {
            memo = undefined;
        },
    };
};
