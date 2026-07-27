import { SaviEngagementReporter, type EngagementReporterDeps } from './engagement-reporter';
import { SaviEngagementSessionMessage } from './messages';

const WALL0 = 1_753_189_200_000;

interface Harness {
    reporter: SaviEngagementReporter;
    sent: SaviEngagementSessionMessage[];
    /** Advance the monotonic + wall clocks together and tick. */
    play: (seconds: number) => void;
    setSample: (s: {
        playing?: boolean;
        visible?: boolean;
        focused?: boolean;
        everPlayed?: boolean;
        ended?: boolean;
    }) => void;
    send: jest.Mock;
}

function harness(over: Partial<EngagementReporterDeps> = {}, sendImpl?: jest.Mock): Harness {
    const sent: SaviEngagementSessionMessage[] = [];
    let now = 0;
    let sample: {
        playing: boolean;
        visible: boolean;
        focused: boolean;
        everPlayed?: boolean;
        ended?: boolean;
    } = { playing: true, visible: true, focused: true };
    let ids = 0;

    const send =
        sendImpl ??
        (jest.fn(async (m: SaviEngagementSessionMessage) => {
            sent.push(m);
            return { ok: true };
        }) as unknown as jest.Mock);

    const reporter = new SaviEngagementReporter({
        enabled: async () => true,
        targetLanguage: async () => 'es',
        episodeId: () => 'netflix:80209013',
        lastInteractionAt: () => 0,
        send: send as unknown as EngagementReporterDeps['send'],
        now: () => now,
        wallNow: () => WALL0 + now,
        newId: () => `id-${++ids}`,
        ...over,
    });

    return {
        reporter,
        sent,
        send: send as jest.Mock,
        setSample: (s) => {
            sample = { ...sample, ...s };
        },
        play: (seconds) => {
            for (let i = 0; i < seconds; i++) {
                reporter.tick({ ...sample });
                now += 1_000;
            }
            reporter.tick({ ...sample });
        },
    };
}

