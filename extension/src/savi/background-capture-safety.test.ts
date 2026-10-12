import SaviCommandHandler from './background-handler';
import { captureState, finishCapture, startCapture, postSubtitles, postPlaybackState } from './daemon-client';
jest.mock('./watch-interest-service', () => ({}));
jest.mock('./target-service', () => ({}));
jest.mock('./account', () => ({}));
jest.mock('./cloud-client', () => ({}));
jest.mock('./persistent-cache', () => ({}));
jest.mock('@/services/capture-visible-tab', () => ({}));
jest.mock('@/services/subtitle-sources', () => ({}));
jest.mock('./cloud-settings', () => ({}));
jest.mock('./muted-sites', () => ({}));
jest.mock('./daemon-client', () => ({
    isDaemonResponseError: () => false,
    captureState: jest.fn(),
    finishCapture: jest.fn(),
    startCapture: jest.fn(),
    postSubtitles: jest.fn(),
    postPlaybackState: jest.fn(),
    browserHintFromUserAgent: () => 'edge',
}));
let stored: any;
let retired: any;
let sequence: number | undefined;
let handler: any;
let send: jest.Mock;
const owner = { tab: { id: 7 }, frameId: 0, documentId: 'original' };
const message = { episodeId: 'episode-a', src: 'video', subtitles: 'test', subtitleFormat: 'srt' };
const oldSession = () => ({
    generation: 'original-generation',
    tabId: 7,
    frameId: 0,
    documentId: 'original',
    src: 'video',
    captureId: 'episode-a',
    episodeId: 'episode-a',
    seq: 0,
    audio: { state: 'disabled' },
});
beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: jest.fn(() => 'new-generation') });
    stored = oldSession();
    retired = undefined;
    sequence = undefined;
    send = jest.fn().mockResolvedValue(undefined);
    (globalThis as any).browser = {
        tabs: { get: async () => ({ id: 7 }), query: async () => [{ id: 7 }], sendMessage: send },
        storage: {
            local: {
                get: async () => ({ saviPlaybackSequence: sequence }),
                set: async (v: any) => {
                    sequence = v.saviPlaybackSequence;
                },
            },
            session: {
                get: async () => ({
                    saviCaptureSession: stored,
                    saviCaptureRetirement: retired,
                }),
                set: async (v: any) => {
                    if ('saviCaptureSession' in v) stored = v.saviCaptureSession;
                    if ('saviCaptureRetirement' in v) retired = v.saviCaptureRetirement;
                },
                remove: async () => {
                    stored = undefined;
                },
            },
        },
    };
    (captureState as jest.Mock).mockResolvedValue(['episode-a']);
    (postPlaybackState as jest.Mock).mockReset().mockResolvedValue({ ok: true });
    (startCapture as jest.Mock).mockImplementation(async (_config, body) => ({
        captureId: body.episodeId,
        audio: { state: 'disabled' },
    }));
    (postSubtitles as jest.Mock).mockResolvedValue(undefined);
    (finishCapture as jest.Mock).mockResolvedValue({});
    handler = new SaviCommandHandler({ get: async () => ({ saviAudioRecording: false }) } as any);
    handler._daemonConfig = async () => ({ baseUrl: 'http://localhost:14074', token: 'test' });
});
it('blocks a second tab and keeps popup Recording when the existing owner is silent', async () => {
    send.mockImplementation(() => new Promise(() => {}));
    expect(
        await handler._startCapture({ ...message, episodeId: 'episode-b' }, { ...owner, tab: { id: 9 } })
    ).toMatchObject({ started: false, errorCode: 'already-capturing' });
    expect(await handler._captureState()).toMatchObject({ active: true, tabId: 7 });
    expect(finishCapture).not.toHaveBeenCalled();
    expect(startCapture).not.toHaveBeenCalled();
    expect(stored).toEqual(oldSession());
});
it('resumes the same episode after a real document reload and updates owner metadata', async () => {
    expect(await handler._startCapture(message, { ...owner, documentId: 'reloaded' })).toMatchObject({ started: true });
    expect(finishCapture).not.toHaveBeenCalled();
    expect(stored.documentId).toBe('reloaded');
});
it('serializes concurrent starts so the handshake cannot grant duplicate ownership', async () => {
    stored = undefined;
    const results = await Promise.all([handler._startCapture(message, owner), handler._startCapture(message, owner)]);
    expect(results.map((r: any) => r.started)).toEqual([true, false]);
    expect(startCapture).toHaveBeenCalledTimes(1);
});
it('notifies the original document before allowing another episode after reload', async () => {
    const order: string[] = [];
    (finishCapture as jest.Mock).mockImplementation(async () => {
        order.push('finish');
        return {};
    });
    send.mockImplementation(async () => {
        order.push('notify');
    });
    (startCapture as jest.Mock).mockImplementation(async () => {
        order.push('start');
        return { captureId: 'episode-b' };
    });
    expect(
        await handler._startCapture({ ...message, episodeId: 'episode-b' }, { ...owner, documentId: 'reloaded' })
    ).toMatchObject({ started: true });
    expect(order).toEqual(['finish', 'notify', 'start']);
    expect(send).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ message: expect.objectContaining({ command: 'savi-capture-ended' }) }),
        { documentId: 'original' }
    );
});
it('retains the previous session and refuses a new start when saving it fails', async () => {
    (finishCapture as jest.Mock).mockRejectedValue(new Error('offline'));
    expect(
        await handler._startCapture({ ...message, episodeId: 'episode-b' }, { ...owner, documentId: 'reloaded' })
    ).toMatchObject({ started: false });
    expect(startCapture).not.toHaveBeenCalled();
    expect(stored).toEqual(oldSession());
});

