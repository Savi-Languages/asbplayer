import SaviCommandHandler from './background-handler';
import { captureState, finishCapture, startCapture, postSubtitles } from './daemon-client';
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
    browserHintFromUserAgent: () => 'edge',
}));
let stored: any;
let handler: any;
let send: jest.Mock;
const owner = { tab: { id: 7 }, frameId: 0, documentId: 'original' };
const message = { episodeId: 'episode-a', src: 'video', subtitles: 'test', subtitleFormat: 'srt' };
const oldSession = () => ({
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
    stored = oldSession();
    send = jest.fn().mockResolvedValue(undefined);
    (globalThis as any).browser = {
        tabs: { get: async () => ({ id: 7 }), query: async () => [{ id: 7 }], sendMessage: send },
        storage: {
            session: {
                get: async () => ({ saviCaptureSession: stored }),
                set: async (v: any) => {
                    stored = v.saviCaptureSession;
                },
                remove: async () => {
                    stored = undefined;
                },
            },
        },
    };
    (captureState as jest.Mock).mockResolvedValue(['episode-a']);
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
