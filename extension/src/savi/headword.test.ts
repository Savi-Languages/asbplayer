import { SaviDictEntry, SaviToken } from './daemon-client';
import { headwordReading } from './headword';

const tok = (text: string, reading?: string, lemma?: string): SaviToken => ({ text, reading, lemma });
const entry = (kanji: string[], readings: string[]): SaviDictEntry => ({ kanji, readings, senses: [] });

describe('headwordReading', () => {
    // The regression: hovering 負って showed the dictionary form 負う with the
    // CONJUGATED stem's reading おっ pinned under it.
    it('reads the lemma, not the surface, on an inflected word', () => {
        expect(headwordReading('負う', tok('負っ', 'おっ', '負う'), [entry(['負う'], ['おう'])])).toBe('おう');
    });

    it('keeps the surface reading when the headword IS the surface', () => {
        expect(headwordReading('容疑者', tok('容疑者', 'ようぎしゃ'), [])).toBe('ようぎしゃ');
    });

    it('prefers the entry that actually spells the headword', () => {
        const entries = [entry(['追う'], ['おう']), entry(['負う'], ['おう', 'おふ'])];
        expect(headwordReading('負う', tok('負っ', 'おっ', '負う'), entries)).toBe('おう');
    });

    it('prints nothing when no entry lists the displayed headword spelling', () => {
        expect(headwordReading('見ル', tok('見', 'み', '見ル'), [entry(['見る'], ['みる'])])).toBeUndefined();
    });

    it('prints nothing rather than a wrong reading when no entry matched', () => {
        expect(headwordReading('負う', tok('負っ', 'おっ', '負う'), [])).toBeUndefined();
    });

    it('omits the reading for a kana headword', () => {
        expect(headwordReading('しかし', tok('しかし', 'しかし'), [entry([], ['しかし'])])).toBeUndefined();
        expect(headwordReading('そこ', tok('そこ'), [])).toBeUndefined();
    });

    it('omits a kana-only entry reading for an inflected kana word', () => {
        expect(headwordReading('する', tok('し', 'し', 'する'), [entry([], ['する'])])).toBeUndefined();
    });
});
