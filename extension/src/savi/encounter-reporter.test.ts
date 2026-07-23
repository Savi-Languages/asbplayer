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

describe('SaviEncounterReporter', () => {
    it('reports displayed primary-track lines with lang, text, timing, and episode id', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));

        expect(sent).toEqual([
            {
                command: 'savi-watched-line',
                lang: 'es',
                text: 'No quería hablar de eso',
                episodeId: 'netflix:81234567',
                lineStartMs: 84210,
                occurredAtMs: 1753189200000,
                glossedWords: [],
            },
        ]);
    });

    it('carries the glossed words the line displayed', async () => {
        const { d, sent } = deps({
            glossedLemmas: (text, track) => (text.includes('quería') && track === 0 ? ['quería', 'hablar'] : []),
        });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('No quería hablar de eso'));

        expect(sent[0].glossedWords).toEqual(['quería', 'hablar']);
    });

    it('does not arm when the setting is off', async () => {
        const { d, sent } = deps({ enabled: async () => false });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('hola'));

        expect(sent).toEqual([]);
    });

    it('does not arm without a target language', async () => {
        const { d, sent } = deps({ targetLanguage: async () => '' });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('hola'));

        expect(sent).toEqual([]);
    });

    it('ignores non-primary tracks and blank lines', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();

        reporter.report(line('translation track', 100, 1));
        reporter.report(line('   ', 200, 0));

        expect(sent).toEqual([]);
    });

    it('stops reporting after stop()', async () => {
        const { d, sent } = deps();
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();
        reporter.stop();

        reporter.report(line('hola'));

        expect(sent).toEqual([]);
    });

    it('re-arms on start() after a settings change', async () => {
        let on = false;
        const { d, sent } = deps({ enabled: async () => on });
        const reporter = new SaviEncounterReporter(d);
        await reporter.start();
        reporter.report(line('hola'));
        expect(sent).toEqual([]);

        on = true;
        await reporter.start();
        reporter.report(line('hola'));
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

        expect(() => reporter.report(line('hola'))).not.toThrow();
        // Let the rejected promise settle; an unhandled rejection would fail the test.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