it('does not wait for a notification reply after the old recording was saved', async () => {
    send.mockImplementation(() => new Promise(() => {}));
    expect(
        await handler._startCapture({ ...message, episodeId: 'episode-b' }, { ...owner, documentId: 'reloaded' })
    ).toMatchObject({ started: true });
    expect(finishCapture).toHaveBeenCalledTimes(1);
});

it.each([undefined, 'episode-a'])(
    'rejects a stale other-tab Stop, with or without episode id (%s)',
    async (episode) => {
        expect(await handler._stopCapture(episode, { ...owner, tab: { id: 9 } })).toMatchObject({ stopped: false });
        expect(stored).toEqual(oldSession());
        expect(finishCapture).not.toHaveBeenCalled();
    }
);
it.each([{ documentId: 'old-document' }, { frameId: 3 }])(
    'rejects same-tab Stops from a different document/frame: %j',
    async (context) => {
        expect(await handler._stopCapture(undefined, { ...owner, ...context })).toMatchObject({ stopped: false });
        expect(stored).toEqual(oldSession());
    }
);
it('rejects an old generation Stop even within the current document and episode', async () => {
    expect(await handler._stopCapture('episode-a', owner, 'previous-generation')).toMatchObject({ stopped: false });
    expect(stored).toEqual(oldSession());
});
it.each([owner, {}])('accepts current owner and explicit popup Stop: %j', async (sender) => {
    expect(await handler._stopCapture(undefined, sender)).toMatchObject({ stopped: true });
    expect(stored).toBeUndefined();
    expect(finishCapture).toHaveBeenCalledTimes(1);
});
it('notifies a swept owner and rejects its later unscoped Stop without ending the new recording', async () => {
    (captureState as jest.Mock).mockResolvedValue([]);
    expect(
        await handler._startCapture(
            { ...message, episodeId: 'episode-b' },
            { ...owner, tab: { id: 9 }, documentId: 'new-tab' }
        )
    ).toMatchObject({ started: true });
    expect(send).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
            message: expect.objectContaining({ reason: 'ownership-transferred', generation: 'original-generation' }),
        }),
        { documentId: 'original' }
    );
    expect(await handler._stopCapture(undefined, owner)).toMatchObject({ stopped: false });
    expect(stored.episodeId).toBe('episode-b');
    expect(finishCapture).not.toHaveBeenCalled();
});
it('returns notOwner to stale playback rather than letting it feed a newer recording', async () => {
    expect(await handler._playbackState({ episodeId: 'episode-a', ops: [] }, { ...owner, tab: { id: 9 } })).toEqual({
        ok: false,
        notOwner: true,
    });
});

