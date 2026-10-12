// The background's record of the ONE in-flight capture session (SV-18: the
// daemon records audio, so the extension's only session state is bookkeeping).
// Lives in storage.session so it survives MV3 service-worker restarts —
// in-memory state does not — and dies with the browser session, like a capture
// should. The sequence cursor alone is durable across browser/extension
// reloads. A different profile learns the daemon cursor through lastSeq.
// Written only by the background service worker.
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
    /** Last allocated playback batch number; global monotonic cursor. */
    readonly seq: number;
    /** Explicit Stop awaiting credentials so the daemon can safely finish. */
    readonly stopRequested?: boolean;
    /** One cursor recovery per owner generation; repeated rejection is visible. */
    readonly sequenceResynced?: boolean;
    /** Latest content batch: retries reuse its seq; older batches are superseded. */
    readonly playbackBatch?: { readonly id: number; readonly seq: number; readonly resync?: boolean };
    readonly audio: SaviCaptureAudio;
}

const KEY = 'saviCaptureSession';
const RETIRED_KEY = 'saviCaptureRetirement';
// The daemon retains last_seq when capture/start resumes/re-arms the same
// captureId. A document generation is only an extension ownership fence.
// Keep one bounded durable high-water mark across owner retirement, failed
// starts, MV3 worker restarts and extension/browser reloads. Ownership stays
// in session storage. New daemon sessions accept gaps/a nonzero first seq.
const SEQUENCE_KEY = 'saviPlaybackSequence';

export const getCaptureRetirement = async (): Promise<(CaptureSessionRecord & { expired: boolean }) | undefined> =>
    (await browser.storage.session.get(RETIRED_KEY))?.[RETIRED_KEY] as
        | (CaptureSessionRecord & { expired: boolean })
        | undefined;

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
// Reserve a block before handing out its first number. A new worker skips
// the unused tail, so a crash/reload never reuses an exposed number. Keeping
// the cursor beside its storage handle also lets isolated hosts use this module.
const SEQUENCE_BLOCK = 256;
const cursors = new WeakMap<object, { next: number; reserved: number }>();
const sequenceCursor = async (floor: number) => {
    const storage = browser.storage.local;
    let cursor = cursors.get(storage);
    if (!cursor) {
        const value = (await storage.get(SEQUENCE_KEY))?.[SEQUENCE_KEY];
        const persisted = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
        cursor = { next: Math.max(floor, persisted), reserved: persisted };
        cursors.set(storage, cursor);
    }
    cursor.next = Math.max(cursor.next, floor);
    return cursor;
};

export const setCaptureSession = (record: CaptureSessionRecord): Promise<void> =>
    mutate(async () => {
        const [current, retired] = await Promise.all([getCaptureSession(), getCaptureRetirement()]);
        const cursor = await sequenceCursor(Math.max(record.seq, current?.seq ?? 0, retired?.seq ?? 0));
        await browser.storage.session.set({ [KEY]: { ...record, seq: cursor.next } });
    });

const retireCaptureSession = (
    expected?: CaptureSessionRecord,
    expired = false
): Promise<{ expired: boolean } | undefined> =>
    mutate(async () => {
        const current = await getCaptureSession();
        if (expected) {
            if (
                !current ||
                current.generation !== expected.generation ||
                current.captureId !== expected.captureId ||
                current.tabId !== expected.tabId ||
                current.documentId !== expected.documentId
            )
                return undefined;
        }
        // A single bounded retirement record distinguishes a real idle expiry
        // from an explicit Stop even when message delivery is reordered/lost.
        // An intervening recording replaces this slot and ends older recovery.
        // Persist the reason before removal, within the mutation chain.
        const retirement = { expired: expired && !current?.stopRequested };
        // Retirement/Stop must not require another durable write. Allocation
        // already reserved the cursor; the retirement record also retains seq.
        if (current) await browser.storage.session.set({ [RETIRED_KEY]: { ...current, ...retirement } });
        await browser.storage.session.remove(KEY);
        return retirement;
    });