describe('SaviEngagementReporter', () => {
    it('stamps id, lang, source and tz offset onto a flushed block', async () => {
        const h = harness();
        await h.reporter.start();
        h.play(30);
        h.reporter.flush();

        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatchObject({
            command: 'savi-engagement-session',
            id: 'id-1',
            kind: 'watch',
            lang: 'es',
            source: 'watch:netflix:80209013',
            engagedMs: 30_000,
        });
        // The offset must be present and sane — it can never be recovered later.
        expect(h.sent[0].tzOffsetMin).toBe(-new Date().getTimezoneOffset());
    });

    it('reports a backgrounded video as listen, not watch', async () => {
        // SV-21's core distinction: only the audio is reaching the user.
        const h = harness();
        await h.reporter.start();
        h.play(20);
        h.setSample({ visible: false });
        h.play(20);
        h.reporter.flush();

        expect(h.sent.map((m) => m.kind)).toEqual(['watch', 'listen']);
        // Same episode under both kinds — the method axis is unchanged.
        expect(new Set(h.sent.map((m) => m.source))).toEqual(new Set(['watch:netflix:80209013']));
    });

    it('mints a fresh id per block — a reused id would be silently deduped away', async () => {
        const h = harness();
        await h.reporter.start();
        h.play(20);
        h.setSample({ visible: false });
        h.play(20);
        h.reporter.flush();

        expect(new Set(h.sent.map((m) => m.id)).size).toBe(h.sent.length);
    });

    it('stays disarmed without the setting or a target language', async () => {
        const off = harness({ enabled: async () => false });
        await off.reporter.start();
        off.play(60);
        off.reporter.flush();
        expect(off.sent).toEqual([]);

        const noLang = harness({ targetLanguage: async () => '' });
        await noLang.reporter.start();
        noLang.play(60);
        noLang.reporter.flush();
        expect(noLang.sent).toEqual([]);
    });

    it('discards time accrued before it learned it was disarmed', async () => {
        // start() resolves asynchronously; anything ticked meanwhile belongs to
        // a user who never opted in.
        const h = harness({ enabled: async () => false });
        h.play(60);
        await h.reporter.start();
        h.reporter.flush();
        expect(h.sent).toEqual([]);
    });

    it('retries once when the background reports a daemon failure', async () => {
        // The background answers { ok: false } rather than rejecting, so a
        // catch-only retry would miss exactly the case worth retrying.
        let calls = 0;
        const send = jest.fn(async (_message: SaviEngagementSessionMessage) => {
            calls++;
            return calls === 1 ? { ok: false } : { ok: true };
        });
        const h = harness({}, send as unknown as jest.Mock);
        await h.reporter.start();
        h.play(30);
        h.reporter.flush();
        await Promise.resolve();
        await Promise.resolve();

        expect(send).toHaveBeenCalledTimes(2);
        const [first, second] = send.mock.calls.map((c) => c[0]);
        // Same id both times, so a first attempt that actually landed is
        // deduped daemon-side instead of double-credited.
        expect(second.id).toBe(first.id);
    });

    it('gives up after one retry instead of looping', async () => {
        const send = jest.fn(async (_message: SaviEngagementSessionMessage) => ({ ok: false }));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const h = harness({}, send as unknown as jest.Mock);
        await h.reporter.start();
        h.play(30);
        h.reporter.flush();
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(send).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it('stop() flushes the tail and then goes quiet', async () => {
        const h = harness();
        await h.reporter.start();
        h.play(30);
        h.reporter.stop();
        expect(h.sent).toHaveLength(1);

        h.play(60);
        h.reporter.flush();
        expect(h.sent).toHaveLength(1);
    });

    it('counts a paused video while the user is interacting', async () => {
        // The founder's rule: hovering a word on a paused line is studying.
        let interaction = 0;
        let now = 0;
        const sent: SaviEngagementSessionMessage[] = [];
        const reporter = new SaviEngagementReporter({
            enabled: async () => true,
            targetLanguage: async () => 'es',
            episodeId: () => 'ep',
            lastInteractionAt: () => interaction,
            send: async (m) => {
                sent.push(m);
                return { ok: true };
            },
            now: () => now,
            wallNow: () => WALL0 + now,
            newId: () => 'id',
        });
        await reporter.start();

        for (let i = 0; i < 31; i++) {
            interaction = now; // still hovering
            reporter.tick({ playing: false, visible: true, focused: true });
            now += 1_000;
        }
        reporter.flush();

        expect(sent).toHaveLength(1);
        expect(sent[0].engagedMs).toBe(30_000);
        expect(sent[0].kind).toBe('watch');
    });
});

describe('media-state passthrough', () => {
    // The regression this exists for: `everPlayed`/`ended` were added to the
    // clock and passed from the binding, but `PlaybackSample` never carried
    // them and `tick` never forwarded them — so the fix that was supposed to
    // stop counting the Netflix lobby and the credits did nothing at all.
    // Jest transpiles without typechecking, so the whole suite stayed green.
    // This asserts the wiring at RUNTIME, where types could not.

    it('does not credit a paused page that has never played', async () => {
        const h = harness();
        await h.reporter.start();
        h.setSample({ playing: false, everPlayed: false });
        h.play(120); // two minutes browsing a title, mouse moving
        h.reporter.flush();
        expect(h.sent).toHaveLength(0);
    });

    it('does not credit a paused page once playback has ended', async () => {
        const h = harness();
        await h.reporter.start();
        h.setSample({ playing: false, everPlayed: true, ended: true });
        h.play(120); // sitting on the credits
        h.reporter.flush();
        expect(h.sent).toHaveLength(0);
    });

    it('still credits a pause INSIDE a viewing', async () => {
        // The half that must survive: pausing to study a line is learning.
        // Kept inside the 60 s idle window — the harness pins the last
        // interaction at 0, so a longer pause would stop for that reason
        // instead and the test would pass without proving anything.
        const h = harness();
        await h.reporter.start();
        h.setSample({ playing: false, everPlayed: true, ended: false });
        h.play(50);
        h.reporter.flush();
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0].engagedMs).toBeGreaterThan(30_000);
    });
});