it('reports idle expiry rather than an ownership handoff when reconciling popup state', async () => {
    (captureState as jest.Mock).mockResolvedValue([]);
    expect(await handler._captureState()).toEqual({ active: false });
    expect(send).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
            message: expect.objectContaining({ expired: true, reason: undefined, generation: 'original-generation' }),
        }),
        { documentId: 'original' }
    );
});
it('cannot clear a newer recording when an old popup status request finishes late', async () => {
    (captureState as jest.Mock).mockImplementation(async () => {
        stored = { ...oldSession(), generation: 'newer', episodeId: 'episode-b' };
        return ['episode-b'];
    });
    expect(await handler._captureState()).toMatchObject({ active: true, episodeId: 'episode-b' });
    expect(stored.generation).toBe('newer');
    expect(send).not.toHaveBeenCalled();
});
it.each([{ documentId: 'old' }, { frameId: 3 }])(
    'rejects non-owner playback context before mutating sequence: %j',
    async (context) => {
        expect(await handler._playbackState({ episodeId: 'episode-a', ops: [] }, { ...owner, ...context })).toEqual({
            ok: false,
            notOwner: true,
        });
        expect(stored.seq).toBe(0);
    }
);
it('rejects old-generation playback without changing the new take sequence', async () => {
    expect(await handler._playbackState({ episodeId: 'episode-a', generation: 'old', ops: [] }, owner)).toEqual({
        ok: false,
        notOwner: true,
    });
    expect(stored.seq).toBe(0);
});

it('distinguishes absent ownership from a competing owner during idle recovery', async () => {
    stored = undefined;
    expect(await handler._playbackState({ generation: 'old', ops: [] }, owner)).toEqual({
        ok: false,
        ownerAbsent: true,
    });
});
it('remembers a Stop while signed out and finishes it before the next same-episode start', async () => {
    handler._daemonConfig = async () => undefined;
    expect(await handler._stopCapture('episode-a', owner, 'original-generation')).toMatchObject({ stopped: false });
    expect(stored.stopRequested).toBe(true);
    handler._daemonConfig = async () => ({ baseUrl: 'http://localhost:14074', token: 'test' });
    expect(await handler._startCapture(message, owner)).toMatchObject({ started: true });
    expect(finishCapture).toHaveBeenCalledTimes(1);
    expect(stored.stopRequested).toBeUndefined();
});
it('preserves a pending signed-out Stop when the later finish fails', async () => {
    stored.stopRequested = true;
    (finishCapture as jest.Mock).mockRejectedValue(new Error('offline'));
    expect(await handler._startCapture(message, owner)).toMatchObject({ started: false });
    expect(stored.stopRequested).toBe(true);
    expect(finishCapture).toHaveBeenCalledTimes(1);
    expect(startCapture).not.toHaveBeenCalled();
});
it('returns a typed already-stopped result for an idempotent Stop retry', async () => {
    stored = undefined;
    expect(await handler._stopCapture('episode-a', owner, 'original-generation')).toMatchObject({
        stopped: false,
        alreadyStopped: true,
    });
});

it('recovers an expired take after the notification is lost or reordered, but not an explicit Stop', async () => {
    (captureState as jest.Mock).mockResolvedValue([]);
    await handler._captureState();
    expect(stored).toBeUndefined();
    expect(
        await handler._playbackState({ episodeId: 'episode-a', generation: 'original-generation', ops: [] }, owner)
    ).toEqual({ ok: false, sessionGone: true });
    retired.expired = false;
    expect(
        await handler._playbackState({ episodeId: 'episode-a', generation: 'original-generation', ops: [] }, owner)
    ).toEqual({ ok: false, ownerAbsent: true });
    retired.expired = true;
    expect(await handler._playbackState({ episodeId: 'episode-a', generation: 'other', ops: [] }, owner)).toEqual({
        ok: false,
        ownerAbsent: true,
    });
});
it('persists explicit Stop retirement so late playback cannot restart it', async () => {
    await handler._stopCapture('episode-a', owner, 'original-generation');
    expect(retired.expired).toBe(false);
    expect(
        await handler._playbackState({ episodeId: 'episode-a', generation: 'original-generation', ops: [] }, owner)
    ).toEqual({ ok: false, ownerAbsent: true });
});

