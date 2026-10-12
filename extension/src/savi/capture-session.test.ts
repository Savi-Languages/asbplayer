import {
    clearCaptureSession,
    markCaptureStopRequested,
    expireCaptureSession,
    getCaptureSession,
    nextPlaybackSeq,
    setCaptureSession,
    CaptureSessionRecord,
} from './capture-session';

const record = (seq = 0): CaptureSessionRecord => ({
    tabId: 7,
    src: 'blob:x',
    captureId: 'netflix_ep1',
    episodeId: 'netflix:ep1',
    seq,
    audio: { state: 'recording' },
});

describe('capture-session', () => {
    let store: Record<string, unknown>;

    beforeEach(() => {
        store = {};
        (globalThis as any).browser = {
            storage: {
                session: {
                    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
                    set: async (items: Record<string, unknown>) => {
                        Object.assign(store, items);
                    },
                    remove: async (key: string) => {
                        delete store[key];
                    },
                },
            },
        };
    });

    afterEach(() => {
        delete (globalThis as any).browser;
    });

    it('round-trips the session record', async () => {
        expect(await getCaptureSession()).toBeUndefined();
        await setCaptureSession(record());
        expect((await getCaptureSession())?.captureId).toBe('netflix_ep1');
        await clearCaptureSession();
        expect(await getCaptureSession()).toBeUndefined();
    });

    it('allocates strictly increasing seqs and persists them before use', async () => {
        await setCaptureSession(record(0));
        const first = await nextPlaybackSeq();
        expect(first?.seq).toBe(1);
        // Persisted immediately — a SW restart resumes from the stored value.
        expect((await getCaptureSession())?.seq).toBe(1);
        const second = await nextPlaybackSeq();
        expect(second?.seq).toBe(2);
    });

    it('yields no seq without a live session', async () => {
        expect(await nextPlaybackSeq()).toBeUndefined();
    });
    it('does not allocate or write a sequence for a rejected owner', async () => {
        await setCaptureSession(record());
        expect(await nextPlaybackSeq(() => false)).toBeUndefined();
        expect(await getCaptureSession()).toEqual(record());
    });
    it('cannot resurrect a cleared recording during a concurrent sequence allocation', async () => {
        await setCaptureSession(record());
        await Promise.all([nextPlaybackSeq(), clearCaptureSession(record())]);
        expect(await getCaptureSession()).toBeUndefined();
    });
    it('preserves a Stop queued while daemon expiry was in flight', async () => {
        const original = { ...record(), generation: 'current' };
        await setCaptureSession(original);
        await markCaptureStopRequested(original);
        expect(await expireCaptureSession(original)).toEqual({ expired: false });
    });
    it('does not clear a newer take when an old response arrives', async () => {
        const old = { ...record(), generation: 'old' };
        const newer = { ...record(), generation: 'new' };
        await setCaptureSession(newer);
        expect(await clearCaptureSession(old)).toBe(false);
        expect(await getCaptureSession()).toEqual(newer);
    });
});

it('does not mark a newer recording stopped when old credentials resolve late', async () => {
    let stored: any = { ...record(), generation: 'new', seq: 9 };
    (globalThis as any).browser = {
        storage: {
            session: {
                get: async () => ({ saviCaptureSession: stored }),
                set: async (v: any) => {
                    stored = v.saviCaptureSession;
                },
            },
        },
    };
    expect(await markCaptureStopRequested({ ...record(), generation: 'old' })).toBe(false);
    expect(stored.stopRequested).toBeUndefined();
    expect(await markCaptureStopRequested(stored)).toBe(true);
    expect(stored.seq).toBe(9);
    expect(stored.stopRequested).toBe(true);
    delete (globalThis as any).browser;
});
