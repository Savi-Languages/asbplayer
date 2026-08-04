import { SpeechAccumulator, countSpokenTokens } from './speech-stats';

describe('countSpokenTokens', () => {
    it('counts raw whitespace tokens, the show-simulation WPM convention', () => {
        expect(countSpokenTokens('¿Qué  hora es?')).toBe(3);
        expect(countSpokenTokens('  ')).toBe(0);
        expect(countSpokenTokens('una\nlínea\tpartida')).toBe(3);
    });
});

describe('SpeechAccumulator', () => {
    it('sums shown-cue durations and tokens until drained, primary track only', () => {
        const acc = new SpeechAccumulator();
        acc.addShownSubtitle({ text: 'hola qué tal', start: 0, end: 2_000, track: 0 });
        acc.addShownSubtitle({ text: 'todo bien', start: 5_000, end: 8_500 }); // track defaults to 0
        acc.addShownSubtitle({ text: 'hello there', start: 0, end: 9_000, track: 1 }); // secondary — ignored

        expect(acc.drain()).toEqual({ speakingMs: 5_500, spokenTokenCount: 5 });
    });

    it('drain resets, so each session chunk gets only its own speech', () => {
        const acc = new SpeechAccumulator();
        acc.addShownSubtitle({ text: 'uno', start: 0, end: 1_000 });
        acc.drain();
        acc.addShownSubtitle({ text: 'dos tres', start: 1_000, end: 3_000 });

        expect(acc.drain()).toEqual({ speakingMs: 2_000, spokenTokenCount: 2 });
    });

    it('returns undefined until BOTH halves are positive', () => {
        const empty = new SpeechAccumulator();
        expect(empty.drain()).toBeUndefined();

        const degenerate = new SpeechAccumulator();
        degenerate.addShownSubtitle({ text: 'palabra', start: 1_000, end: 1_000 }); // zero span
        degenerate.addShownSubtitle({ text: '   ', start: 0, end: 1_000 }); // blank text
        expect(degenerate.drain()).toBeUndefined();
    });
});
