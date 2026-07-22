// The background's record of the ONE in-flight capture session (SV-18: the
// daemon records audio, so the extension's only session state is bookkeeping).
// Lives in storage.session so it survives MV3 service-worker restarts —
// in-memory state does not — and dies with the browser session, like a capture
// should. Written only by the background service worker.
//
// One session at a time, mirroring the daemon's one-tap-per-system rule.
// Replaces the old per-tab recording-intent marker: intent existed solely
// because the tabCapture user gesture was lost on reload, and that constraint
// left with tab capture.

/** The daemon's audio report for the session (capture/start response). */
export interface SaviCaptureAudio {
    readonly state: 'recording' | 'disabled' | 'unavailable' | 'legacy' | 'off' | 'idle';
    readonly reason?: string;
    readonly sourceApp?: string;
}

export interface CaptureSessionRecord {
    readonly tabId: number;
    readonly src: string;
    readonly captureId: string;
    readonly episodeId: string;
    readonly title?: string;
    /** Last playback-state batch number sent — monotonic per capture. */
    readonly seq: number;
    readonly audio: SaviCaptureAudio;
}

const KEY = 'saviCaptureSession';

export const getCaptureSession = async (): Promise<CaptureSessionRecord | undefined> => {
    const result = await browser.storage.session.get(KEY);
    return (result?.[KEY] as CaptureSessionRecord) ?? undefined;
};

export const setCaptureSession = async (record: CaptureSessionRecord): Promise<void> => {
    await browser.storage.session.set({ [KEY]: record });
};

export const clearCaptureSession = async (): Promise<void> => {
    await browser.storage.session.remove(KEY);
};

/** Allocate the next playback-state seq for the session, persisting it BEFORE
 *  it is used so a service-worker restart can never reuse a seq (the daemon
 *  drops replays). Returns undefined when no session is live. */
export const nextPlaybackSeq = async (): Promise<{ session: CaptureSessionRecord; seq: number } | undefined> => {
    const session = await getCaptureSession();
    if (session === undefined) {
        return undefined;
    }
    const seq = session.seq + 1;
    const updated = { ...session, seq };
    await setCaptureSession(updated);
    return { session: updated, seq };
};
