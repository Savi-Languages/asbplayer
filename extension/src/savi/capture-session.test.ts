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
    let local: Record<string, unknown>;

    beforeEach(() => {
        store = {};
        local = {};
        (globalThis as any).browser = {
            storage: {
                local: {
                    get: async (key: string) => (key in local ? { [key]: local[key] } : {}),
                    set: async (items: Record<string, unknown>) => {
                        Object.assign(local, items);
                    },
                },
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

    it('reserves durable blocks instead of writing local storage on every keepalive', async () => {
        await setCaptureSession(record());
        const durableWrite = jest.spyOn(browser.storage.local, 'set');
        const sessionRead = jest.spyOn(browser.storage.session, 'get');
        let previous = 0;
        for (let i = 0; i < 720; i++) {
            const allocation = await nextPlaybackSeq();
            expect(allocation!.seq).toBeGreaterThan(previous);
            previous = allocation!.seq;
            expect(local.saviPlaybackSequence).toBeGreaterThanOrEqual(previous);
        }
        expect(durableWrite.mock.calls.length).toBeLessThanOrEqual(4);
        expect(sessionRead.mock.calls.length).toBeLessThanOrEqual(720);
    });

    it('retains content batch deduplication across a service-worker restart', async () => {
        await setCaptureSession({ ...record(), generation: 'owner' });
        const first = await nextPlaybackSeq(() => true, 1);
        let restarted!: typeof import('./capture-session');
        jest.isolateModules(() => {
            restarted = require('./capture-session');
        });
        expect((await restarted.nextPlaybackSeq(() => true, 1))?.seq).toBe(first?.seq);
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
    it('carries the latest concurrent allocation through retirement and owner replacement', async () => {
        await setCaptureSession(record(42));
        const [allocated] = await Promise.all([
            nextPlaybackSeq(),
            clearCaptureSession(record(42)),
            setCaptureSession({ ...record(), generation: 'reloaded' }),
        ]);
        expect(allocated?.seq).toBe(43);
        expect((await nextPlaybackSeq())?.seq).toBe(44);
    });
    it('survives a fresh service-worker module after clearing the old owner', async () => {
        await setCaptureSession(record(42));
        await nextPlaybackSeq();
        await clearCaptureSession();
        let restarted!: typeof import('./capture-session');
        jest.isolateModules(() => {
            restarted = require('./capture-session');
        });
        await restarted.setCaptureSession({ ...record(), generation: 'reloaded' });
        const next = (await restarted.nextPlaybackSeq())!.seq;
        expect(next).toBeGreaterThan(43);
        expect(next).toBeLessThanOrEqual(43 + 256);
    });
    it('uses increasing numbers even for a genuinely new daemon session, which accepts any higher positive seq', async () => {
        await setCaptureSession(record(42));
        await clearCaptureSession();
        await setCaptureSession({ ...record(), captureId: 'new-capture', episodeId: 'new-episode' });
        expect((await nextPlaybackSeq())?.seq).toBe(43);
    });
    it('keeps the high water mark after intervening retirement replaces the recovery slot', async () => {
        await setCaptureSession(record(42));
        await clearCaptureSession();
        await setCaptureSession({ ...record(), captureId: 'other-capture' });
        await nextPlaybackSeq();
        await clearCaptureSession();
        await setCaptureSession(record());
        expect((await nextPlaybackSeq())?.seq).toBe(44);
    });
    it('retains the sequence when extension reload clears all session storage', async () => {
        await setCaptureSession(record(42));
        await nextPlaybackSeq();
        store = {};
        let restarted!: typeof import('./capture-session');
        jest.isolateModules(() => {
            restarted = require('./capture-session');
        });
        await restarted.setCaptureSession({ ...record(), generation: 'after-extension-reload' });
        const next = (await restarted.nextPlaybackSeq())!.seq;
        expect(next).toBeGreaterThan(43);
        expect(next).toBeLessThanOrEqual(43 + 256);
    });
    it('does not allocate a usable batch if durable cursor persistence fails', async () => {
        await setCaptureSession(record(42));
        (globalThis as any).browser.storage.local.set = async () => {
            throw new Error('storage unavailable');
        };
        await expect(nextPlaybackSeq()).rejects.toThrow('storage unavailable');
        expect((await getCaptureSession())?.seq).toBe(42);
    });
    it('skips rather than reuses an allocation when the worker loses its session write', async () => {
        await setCaptureSession(record(42));
        const writeSession = (globalThis as any).browser.storage.session.set;
        (globalThis as any).browser.storage.session.set = async () => {
            throw new Error('worker interrupted');
        };
        await expect(nextPlaybackSeq()).rejects.toThrow('worker interrupted');
        (globalThis as any).browser.storage.session.set = writeSession;
        let restarted!: typeof import('./capture-session');
        jest.isolateModules(() => {
            restarted = require('./capture-session');
        });
        const next = (await restarted.nextPlaybackSeq())!.seq;
        expect(next).toBeGreaterThan(43);
        expect(next).toBeLessThanOrEqual(43 + 256);
    });
    it('can retire and finish an existing recording when durable storage writes fail', async () => {
        await setCaptureSession(record(42));
        (globalThis as any).browser.storage.local.set = async () => {
            throw new Error('quota exceeded');
        };
        expect(await clearCaptureSession(record(42))).toBe(true);
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
