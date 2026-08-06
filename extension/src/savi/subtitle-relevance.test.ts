import { significantTokens, titlesOverlap } from './subtitle-relevance';

describe('significantTokens', () => {
    it('drops stopwords, release noise, and bare numbers', () => {
        expect(significantTokens('The Matrix HD x264 1999')).toEqual(['matrix']);
    });

    it('splits on punctuation and lowercases', () => {
        expect(significantTokens('Hussain_ Who Said No')).toEqual(['hussain', 'who', 'said', 'no']);
    });

    it('is empty for text with nothing identifying', () => {
        expect(significantTokens('the and of')).toEqual([]);
    });
});

describe('titlesOverlap', () => {
    // The real case: a YouTube comedy song loaded an unrelated film's subtitles
    // because nothing compared the result back to what was asked for.
    it('rejects the unrelated film that started this', () => {
        expect(
            titlesOverlap('Garfunkel and Oates - Pregnant Women Are Smug', 'Hussain_ Who Said No HD (English . +20 Subs)')
        ).toBe(false);
    });

    it('accepts a genuine match despite release-name noise', () => {
        expect(titlesOverlap('Breaking Bad', 'Breaking.Bad.S01E01.720p.BluRay.x264.srt')).toBe(true);
    });

    it('accepts a partial but substantial match', () => {
        expect(titlesOverlap('El Laberinto del Fauno', 'El.Laberinto.del.Fauno.2006.DVDRip.srt')).toBe(true);
    });

    it('rejects when only a token or two incidentally coincide', () => {
        expect(titlesOverlap('Money Heist La Casa de Papel', 'The Heist of the Century 2020.srt')).toBe(false);
    });

    it('rejects a missing candidate', () => {
        expect(titlesOverlap('Breaking Bad', undefined)).toBe(false);
        expect(titlesOverlap('Breaking Bad', '')).toBe(false);
    });

    it('rejects when the query carries no identity, rather than matching anything', () => {
        // Otherwise an empty wanted-set would trivially satisfy the threshold.
        expect(titlesOverlap('the and of', 'Literally Anything.srt')).toBe(false);
    });

    it('is case- and punctuation-insensitive', () => {
        expect(titlesOverlap('AMÉLIE', 'amélie.2001.srt')).toBe(true);
    });
});