export const clearCaptureSession = async (expected?: CaptureSessionRecord): Promise<boolean> =>
    (await retireCaptureSession(expected)) !== undefined;

/** Return the actual retirement reason, including a Stop received while a
 * daemon status/playback request was in flight. */
export const expireCaptureSession = (expected: CaptureSessionRecord): Promise<{ expired: boolean } | undefined> =>
    retireCaptureSession(expected, true);

/** Allocate only for the current owner, atomically with respect to clears. */
export const nextPlaybackSeq = (
    owns: (session: CaptureSessionRecord) => boolean = () => true,
    batchId?: number
): Promise<
    | { session: CaptureSessionRecord; seq: number; replayed?: boolean; superseded?: boolean; resync?: boolean }
    | undefined
> =>
    mutate(async () => {
        const session = await getCaptureSession();
        if (session === undefined || !owns(session)) return undefined;
        const batch = session.generation && Number.isSafeInteger(batchId) && batchId! > 0 ? batchId : undefined;
        if (batch !== undefined && session.playbackBatch && batch <= session.playbackBatch.id) {
            return {
                session,
                seq: session.playbackBatch.seq,
                replayed: true,
                superseded: batch < session.playbackBatch.id,
                resync: session.playbackBatch.resync,
            };
        }
        const cursor = await sequenceCursor(session.seq);
        const seq = cursor.next + 1;
        if (!Number.isSafeInteger(seq)) throw new Error('Playback sequence exhausted');
        if (seq > cursor.reserved) {
            const reserved = Math.min(Number.MAX_SAFE_INTEGER, seq + SEQUENCE_BLOCK - 1);
            // Persist before exposing a number, including when session writes fail.
            await browser.storage.local.set({ [SEQUENCE_KEY]: reserved });
            cursor.reserved = reserved;
        }
        cursor.next = seq;
        const updated = { ...session, seq, ...(batch !== undefined ? { playbackBatch: { id: batch, seq } } : {}) };
        await browser.storage.session.set({ [KEY]: updated });
        return { session: updated, seq };
    });

/** Retain Stop intent without overwriting a newer owner or sequence. */
export const markCaptureStopRequested = (expected: CaptureSessionRecord): Promise<boolean> =>
    mutate(async () => {
        const current = await getCaptureSession();
        if (
            !current ||
            current.generation !== expected.generation ||
            current.captureId !== expected.captureId ||
            current.tabId !== expected.tabId ||
            current.documentId !== expected.documentId
        )
            return false;
        await browser.storage.session.set({ [KEY]: { ...current, stopRequested: true } });
        return true;
    });

/** Reconcile a fresh-profile cursor without replaying old segment boundaries.
 * Ownership is checked again after HTTP; Stop/new owners cannot be overwritten. */
export const resyncPlaybackSequence = (
    expected: CaptureSessionRecord,
    floor: number | undefined
): Promise<'resynced' | 'blocked' | 'not-owner'> =>
    mutate(async () => {
        const current = await getCaptureSession();
        if (
            !current ||
            current.stopRequested ||
            current.generation !== expected.generation ||
            current.captureId !== expected.captureId ||
            current.tabId !== expected.tabId ||
            current.documentId !== expected.documentId ||
            current.frameId !== expected.frameId
        )
            return 'not-owner';
        if (
            current.sequenceResynced ||
            floor === undefined ||
            !Number.isSafeInteger(floor) ||
            floor < expected.seq ||
            floor >= Number.MAX_SAFE_INTEGER
        )
            return 'blocked';
        const cursor = await sequenceCursor(Math.max(current.seq, floor));
        const reserved = Math.max(cursor.reserved, Math.min(Number.MAX_SAFE_INTEGER, cursor.next + SEQUENCE_BLOCK));
        await browser.storage.local.set({ [SEQUENCE_KEY]: reserved });
        cursor.reserved = reserved;
        await browser.storage.session.set({
            [KEY]: {
                ...current,
                seq: cursor.next,
                sequenceResynced: true,
                ...(current.playbackBatch ? { playbackBatch: { ...current.playbackBatch, resync: true } } : {}),
            },
        });
        return 'resynced';
    });
