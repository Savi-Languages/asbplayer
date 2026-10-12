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
    /** Browser-supplied owner identity; optional for older sessions/browsers. */
    readonly documentId?: string;
    readonly frameId?: number;
    readonly generation?: string;
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

// Serialize read-modify-write operations so a late sequence allocation cannot
// resurrect a cleared session. Conditional clears cannot delete a newer take.
let mutationChain: Promise<unknown> = Promise.resolve();
const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = mutationChain.then(operation);
    mutationChain = run.catch(() => {});
    return run;
};
export const setCaptureSession = (record: CaptureSessionRecord): Promise<void> =>
    mutate(() => browser.storage.session.set({ [KEY]: record }));

export const clearCaptureSession = (expected?: CaptureSessionRecord): Promise<boolean> =>
    mutate(async () => {
        if (expected) {
            const current = await getCaptureSession();
            if (
                !current ||
                current.generation !== expected.generation ||
                current.captureId !== expected.captureId ||
                current.tabId !== expected.tabId ||
                current.documentId !== expected.documentId
            )
                return false;
        }
        await browser.storage.session.remove(KEY);
        return true;
    });

/** Allocate only for the current owner, atomically with respect to clears. */
export const nextPlaybackSeq = (
    owns: (session: CaptureSessionRecord) => boolean = () => true
): Promise<{ session: CaptureSessionRecord; seq: number } | undefined> =>
    mutate(async () => {
        const session = await getCaptureSession();
        if (session === undefined || !owns(session)) return undefined;
        const seq = session.seq + 1;
        const updated = { ...session, seq };
        await browser.storage.session.set({ [KEY]: updated });
        return { session: updated, seq };
    });
