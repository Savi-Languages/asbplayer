import { SaviEncounterReporter, EncounterReporterDeps } from './encounter-reporter';

const deps = (overrides: Partial<EncounterReporterDeps> = {}) => {
    const sent: any[] = [];
    const d: EncounterReporterDeps = {
        enabled: async () => true,
        targetLanguage: async () => 'es',
        episodeId: () => 'netflix:81234567',
        glossedLemmas: () => [],
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
            glossedLemmas: (text) => (text.includes('quería') ? ['quería'] : []),
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
                glossedWords: ['quería'],
                hoverGlossedWords: [],
            },
        ]);
    });

    it('samples gloss state at FINALIZE, so late-resolving labels still count', async () => {
        // The gloss settles only after the line opened (the delay-bias case).
        let settled: string[] = [];
        const { d, sent } = deps({ glossedLemmas: () => settled });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        settled = ['hablar']; // label appeared a beat after line start
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].glossedWords).toEqual(['hablar']);
    });

    it('accumulates hover reveals during the display window (incl. the hover-hold)', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));
        reporter.noteHoverReveal('No quería hablar de eso', 'Hablar'); // lowercased + deduped
        reporter.noteHoverReveal('No quería hablar de eso', 'hablar');
        reporter.noteHoverReveal('No quería hablar de eso', 'eso');
        reporter.noteHoverReveal('some other line', 'nope'); // wrong line — ignored
        reporter.report(line('Siguiente', 90000));

        expect(sent[0].hoverGlossedWords).toEqual(['hablar', 'eso']);
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
