import { SaviEncounterReporter, EncounterReporterDeps } from './encounter-reporter';

const deps = (overrides: Partial<EncounterReporterDeps> = {}) => {
    const sent: any[] = [];
    const d: EncounterReporterDeps = {
        enabled: async () => true,
        targetLanguage: async () => 'es',
        episodeId: () => 'netflix:81234567',
        glossedEntries: () => [],
        send: async (message) => {
            sent.push(message);
        },
        now: () => 1753189200000,
        ...overrides,
    };
    return { d, sent };
};

const line = (text: string, start = 84210, track = 0) => ({ text, start, track });

describe('SaviEncounterReporter (line lifecycle)', () => {
    it('finalizes a line when the NEXT line starts, with full context', async () => {
        const { d, sent } = deps({
            glossedEntries: (text) =>
                text.includes('quería') ? [{ word: 'quería', gloss: 'wanted' }] : [],
        });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        expect(sent).toEqual([]); // display window still open — nothing sent yet

        reporter.report(line('Otra frase distinta', 90000));
        expect(sent).toEqual([
            {
                command: 'savi-watched-line',
                lang: 'es',
                text: 'No quería hablar de eso',
                episodeId: 'netflix:81234567',
                lineStartMs: 84210,
                occurredAtMs: 1753189200000,
                glossedWords: [{ word: 'quería', gloss: 'wanted' }],
                hoverGlossedWords: [],
            },
        ]);
    });

    it('samples gloss state at FINALIZE, so late-resolving labels still count', async () => {
        // The gloss settles only after the line opened (the delay-bias case).
        let settled: { word: string; gloss: string }[] = [];
        const { d, sent } = deps({ glossedEntries: () => settled });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        settled = [{ word: 'hablar', gloss: 'to talk' }]; // label appeared a beat after line start
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].glossedWords).toEqual([{ word: 'hablar', gloss: 'to talk' }]);
    });

    it('accumulates hover reveals with labels during the display window (incl. the hover-hold)', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.noteHoverReveal('No quería hablar de eso', 'Hablar', 'to speak'); // lowercased + deduped
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to talk'); // latest label wins
        reporter.noteHoverReveal('No quería hablar de eso', 'eso'); // no label captured → ''
        reporter.noteHoverReveal('some other line', 'nope', 'x'); // wrong line — ignored
        reporter.report(line('Siguiente', 90000));

        // dwellMs 0: these reveals were never ended, so finalize closes them
        // against the same frozen clock they opened on.
        expect(sent[0].hoverGlossedWords).toEqual([
            { word: 'hablar', gloss: 'to talk', dwellMs: 0 },
            { word: 'eso', gloss: '', dwellMs: 0 },
        ]);
    });

    it('measures hover dwell from the moment the label rendered', async () => {
        // The clock starts at noteHoverReveal, which the hover controllers call
        // only once the REAL label has replaced the placeholder — so a slow
        // translation inflates nothing.
        let clock = 1753189200000;
        const { d, sent } = deps({ now: () => clock });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to talk');
        clock += 1500;
        reporter.noteHoverRevealEnd('No quería hablar de eso', 'hablar');
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].hoverGlossedWords).toEqual([{ word: 'hablar', gloss: 'to talk', dwellMs: 1500 }]);
    });

    it('keeps the LONGEST continuous reveal, never the sum of flicks', async () => {
        // Three 400ms passes over a word are three flicks, not a 1.2s study.
        // Summing them would hand the very gesture the threshold exists to
        // filter a way through it.
        let clock = 1753189200000;
        const { d, sent } = deps({ now: () => clock });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        for (const ms of [400, 900, 400]) {
            reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to talk');
            clock += ms;
            reporter.noteHoverRevealEnd('No quería hablar de eso', 'hablar');
        }
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].hoverGlossedWords).toEqual([{ word: 'hablar', gloss: 'to talk', dwellMs: 900 }]);
    });

    it('closes a reveal that is still open when the line finalizes', async () => {
        // The end-of-line hover-hold pauses playback precisely so the user can
        // keep reading past the cue. That dwell is the most important dwell
        // there is, and it has no reveal-end event of its own.
        let clock = 1753189200000;
        const { d, sent } = deps({ now: () => clock });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to talk');
        clock += 2000; // still hovering when the next line arrives
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].hoverGlossedWords).toEqual([{ word: 'hablar', gloss: 'to talk', dwellMs: 2000 }]);
    });

    it('reports no dwell at all for a reveal the user mined from', async () => {
        // Mining is collection, not failed recall. Omitting the dwell (rather
        // than sending 0) is what puts the row on the pre-2026-08 treatment
        // instead of asserting a measurement we are choosing not to make.
        let clock = 1753189200000;
        const { d, sent } = deps({ now: () => clock });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to talk');
        clock += 5000;
        reporter.noteHoverRetract('No quería hablar de eso', 'hablar');
        reporter.noteHoverRevealEnd('No quería hablar de eso', 'hablar');
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].hoverGlossedWords).toEqual([{ word: 'hablar', gloss: 'to talk' }]);
    });

    it('keeps a reveal retracted when a later reveal of the same word arrives', async () => {
        // The Japanese path re-reveals: opening the study panel records the
        // dictionary headline, then overwrites it when the AI in-context gloss
        // lands. Both arrive AFTER the retraction, and neither may resurrect
        // the dwell — otherwise mining a word would still lapse its card.
        let clock = 1753189200000;
        const { d, sent } = deps({ now: () => clock });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to talk');
        reporter.noteHoverRetract('No quería hablar de eso', 'hablar');
        clock += 4000;
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar', 'to speak');
        clock += 4000;
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].hoverGlossedWords).toEqual([{ word: 'hablar', gloss: 'to speak' }]);
    });

    it('captures the episode id at OPEN time (SPA episode change safety)', async () => {
        let episode = 'netflix:ep1';
        const { d, sent } = deps({ episodeId: () => episode });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('última frase del episodio'));
        episode = 'netflix:ep2'; // SPA navigated before the line finalized
        reporter.flush();

        expect(sent[0].episodeId).toBe('netflix:ep1');
    });

    it('stop() flushes the pending line', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('frase final'));
        reporter.stop();

        expect(sent).toHaveLength(1);
        expect(sent[0].text).toBe('frase final');

        // Disarmed after stop — nothing new opens.
        reporter.report(line('tras el stop'));
        reporter.flush();
        expect(sent).toHaveLength(1);
    });

    it('does not arm when the setting is off or without a target language', async () => {
        for (const override of [
            { enabled: async () => false },
            { targetLanguage: async () => '' },
        ] as Partial<EncounterReporterDeps>[]) {
            const { d, sent } = deps(override);
            const reporter = new SaviEncounterReporter(d);
            await reporter.start();
            reporter.report(line('hola'));
            reporter.flush();
            expect(sent).toEqual([]);
        }
    });

    it('ignores non-primary tracks and blank lines', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('translation track', 100, 1));
        reporter.report(line('   ', 200, 0));
        reporter.flush();

        expect(sent).toEqual([]);
    });

    it('re-arms on start() after a settings change', async () => {
        let on = false;
        const { d, sent } = deps({ enabled: async () => on });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();
        reporter.report(line('hola'));
        reporter.flush();
        expect(sent).toEqual([]);

        on = true;
        await reporter.start();
        reporter.report(line('hola'));
        reporter.flush();
        expect(sent).toHaveLength(1);
    });

    it('swallows send failures — playback must never be affected', async () => {
        const { d } = deps({
            send: async () => {
                throw new Error('daemon down');
            },
        });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('hola'));
        expect(() => reporter.flush()).not.toThrow();
        // Let the rejected promise settle; an unhandled rejection would fail the test.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});

// ── SV-40: a dead daemon must be LOUD, never silent data loss ───────────────
//
// The reporter is deliberately fire-and-forget because the daemon is the
// outbox — but that only holds while the daemon is actually reachable. With it
// off, every watched line was swallowed by a console.debug: an entire episode
// of exposure could vanish with nothing on screen to say so.

describe('SaviEncounterReporter (delivery failure)', () => {
    // `_finalize` chains .then().catch() onto an async send, so the callbacks
    // land several microtasks deep. Drain the queue rather than counting ticks.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const failing = () => deps({ send: async () => Promise.reject(new Error('ECONNREFUSED')) });

    it('reports a delivery failure to the host so it can be surfaced', async () => {
        const failures: number[] = [];
        const { d } = failing();
        const reporter = new SaviEncounterReporter({
            ...d,
            onDeliveryFailure: (consecutive) => failures.push(consecutive),
        });
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.report(line('Otra frase distinta', 90000)); // finalizes the first
        await flush();

        expect(failures).toEqual([1]);
    });

    it('clears the alarm once delivery recovers', async () => {
        let fail = true;
        const events: string[] = [];
        const { d } = deps({
            send: async () => (fail ? Promise.reject(new Error('ECONNREFUSED')) : undefined),
        });
        const reporter = new SaviEncounterReporter({
            ...d,
            onDeliveryFailure: () => events.push('fail'),
            onDeliveryRecovered: () => events.push('ok'),
        });
        await reporter.start();

        reporter.report(line('Uno'));
        reporter.report(line('Dos', 90000));
        await flush();

        fail = false;
        reporter.report(line('Tres', 95000));
        await flush();

        expect(events).toEqual(['fail', 'ok']);
    });
});