it.each([false, true])(
    'preserves signed-out Stop over an idle sweep (Stop arrives during status=%s)',
    async (duringStatus) => {
        if (!duringStatus) stored.stopRequested = true;
        (captureState as jest.Mock).mockImplementation(async () => {
            if (duringStatus) stored = { ...stored, stopRequested: true };
            return [];
        });
        expect(await handler._captureState()).toEqual({ active: false });
        expect(retired.expired).toBe(false);
        expect(send).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ message: expect.objectContaining({ expired: false }) }),
            { documentId: 'original' }
        );
        expect(
            await handler._playbackState({ episodeId: 'episode-a', generation: 'original-generation', ops: [] }, owner)
        ).toEqual({ ok: false, ownerAbsent: true });
    }
);

it('honors a signed-out Stop received while a playback expiry response was in flight', async () => {
    (postPlaybackState as jest.Mock).mockImplementation(async () => {
        stored = { ...stored, stopRequested: true };
        return { ok: false, sessionGone: true };
    });
    expect(
        await handler._playbackState({ episodeId: 'episode-a', generation: 'original-generation', ops: [] }, owner)
    ).toEqual({ ok: false, ownerAbsent: true });
    expect(retired.expired).toBe(false);
    expect(send).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ message: expect.objectContaining({ expired: false }) }),
        { documentId: 'original' }
    );
});

// The daemon keeps last_seq on same-capture start/re-arm. A new local owner
// generation does not reset that audio-engine sequence.
it('continues the daemon sequence after a same-episode document reload', async () => {
    stored.seq = 42;
    const reloaded = { ...owner, documentId: 'reloaded' };
    const response = await handler._startCapture(message, reloaded);
    expect(response.started).toBe(true);
    await handler._playbackState({ episodeId: message.episodeId, generation: response.generation, ops: [] }, reloaded);
    expect(postPlaybackState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seq: 43 }));
});

it('preserves an allocated batch while reload replaces its owner and its HTTP request is in flight', async () => {
    stored.seq = 42;
    let acknowledge!: (value: any) => void;
    let reached!: () => void;
    const sent = new Promise<void>((resolve) => {
        reached = resolve;
    });
    (postPlaybackState as jest.Mock).mockImplementationOnce(() => {
        reached();
        return new Promise((resolve) => {
            acknowledge = resolve;
        });
    });
    const oldPlayback = handler._playbackState(
        { episodeId: message.episodeId, generation: stored.generation, ops: [] },
        owner
    );
    await sent;
    const reloaded = { ...owner, documentId: 'reloaded' };
    const response = await handler._startCapture(message, reloaded);
    const newPlayback = handler._playbackState(
        { episodeId: message.episodeId, generation: response.generation, ops: [] },
        reloaded
    );
    acknowledge({ ok: true });
    await Promise.all([oldPlayback, newPlayback]);
    expect((postPlaybackState as jest.Mock).mock.calls.map((call) => call[1].seq)).toEqual([43, 44]);
});

it('keeps the sequence through a failed resume handshake and its retry', async () => {
    stored.seq = 42;
    (postSubtitles as jest.Mock).mockRejectedValueOnce(new Error('lost reply'));
    const reloaded = { ...owner, documentId: 'reloaded' };
    expect(await handler._startCapture(message, reloaded)).toMatchObject({ started: false });
    const response = await handler._startCapture(message, reloaded);
    await handler._playbackState({ episodeId: message.episodeId, generation: response.generation, ops: [] }, reloaded);
    expect(postPlaybackState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ seq: 43 }));
});

