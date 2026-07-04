// Per-tab "this tab was recording" intent, persisted in storage.session so it
// survives a content-script reload — which is exactly when we need it. Written
// ONLY by the background service worker (it alone knows the requesting tab's id
// and decides when a start truly succeeded). Mirrors the per-tab-session-state
// pattern in services/active-tab-permission-request.ts.
//
// Keyed per tab (several tabs can record at once). The marker is set when a
// capture start succeeds, persists across reloads / SPA next-episode / video-end
// (the tabId is stable), and is cleared only on a deliberate stop or tab close.
// storage.session is content-readable because background.ts sets
// setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS'), but we still route reads
// through the background so the single writer owns the truth.

const keyFor = (tabId: number) => `saviRecordingIntent:${tabId}`;

/** Mark the tab as "was recording" — call when a capture start succeeds. */
export const setRecordingIntent = async (tabId: number): Promise<void> => {
    await browser.storage.session.set({ [keyFor(tabId)]: true });
};

/** Clear the marker — call on a deliberate stop or when the tab is removed. */
export const clearRecordingIntent = async (tabId: number): Promise<void> => {
    await browser.storage.session.remove(keyFor(tabId));
};

/** Whether the tab has a live recording-intent marker. Guards against a reused
 *  tabId (a tab close we somehow missed) by confirming the tab still exists. */
export const hasRecordingIntent = async (tabId: number | undefined): Promise<boolean> => {
    if (tabId === undefined) {
        return false;
    }
    const key = keyFor(tabId);
    const result = await browser.storage.session.get(key);
    if (result?.[key] !== true) {
        return false;
    }
    try {
        await browser.tabs.get(tabId);
        return true;
    } catch {
        await browser.storage.session.remove(key);
        return false;
    }
};
