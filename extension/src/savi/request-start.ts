// Dispatch a "start capture" request and tell the user when nothing took it.
//
// `savi-request-start` is broadcast to a whole tab — `tabs.sendMessage(tabId, …)`
// with no `frameId` reaches every frame — and the capture controller in each
// frame answers only if IT has a subtitle track loaded. That gate is deliberate
// and load-bearing: it is how one keypress picks the right player on a page with
// several videos (embeds, ad iframes) instead of every binding toggling at once.
//
// The gap it leaves is silence. When NO frame qualifies, nobody responds and
// nobody says anything, so the shortcut looks broken — press it on a video whose
// subtitles have not loaded and there is no capture, no error, no toast.
//
// The fix keeps the gate exactly as-is and uses the answer the background
// already receives: `tabs.sendMessage` resolves with the FIRST frame to respond,
// and non-qualifying frames deliberately stay silent, so "no response" means
// "no frame could take it". Only then do we show a notice — and we send it to
// `frameId: 0` alone, because broadcasting it would stack one toast per frame.

/** Shown when a start request reaches no frame that can act on it. */
export const NO_CAPTURE_TARGET_NOTICE = 'Savi: no subtitle track loaded to capture';

/** The reply a capture controller sends when it takes the request. */
export interface RequestStartResponse {
    readonly requested?: boolean;
}

export interface RequestStartDeps {
    /** Broadcast to every frame in the tab. Resolves with the first response,
     *  `undefined` when none answers; rejects when no receiver exists at all. */
    sendToTab: (tabId: number) => Promise<RequestStartResponse | undefined>;
    /** Deliver a notice to the top frame only. */
    notifyTopFrame: (tabId: number, text: string) => Promise<unknown>;
}

/**
 * Ask a tab to start capturing. Resolves `true` when a frame took the request.
 *
 * When none did, shows [`NO_CAPTURE_TARGET_NOTICE`] on the top frame and
 * resolves `false`. Never throws: a failed dispatch (no content script on the
 * page — a settings tab, the Web Store) is an ordinary miss, and a failed notice
 * must not mask the result.
 */
export async function requestStartWithFeedback(tabId: number, deps: RequestStartDeps): Promise<boolean> {
    let response: RequestStartResponse | undefined;

    try {
        response = await deps.sendToTab(tabId);
    } catch (e) {
        response = undefined;
    }

    if (response?.requested === true) {
        return true;
    }

    try {
        await deps.notifyTopFrame(tabId, NO_CAPTURE_TARGET_NOTICE);
    } catch (e) {
        // A page with no content script cannot show a toast either. Nothing to
        // report and nothing the user could act on.
    }

    return false;
}