it('raises a fresh-profile cursor without replaying stale historical segment boundaries', async () => {
    (postPlaybackState as jest.Mock).mockResolvedValueOnce({
        ok: false,
        staleSeq: true,
        lastSeq: 800,
        audio: 'recording',
    });
    const result = await handler._playbackState(
        { ...message, generation: stored.generation, ops: [{ op: 'segment-end' }] },
        owner
    );
    expect(result).toMatchObject({ ok: false, staleSeq: true, sequenceResynced: true });
    expect(postPlaybackState).toHaveBeenCalledTimes(1);
    expect(sequence).toBeGreaterThanOrEqual(800);
    await handler._playbackState({ ...message, generation: stored.generation, ops: [] }, owner);
    expect((postPlaybackState as jest.Mock).mock.calls[1][1].seq).toBeGreaterThan(800);
    expect(finishCapture).not.toHaveBeenCalled();
});
it('retires a repeatedly stale owner without finishing another profile recording', async () => {
    (postPlaybackState as jest.Mock).mockResolvedValue({ ok: false, staleSeq: true, lastSeq: 800 });
    await handler._playbackState({ ...message, ops: [] }, owner);
    (postPlaybackState as jest.Mock).mockResolvedValue({ ok: false, staleSeq: true, lastSeq: 1600 });
    expect(await handler._playbackState({ ...message, ops: [] }, owner)).toMatchObject({
        staleSeq: true,
        sequenceResynced: false,
    });
    expect(stored).toBeUndefined();
    expect(finishCapture).not.toHaveBeenCalled();
});
it('surfaces an old daemon stale response instead of recutting forever', async () => {
    (postPlaybackState as jest.Mock).mockResolvedValue({ ok: false, staleSeq: true });
    expect(await handler._playbackState({ ...message, ops: [] }, owner)).toMatchObject({
        staleSeq: true,
        sequenceResynced: false,
    });
    expect(stored).toBeUndefined();
    expect(finishCapture).not.toHaveBeenCalled();
});
it('does not replay an applied boundary batch after its HTTP reply was lost', async () => {
    (postPlaybackState as jest.Mock)
        .mockRejectedValueOnce(new Error('timeout'))
        .mockImplementationOnce(async (_config, batch) => ({ ok: false, staleSeq: true, lastSeq: batch.seq }));
    expect(await handler._playbackState({ ...message, ops: [{ op: 'segment-end' }] }, owner)).toMatchObject({
        ok: true,
    });
    expect((postPlaybackState as jest.Mock).mock.calls.map((call) => call[1].seq)).toEqual([1, 1]);
    expect(stored).toBeDefined();
});
it('does not let an old stale response raise or retire the replacement owner', async () => {
    let resolve!: (value: any) => void;
    (postPlaybackState as jest.Mock).mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = handler._playbackState({ ...message, generation: stored.generation, ops: [] }, owner);
    while (!(postPlaybackState as jest.Mock).mock.calls.length) await Promise.resolve();
    stored = { ...oldSession(), generation: 'replacement', seq: 999 };
    resolve({ ok: false, staleSeq: true, lastSeq: 800 });
    expect(await pending).toMatchObject({ notOwner: true });
    expect(stored).toMatchObject({ generation: 'replacement', seq: 999 });
});

it('reuses the sequence for the same content batch after a lost worker reply', async () => {
    const batch = { ...message, generation: stored.generation, batchId: 1, ops: [{ op: 'segment-end' }] };
    await handler._playbackState(batch, owner);
    (postPlaybackState as jest.Mock).mockImplementation(async (_config, body) => ({
        ok: false,
        staleSeq: true,
        lastSeq: body.seq,
    }));
    expect(await handler._playbackState(batch, owner)).toMatchObject({ ok: true });
    expect((postPlaybackState as jest.Mock).mock.calls.map((call) => call[1].seq)).toEqual([1, 1]);
});
it('does not post a delayed content batch that a newer batch superseded', async () => {
    const batch = { ...message, generation: stored.generation, ops: [] };
    await handler._playbackState({ ...batch, batchId: 1 }, owner);
    await handler._playbackState({ ...batch, batchId: 2 }, owner);
    expect(await handler._playbackState({ ...batch, batchId: 1 }, owner)).toMatchObject({ ok: true });
    expect(postPlaybackState).toHaveBeenCalledTimes(2);
});

it('repeats a lost resync reply without posting the stale content batch again', async () => {
    const batch = { ...message, generation: stored.generation, batchId: 1, ops: [] };
    (postPlaybackState as jest.Mock).mockResolvedValue({ ok: false, staleSeq: true, lastSeq: 800 });
    expect(await handler._playbackState(batch, owner)).toMatchObject({ sequenceResynced: true });
    expect(await handler._playbackState(batch, owner)).toMatchObject({ sequenceResynced: true });
    expect(postPlaybackState).toHaveBeenCalledTimes(1);
});

it('resyncs a replayed batch when another profile advanced beyond its sequence', async () => {
    const batch = { ...message, generation: stored.generation, batchId: 1, ops: [{ op: 'segment-end' }] };
    await handler._playbackState(batch, owner);
    (postPlaybackState as jest.Mock).mockResolvedValue({ ok: false, staleSeq: true, lastSeq: 800 });
    expect(await handler._playbackState(batch, owner)).toMatchObject({ ok: false, sequenceResynced: true });
    expect(sequence).toBeGreaterThan(800);
});
