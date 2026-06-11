import { serializeToSrt } from './subtitle-serializer';

describe('serializeToSrt', () => {
    it('serializes subtitles to SRT blocks with comma-millisecond timestamps', () => {
        const srt = serializeToSrt([
            { text: 'こんにちは', start: 1500, end: 3000, track: 0 },
            { text: 'さようなら', start: 3661001, end: 3662500, track: 0 },
        ]);

        expect(srt).toBe(
            '1\n00:00:01,500 --> 00:00:03,000\nこんにちは\n\n2\n01:01:01,001 --> 01:01:02,500\nさようなら\n'
        );
    });

    it('sorts by start time', () => {
        const srt = serializeToSrt([
            { text: 'second', start: 5000, end: 6000, track: 0 },
            { text: 'first', start: 1000, end: 2000, track: 0 },
        ]);

        expect(srt.indexOf('first')).toBeLessThan(srt.indexOf('second'));
        expect(srt.startsWith('1\n00:00:01,000')).toBe(true);
    });

    it('only serializes the requested track', () => {
        const srt = serializeToSrt(
            [
                { text: 'target language', start: 0, end: 1000, track: 0 },
                { text: 'translation', start: 0, end: 1000, track: 1 },
            ],
            0
        );

        expect(srt).toContain('target language');
        expect(srt).not.toContain('translation');
    });

    it('skips entries without usable text', () => {
        const srt = serializeToSrt([
            { text: '', start: 0, end: 1000, track: 0 },
            { text: '   ', start: 1000, end: 2000, track: 0 },
            { text: 'real line', start: 2000, end: 3000, track: 0 },
        ]);

        expect(srt).toBe('1\n00:00:02,000 --> 00:00:03,000\nreal line\n');
    });

    it('preserves multi-line subtitle text within a block', () => {
        const srt = serializeToSrt([{ text: 'line one\nline two', start: 0, end: 1000, track: 0 }]);
        expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\nline one\nline two\n');
    });

    it('returns an empty string for no subtitles', () => {
        expect(serializeToSrt([])).toBe('');
    });

    it('clamps negative timestamps (possible with a user-applied offset) to zero', () => {
        const srt = serializeToSrt([{ text: 'early', start: -250, end: 750, track: 0 }]);
        expect(srt).toBe('1\n00:00:00,000 --> 00:00:00,750\nearly\n');
    });
});
