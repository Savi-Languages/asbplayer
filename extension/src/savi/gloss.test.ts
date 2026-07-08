import { buildGlossHtml, glossableLemmas, isContentWord, isGlossableLanguage, segmentLine } from './gloss';

describe('isGlossableLanguage', () => {
    it('accepts space-delimited (Latin-script) languages by primary subtag', () => {
        expect(isGlossableLanguage('es')).toBe(true);
        expect(isGlossableLanguage('es-419')).toBe(true);
        expect(isGlossableLanguage('fr')).toBe(true);
        expect(isGlossableLanguage('pt-BR')).toBe(true);
    });

    it('rejects languages that need a morphological analyzer (and the empty string)', () => {
        // Japanese is served by the hover dictionary, not client-side glossing.
        expect(isGlossableLanguage('ja')).toBe(false);
        expect(isGlossableLanguage('zh-Hant')).toBe(false);
        expect(isGlossableLanguage('ko')).toBe(false);
        expect(isGlossableLanguage('th')).toBe(false);
        expect(isGlossableLanguage('')).toBe(false);
    });
});

describe('isContentWord', () => {
    it('treats non-stopwords of 2+ letters as content', () => {
        expect(isContentWord('quiero')).toBe(true);
        expect(isContentWord('gato')).toBe(true);
    });

    it('treats Spanish function words and single letters as non-content', () => {
        expect(isContentWord('de')).toBe(false);
        expect(isContentWord('que')).toBe(false);
        expect(isContentWord('el')).toBe(false);
        expect(isContentWord('a')).toBe(false); // single letter
        expect(isContentWord('y')).toBe(false);
    });
});

describe('segmentLine', () => {
    it('splits into word/gap segments that concatenate back to the line', () => {
        const line = 'Yo no quería hablar con ella, ¿sabes?';
        const segments = segmentLine(line);
        expect(segments.map((s) => s.text).join('')).toBe(line);
    });

    it('handles accents and ñ as word characters, punctuation as gaps', () => {
        const segments = segmentLine('el niño comió');
        const words = segments.filter((s) => s.word).map((s) => s.text);
        expect(words).toEqual(['el', 'niño', 'comió']);
        // Lemma is the lowercased surface (matching the es analyzer today).
        const nino = segments.find((s) => s.text === 'niño');
        expect(nino?.lemma).toBe('niño');
    });

    it('marks content words vs function words', () => {
        const segments = segmentLine('Yo quiero comer con el gato');
        const content = segments.filter((s) => s.content).map((s) => s.lemma);
        expect(content).toEqual(['quiero', 'comer', 'gato']); // yo/con/el dropped
    });
});

describe('glossableLemmas', () => {
    it('returns distinct content lemmas, skipping known ones', () => {
        const segments = segmentLine('el gato y el perro y el gato');
        expect(glossableLemmas(segments, new Set())).toEqual(['gato', 'perro']); // deduped, el/y dropped
        expect(glossableLemmas(segments, new Set(['gato']))).toEqual(['perro']); // gato is known
    });
});

describe('buildGlossHtml', () => {
    it('wraps only glossed words in ruby and leaves the rest as text', () => {
        const segments = segmentLine('quiero un gato');
        const html = buildGlossHtml(segments, (lemma) => (lemma === 'gato' ? 'cat' : undefined));
        expect(html).toContain('<ruby class="asb-gloss">gato<rt>cat</rt></ruby>');
        // 'quiero' had no gloss resolved → stays plain; 'un' is a stopword → plain.
        expect(html).not.toContain('quiero<rt>');
        // Dropping the <rt> labels then the tags reproduces the base line (the
        // <rt> gloss IS part of the rendered text content — why the JA hover path
        // must skip <rt>, and why gloss is scoped to non-JA languages).
        const baseText = html.replace(/<rt>.*?<\/rt>/g, '').replace(/<[^>]+>/g, '');
        expect(baseText).toBe('quiero un gato');
    });

    it('returns empty string when nothing was glossed (caller keeps plain text)', () => {
        const segments = segmentLine('quiero un gato');
        expect(buildGlossHtml(segments, () => undefined)).toBe('');
    });

    it('escapes HTML in the gloss and in gap text', () => {
        const segments = segmentLine('gato & perro');
        const html = buildGlossHtml(segments, (lemma) => (lemma === 'gato' ? '<b>cat</b>' : undefined));
        expect(html).toContain('&lt;b&gt;cat&lt;/b&gt;'); // gloss escaped, not injected as markup
        expect(html).not.toContain('<b>');
        expect(html).toContain(' &amp; '); // the '&' gap is escaped
    });
});
