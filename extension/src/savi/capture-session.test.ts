import {
    clearCaptureSession,
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
});
