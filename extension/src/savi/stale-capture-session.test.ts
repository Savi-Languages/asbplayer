import { isStaleCaptureSession } from './capture-staleness';
import { captureState } from './daemon-client';
import { CaptureSessionRecord } from './capture-session';

jest.mock('./daemon-client', () => ({
    ...jest.requireActual('./daemon-client'),
    captureState: jest.fn(),
}));

const mockCaptureState = captureState as jest.MockedFunction<typeof captureState>;

const config = { baseUrl: 'http://localhost:4030', token: 'lan-token' };

const session = (over: Partial<CaptureSessionRecord> = {}): CaptureSessionRecord => ({
    tabId: 7,
    src: 'https://www.youtube.com/watch?v=aaa',
    captureId: 'cap-aaa',
    episodeId: 'youtube_aaa',
    seq: 0,
    audio: undefined as any,
    ...over,
});

const tabs = (existing: number[]) => {
    (globalThis as any).browser = {
        tabs: {
            get: jest.fn(async (id: number) => {
                if (!existing.includes(id)) {
                    throw new Error('No tab with id');
                }
                return { id };
            }),
        },
    };
};

beforeEach(() => {
    mockCaptureState.mockReset();
    tabs([7]);
});

describe('isStaleCaptureSession', () => {
    it('is stale when the tab is gone', async () => {
        tabs([]); // the recorded tab no longer exists
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(true);
    });

    it('is stale when that tab moved to a different episode', async () => {
        // The case that produced "a savi capture is already running" with no way
        // out but closing the tab: same tab, next video, daemon had swept the old
        // capture long ago. Must hold even on a daemon with no state route.
        mockCaptureState.mockResolvedValue(undefined);
        expect(await isStaleCaptureSession(session(), 'youtube_bbb', 7, config)).toBe(true);
    });

    it('is stale when the daemon no longer lists the capture', async () => {
        // Same tab, same episode — only the daemon knows this one is over.
        mockCaptureState.mockResolvedValue(['youtube_something_else']);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(true);
    });

    it('is stale when the daemon reports nothing open at all', async () => {
        mockCaptureState.mockResolvedValue([]);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(true);
    });

    it('is NOT stale while the daemon still lists it', async () => {
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(false);
    });

    it('is NOT stale when the daemon cannot answer', async () => {
        // undefined means "no answer", NOT "nothing is running". Discarding the
        // record here would drop a live capture's bookkeeping — and the recorded
        // audio with it — every time the daemon hiccuped or was an older build.
        mockCaptureState.mockResolvedValue(undefined);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(false);
    });

    it('does not treat another tab capturing a different episode as stale', async () => {
        // A second tab asking to record must not sweep tab 7's live capture just
        // because the episodes differ — the episode rule is scoped to one tab.
        tabs([7, 9]);
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_bbb', 9, config)).toBe(false);
    });
});
