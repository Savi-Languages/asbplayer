// Episodes the user has muted by hand — savi's escape hatch when automatic
// language detection has nothing to go on.
//
// The gate (language-gate.ts) fails open: no signal means savi runs. That is
// the right default, because a savi that goes quiet by accident loses exposure
// invisibly. But it leaves the case where the user KNOWS this video is not in
// their learning language and the page cannot tell us. One click writes the
// episode here and the gate deactivates for it, permanently and only for it.
//
// Keyed by `deriveEpisodeId` (episode.ts) — `youtube:<id>`, `netflix:<id>`, or
// `host:slug` — so it reuses savi's existing notion of "which video is this"
// rather than inventing a second one.
//
// Bounded MRU: the list is expected to stay small (with YouTube auto-detected
// it should be reached for rarely), but an unbounded list written from a
// content script is a leak waiting to happen.

// `browser` is the ambient extension global (as in cloud-settings.ts) rather
// than a wxt/browser import: this module is reached from the content script and
// the tests stub the global directly.

const KEY = 'saviMutedEpisodes';
const MAX_MUTED = 500;

/** In-process mirror so the gate's hot path doesn't hit storage per video. */
let memo: string[] | undefined;

const read = async (): Promise<string[]> => {
    if (memo !== undefined) return memo;
    try {
        const stored = await browser.storage.local.get(KEY);
        const list = (stored as Record<string, unknown>)[KEY];
        memo = Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : [];
    } catch {
        // Storage unavailable → behave as "nothing muted", which fails open.
        memo = [];
    }
    return memo;
};

const write = async (list: string[]): Promise<void> => {
    memo = list;
    try {
        await browser.storage.local.set({ [KEY]: list });
    } catch {
        // Keep the in-process value: the mute still holds for this session.
    }
};

/** The muted set, for handing to `decideLanguageGate`. */
export const mutedEpisodes = async (): Promise<string[]> => [...(await read())];

export const isEpisodeMuted = async (episodeId: string): Promise<boolean> =>
    (await read()).includes(episodeId);

/** Mute an episode. Most-recent last; oldest dropped past MAX_MUTED. */
export const muteEpisode = async (episodeId: string): Promise<void> => {
    const list = (await read()).filter((e) => e !== episodeId);
    list.push(episodeId);
    await write(list.slice(-MAX_MUTED));
};

export const unmuteEpisode = async (episodeId: string): Promise<void> => {
    await write((await read()).filter((e) => e !== episodeId));
};

/** Test seam — drops the in-process mirror so the next read hits storage. */
export const resetMutedEpisodesMemo = (): void => {
    memo = undefined;
};
