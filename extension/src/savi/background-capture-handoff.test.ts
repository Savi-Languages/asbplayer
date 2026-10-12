jest.mock('./cloud-client', () => ({}));
jest.mock('./account', () => ({
    daemonCredentials: async () => ({ bearer: 'test-token' }),
}));
jest.mock('./daemon-client', () => ({
    ...jest.requireActual('./daemon-client'),
    captureState: jest.fn(),
    finishCapture: jest.fn(),
    startCapture: jest.fn(),
    postSubtitles: jest.fn(),
}));
jest.mock('./capture-session', () => ({
    getCaptureSession: jest.fn(),
    clearCaptureSession: jest.fn(),
    setCaptureSession: jest.fn(),
}));

import SaviCommandHandler from './background-handler';
import { captureState, finishCapture, startCapture, postSubtitles } from './daemon-client';
import { getCaptureSession, clearCaptureSession, setCaptureSession } from './capture-session';

const oldSession = {
    tabId: 7,
    src: 'blob:old-video',
    captureId: 'old-capture',
    episodeId: 'netflix:111',
    seq: 0,
};
const sendMessage = jest.fn();
const requestStart = (episodeId = 'netflix:222', tabId = 9, src = 'blob:new-video') => {
    const handler = new SaviCommandHandler({
        get: async () => ({
            saviDaemonUrl: 'http://localhost:4030',
            saviDaemonToken: 'test-token',
            saviAudioRecording: false,
        }),
    } as any);
    return new Promise<any>((resolve) => {
        handler.handle(
            {
                sender: 'savi-video',
                message: {
                    command: 'savi-start-capture',
                    episodeId,
                    src,
                    lang: 'ja',
                    subtitles: '',
                    subtitleFormat: 'srt',
                },
            },
            { tab: { id: tabId } } as any,
            resolve
        );
    });
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (getCaptureSession as jest.Mock).mockResolvedValue(oldSession);
    (clearCaptureSession as jest.Mock).mockResolvedValue(undefined);
    (setCaptureSession as jest.Mock).mockResolvedValue(undefined);
    (captureState as jest.Mock).mockResolvedValue([oldSession.episodeId]);
    // Neither finishing nor messaging a frozen tab may hold up the new capture.
    (finishCapture as jest.Mock).mockImplementation(() => new Promise(() => {}));
    (startCapture as jest.Mock).mockResolvedValue({ captureId: 'new-capture', audio: { state: 'disabled' } });
    (postSubtitles as jest.Mock).mockResolvedValue(undefined);
    sendMessage.mockImplementation(() => new Promise(() => {}));
    (globalThis as any).browser = { tabs: { get: async (id: number) => ({ id }), sendMessage } };
});

afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as any).browser;
});

describe('capture ownership after a frozen tab', () => {
    it('notifies the old controller to stop without restarting when another episode takes ownership', async () => {
        const result = requestStart();
        await jest.advanceTimersByTimeAsync(2000);
        expect(await result).toMatchObject({ started: true, captureId: 'new-capture' });
        expect(finishCapture).toHaveBeenCalledWith(expect.anything(), oldSession.captureId);
        expect(sendMessage).toHaveBeenCalledWith(7, {
            sender: 'savi-extension-to-video',
            message: {
                command: 'savi-capture-ended',
                src: oldSession.src,
                ok: false,
                expired: false,
                reason: 'ownership-transferred',
                errorMessage: 'Recording moved to another tab.',
            },
        });
        expect(setCaptureSession).toHaveBeenCalledWith(expect.objectContaining({ tabId: 9, episodeId: 'netflix:222' }));
    });

    it('still starts the new capture when the old tab has no message receiver', async () => {
        sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
        expect(await requestStart()).toMatchObject({ started: true });
        expect(sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                message: expect.objectContaining({ command: 'savi-capture-ended', expired: false }),
            })
        );
    });

    it('resumes the same episode while stopping its previous tab controller', async () => {
        const result = requestStart(oldSession.episodeId);
        await jest.advanceTimersByTimeAsync(2000);
        expect(await result).toMatchObject({ started: true });
        expect(finishCapture).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                message: expect.objectContaining({ command: 'savi-capture-ended', expired: false }),
            })
        );
    });

    it('does not send a delayed ended event to a new recorder in the same tab with a reused src', async () => {
        const result = requestStart('netflix:222', oldSession.tabId, oldSession.src);
        await jest.advanceTimersByTimeAsync(2000);
        expect(await result).toMatchObject({ started: true });
        expect(finishCapture).toHaveBeenCalled();
        expect(sendMessage.mock.calls.some(([, m]) => m.message.command === 'savi-capture-ended')).toBe(false);
    });

    it('does not replace a responsive owner', async () => {
        sendMessage.mockResolvedValue({ capturing: true });
        expect(await requestStart()).toMatchObject({ started: false, errorCode: 'already-capturing' });
        expect(clearCaptureSession).not.toHaveBeenCalled();
        expect(startCapture).not.toHaveBeenCalled();
        expect(finishCapture).not.toHaveBeenCalled();
    });
});

const requestStop = (tabId?: number, episodeId?: string) => {
    const handler = new SaviCommandHandler({
        get: async () => ({
            saviDaemonUrl: 'http://localhost:4030',
            saviDaemonToken: 'test-token',
        }),
    } as any);
    return new Promise<any>((resolve) =>
        handler.handle(
            {
                sender: 'savi-video',
                message: {
                    command: 'savi-stop-capture',
                    episodeId,
                },
            },
            (tabId === undefined ? {} : { tab: { id: tabId } }) as any,
            resolve
        )
    );
};
it.each([undefined, oldSession.episodeId])('rejects a stale tab stop even when episodeId is %s', async (episodeId) => {
    expect(await requestStop(9, episodeId)).toMatchObject({ stopped: false });
    expect(clearCaptureSession).not.toHaveBeenCalled();
    expect(finishCapture).not.toHaveBeenCalled();
});
it.each([oldSession.tabId, undefined])('allows the current owner or popup to stop (tab=%s)', async (tabId) => {
    expect(await requestStop(tabId)).toMatchObject({ stopped: true });
    expect(clearCaptureSession).toHaveBeenCalled();
    expect(finishCapture).toHaveBeenCalledWith(expect.anything(), oldSession.captureId);
});
it('rejects a previous episode stop in the current owner tab', async () => {
    expect(await requestStop(oldSession.tabId, 'netflix:other')).toMatchObject({ stopped: false });
    expect(clearCaptureSession).not.toHaveBeenCalled();
});
