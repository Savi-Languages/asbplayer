import { isStaleCaptureSession } from './capture-staleness';
import { captureState } from './daemon-client';
import { adjustedBaseSubtitleOffset } from '../services/key-bindings';
jest.mock('./daemon-client', () => ({ captureState: jest.fn() }));
jest.mock('../services/binding', () => ({ __esModule: true, default: class {} }));
it('preserves a daemon-listed recording when its existing owner tab times out', async () => {
    jest.useFakeTimers();
    const oldBrowser = (globalThis as any).browser;
    try {
        (globalThis as any).browser = {
            tabs: { get: async () => ({ id: 7 }), sendMessage: () => new Promise(() => {}) },
        };
        (captureState as jest.Mock).mockResolvedValue(['netflix_A']);
        const pending = isStaleCaptureSession(
            {
                tabId: 7,
                src: 'video-A',
                captureId: 'netflix_A',
                episodeId: 'netflix_A',
                seq: 0,
                audio: { state: 'disabled' },
            },
            'netflix_B',
            9,
            { baseUrl: 'http://127.0.0.1:14074', token: 'qa-only' }
        );
        await jest.advanceTimersByTimeAsync(2000);
        expect(await pending).toBe(false);
    } finally {
        (globalThis as any).browser = oldBrowser;
        jest.useRealTimers();
    }
});
it('does not persist a negative subtitle position after six downward nudges at a clearance floor', () => {
    let offset = 75;
    for (let i = 0; i < 6; i++) offset = adjustedBaseSubtitleOffset(offset, false, 170);
    expect(offset).toBeGreaterThanOrEqual(0);
});
