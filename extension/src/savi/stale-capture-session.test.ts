import { isStaleCaptureSession } from './capture-staleness';
import { captureState } from './daemon-client';
import { CaptureSessionRecord } from './capture-session';
jest.mock('./daemon-client', () => ({ captureState: jest.fn() }));
const mockCaptureState = captureState as jest.Mock;
const config = { baseUrl: 'http://localhost:4030', token: 'test' };
const session: CaptureSessionRecord = {
    tabId: 7,
    frameId: 0,
    documentId: 'original',
    src: 'video',
    captureId: 'cap',
    episodeId: 'episode-a',
    seq: 0,
    audio: { state: 'disabled' },
};
let get: jest.Mock;
let query: jest.Mock;
let send: jest.Mock;
beforeEach(() => {
    get = jest.fn().mockResolvedValue({ id: 7 });
    query = jest.fn().mockResolvedValue([{ id: 7 }]);
    send = jest.fn();
    (globalThis as any).browser = { tabs: { get, query, sendMessage: send } };
    mockCaptureState.mockResolvedValue(['episode-a']);
});
it('retires only a tab confirmed absent from the inventory', async () => {
    get.mockRejectedValue(new Error('No tab'));
    query.mockResolvedValue([]);
    expect(await isStaleCaptureSession(session, 'episode-b', 9, config)).toBe(true);
});
it('preserves the owner when tabs.get fails transiently but the tab still exists', async () => {
    get.mockRejectedValue(new Error('Transient API failure'));
    expect(await isStaleCaptureSession(session, 'episode-b', 9, config)).toBe(false);
});
it('preserves the owner when tab and daemon checks are both unavailable', async () => {
    get.mockRejectedValue(new Error('Unavailable'));
    query.mockRejectedValue(new Error('Unavailable'));
    mockCaptureState.mockResolvedValue(undefined);
    expect(await isStaleCaptureSession(session, 'episode-b', 9, config)).toBe(false);
});
it.each([[[]], [['other']]])('retires a recording the daemon confirms ended: %j', async (active) => {
    mockCaptureState.mockResolvedValue(active);
    expect(await isStaleCaptureSession(session, 'episode-a', 7, config)).toBe(true);
});
it.each(['silent', 'frozen', 'error'])('preserves the listed owner with %s messaging', async (mode) => {
    send.mockImplementation(() =>
        mode === 'frozen'
            ? new Promise(() => {})
            : mode === 'error'
              ? Promise.reject(new Error('Closed message port'))
              : Promise.resolve(undefined)
    );
    expect(await isStaleCaptureSession(session, 'episode-b', 9, config)).toBe(false);
    expect(send).not.toHaveBeenCalled();
});
it('does not let a second video in the same document evict the owner', async () => {
    expect(await isStaleCaptureSession(session, 'episode-b', 7, config, { frameId: 0, documentId: 'original' })).toBe(
        false
    );
});
it('recovers a replaced document within the same owner frame', async () => {
    expect(await isStaleCaptureSession(session, 'episode-a', 7, config, { frameId: 0, documentId: 'reloaded' })).toBe(
        true
    );
});
it('does not confuse a different frame with a reloaded owner', async () => {
    expect(await isStaleCaptureSession(session, 'episode-b', 7, config, { frameId: 1, documentId: 'other' })).toBe(
        false
    );
});
it('does not compare document identities across tabs', async () => {
    expect(await isStaleCaptureSession(session, 'episode-b', 9, config, { frameId: 0, documentId: 'other' })).toBe(
        false
    );
});
it.each([{}, { frameId: 0 }, { documentId: 'new' }])(
    'retains sessions when requesting context is incomplete: %j',
    async (context) => {
        expect(await isStaleCaptureSession(session, 'episode-a', 7, config, context)).toBe(false);
    }
);
it('retains legacy sessions without document metadata until explicit Stop or daemon reconciliation', async () => {
    const legacy = { ...session, documentId: undefined, frameId: undefined };
    expect(await isStaleCaptureSession(legacy, 'episode-a', 7, config, { frameId: 0, documentId: 'new' })).toBe(false);
});
