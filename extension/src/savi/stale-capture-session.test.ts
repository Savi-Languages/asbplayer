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

// `capturing` = tabs where a capture controller answers the ownership ping. A
// tab with no capturing controller stays silent (undefined), as the real
// content scripts do.
const sendMessage = jest.fn();

const tabs = (existing: number[], capturing: number[] = existing) => {
    sendMessage.mockReset();
    sendMessage.mockImplementation(async (id: number) => (capturing.includes(id) ? { capturing: true } : undefined));
    (globalThis as any).browser = {
        tabs: {
            get: jest.fn(async (id: number) => {
                if (!existing.includes(id)) {
                    throw new Error('No tab with id');
                }
                return { id };
            }),
            sendMessage,
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

    it('is stale when the page reloaded — the daemon still lists it but nobody in the tab is capturing', async () => {
        // The case that showed "a savi capture is already running" over a
        // playing, subtitled episode that was not being recorded: a reload killed
        // the content script feeding the capture, the record and the daemon's
        // session both outlived it, and the daemon goes on listing an unfed
        // capture until its orphan sweep 90 minutes later.
        tabs([7], []);
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(true);
        expect(sendMessage).toHaveBeenCalledWith(7, {
            sender: 'savi-extension-to-video',
            message: { command: 'savi-capture-ping' },
        });
    });

    it('is stale when nobody is capturing, even if the daemon cannot answer', async () => {
        // Daemon silence must not be read as "nothing is running" — but the
        // owning tab's silence can: a live capture has a live controller.
        tabs([7], []);
        mockCaptureState.mockResolvedValue(undefined);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(true);
    });

    it('is stale when the owning tab has no content script to ask', async () => {
        tabs([7]);
        sendMessage.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_aaa', 7, config)).toBe(true);
    });

    it('is stale when the owning tab never answers the ping', async () => {
        jest.useFakeTimers();
        try {
            tabs([7]);
            sendMessage.mockImplementation(() => new Promise(() => {})); // frozen tab
            mockCaptureState.mockResolvedValue(['youtube_aaa']);
            const result = isStaleCaptureSession(session(), 'youtube_aaa', 7, config);
            await jest.advanceTimersByTimeAsync(2000);
            expect(await result).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    it('asks the tab that OWNS the record, not the tab asking to record', async () => {
        // Tab 9 wants to record while tab 7's orphaned capture is still listed:
        // tab 7 is the one that must vouch for it.
        tabs([7, 9], [9]);
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_bbb', 9, config)).toBe(true);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0][0]).toBe(7);
    });

    it('does not treat another tab capturing a different episode as stale', async () => {
        // A second tab asking to record must not sweep tab 7's live capture just
        // because the episodes differ — the episode rule is scoped to one tab.
        tabs([7, 9]);
        mockCaptureState.mockResolvedValue(['youtube_aaa']);
        expect(await isStaleCaptureSession(session(), 'youtube_bbb', 9, config)).toBe(false);
    });
});
