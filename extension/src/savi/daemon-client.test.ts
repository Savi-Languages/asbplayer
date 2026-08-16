import { browserHintFromUserAgent, explainWord, postPlaybackState, segmentLine } from './daemon-client';

describe('postPlaybackState openSegment', () => {
    const replyWith = (body: Record<string, unknown>) => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body }) as any;
        return postPlaybackState(
            { baseUrl: 'http://127.0.0.1:4030', token: 't' },
            { captureId: 'c', seq: 1, ops: [] }
        );
    };

    it('reports the open segment id', async () => {
        expect((await replyWith({ ok: true, audio: 'recording', openSegment: 's7' })).openSegment).toBe('s7');
    });

    it('reports null when the daemon has NOTHING open', async () => {
        // This is the signal the controller acts on: our segment was closed
        // underneath us, so re-asserting it can never recover — only a fresh
        // segment at the live playhead will.
        expect((await replyWith({ ok: true, audio: 'recording', openSegment: null })).openSegment).toBeNull();
    });

    it('reports undefined when the daemon does not know the field at all', async () => {
        // A pre-0.44.4 daemon simply omits it. Collapsing that into `null`
        // would read as "your segment is closed" on EVERY keepalive, and the
        // controller would re-anchor every few seconds — shredding the capture
        // into fragments instead of protecting it.
        expect((await replyWith({ ok: true, audio: 'recording' })).openSegment).toBeUndefined();
    });
});

describe('browserHintFromUserAgent', () => {
    it('hints only DISTINGUISHABLE browsers', () => {
        expect(
            browserHintFromUserAgent(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87'
            )
        ).toBe('edge');
        expect(
            browserHintFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0')
        ).toBe('firefox');
        expect(
            browserHintFromUserAgent(
                'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Vivaldi/6.8'
            )
        ).toBe('vivaldi');
    });

    it('never hints for the Chrome UA — Chromium forks (Brave, Arc) masquerade as Chrome, and a wrong narrow hint would miss their audio', () => {
        expect(
            browserHintFromUserAgent(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            )
        ).toBeUndefined();
        expect(browserHintFromUserAgent('')).toBeUndefined();
    });
});

describe('the credential split on the wire', () => {
    const lastFetchHeaders = () => (global.fetch as jest.Mock).mock.calls[0][1].headers as Record<string, string>;

    it('sends the bearer AND the account JWT in separate headers', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as any;
        await postPlaybackState(
            { baseUrl: 'http://127.0.0.1:4030', token: 'lan-token', accountJwt: 'jwt-1' },
            { captureId: 'c', seq: 1, ops: [] }
        );
        expect(lastFetchHeaders()['Authorization']).toBe('Bearer lan-token');
        expect(lastFetchHeaders()['X-Savi-Account']).toBe('jwt-1');
    });

    it('sends NO identity header when signed out — absence is the signal, not an empty value', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }) as any;
        await postPlaybackState(
            { baseUrl: 'http://127.0.0.1:4030', token: 'lan-token' },
            { captureId: 'c', seq: 1, ops: [] }
        );
        expect(lastFetchHeaders()['Authorization']).toBe('Bearer lan-token');
        expect('X-Savi-Account' in lastFetchHeaders()).toBe(false);
    });
});

describe('typed unavailable passthrough', () => {
    const config = { baseUrl: 'http://127.0.0.1:4030', token: 'lan-token' };
    const replyWith = (body: Record<string, unknown>) => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body }) as any;
    };

    it('explainWord carries the daemon-named reason beside a null explanation', async () => {
        replyWith({ explanation: null, unavailable: 'accountMismatch' });
        expect(await explainWord(config, 'ja', '猫', '猫は寝る')).toEqual({
            explanation: null,
            unavailable: 'accountMismatch',
        });
    });

    it('explainWord reports no reason when there IS an explanation', async () => {
        replyWith({ explanation: 'It marks the topic here.', unavailable: 'provider' });
        expect(await explainWord(config, 'ja', 'は', '猫は寝る')).toEqual({
            explanation: 'It marks the topic here.',
            unavailable: undefined,
        });
    });

    it('drops reasons it does not recognize — a future daemon must degrade to the generic copy, not leak enum values into the UI', async () => {
        replyWith({ explanation: null, unavailable: 'somethingNew' });
        expect((await explainWord(config, 'ja', '猫', '猫は寝る')).unavailable).toBeUndefined();

        replyWith({ ai: false, tokens: [], unavailable: 'somethingNew' });
        expect((await segmentLine(config, 'ja', '猫は寝る')).unavailable).toBeUndefined();
    });

    it('segmentLine passes the reason through with the fallback tokens', async () => {
        replyWith({ ai: false, tokens: [{ text: '猫' }], unavailable: 'accountUnverified' });
        const result = await segmentLine(config, 'ja', '猫');
        expect(result.ai).toBe(false);
        expect(result.tokens).toEqual([{ text: '猫' }]);
        expect(result.unavailable).toBe('accountUnverified');
    });
});
