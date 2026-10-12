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
    captureState: jest.fn(),
    finishCapture: jest.fn(),
    startCapture: jest.fn(),
    postSubtitles: jest.fn(),
    postPlaybackState: jest.fn(),
    browserHintFromUserAgent: () => 'edge',
}));
let stored: any;
let retired: any;
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
    send = jest.fn().mockResolvedValue(undefined);
    (globalThis as any).browser = {
        tabs: { get: async () => ({ id: 7 }), query: async () => [{ id: 7 }], sendMessage: send },
        storage: {
            session: {
                get: async () => ({ saviCaptureSession: stored, saviCaptureRetirement: retired }),
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
