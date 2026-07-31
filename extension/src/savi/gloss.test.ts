import {
    buildGlossHtml,
    glossCandidates,
    glossableLemmas,
    glossedEntriesFromHtml,
    glossedLemmasFromHtml,
    isContentWord,
    isGlossableLanguage,
    isReasonableGloss,
    labelsFrom,
    segmentLine,
} from './gloss';

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

    it('glosses common lexical adverbs, which are vocabulary not grammar', () => {
        // The founder found "más" in "no sé qué más querés" silently
        // unglossable — no label, no translate request, and absent from the
        // word list, because savi-core's ingest filter dropped it before an
        // encounter was ever written. These are A1 vocabulary, not structural
        // glue; they self-resolve once the gloss threshold sees them learned.
        for (const word of ['más', 'bien', 'muy', 'también', 'tampoco', 'algo', 'así', 'aunque', 'según']) {
            expect(isContentWord(word)).toBe(true);
        }
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

describe('segmentLine — proper nouns', () => {
    it('does not gloss a capitalized word mid-sentence (a name)', () => {
        const segments = segmentLine('Llegué a pensar que Elena bromeaba.');
        const elena = segments.find((s) => s.text === 'Elena');
        expect(elena?.properNoun).toBe(true);
        expect(elena?.content).toBe(false);
        expect(glossableLemmas(segments, new Set())).not.toContain('elena');
        // ...but ordinary content words are still glossed.
        expect(glossableLemmas(segments, new Set())).toEqual(['llegué', 'pensar', 'bromeaba']);
    });

    it('keeps a sentence-initial capital as an ordinary word', () => {
        const segments = segmentLine('Quiero comer.');
        const quiero = segments.find((s) => s.text === 'Quiero');
        expect(quiero?.properNoun).toBe(false);
        expect(glossableLemmas(segments, new Set())).toContain('quiero');
    });

    it('treats a capital after a sentence boundary as a new sentence start', () => {
        // 'Vino' starts the second sentence → ordinary; 'Madrid' mid-sentence → name.
        const segments = segmentLine('Comí. Vino desde Madrid.');
        expect(segments.find((s) => s.text === 'Vino')?.properNoun).toBe(false);
        expect(segments.find((s) => s.text === 'Madrid')?.properNoun).toBe(true);
    });
});

describe('glossableLemmas', () => {
    it('returns distinct content lemmas, skipping known ones', () => {
        const segments = segmentLine('el gato y el perro y el gato');
        expect(glossableLemmas(segments, new Set())).toEqual(['gato', 'perro']); // deduped, el/y dropped
        expect(glossableLemmas(segments, new Set(['gato']))).toEqual(['perro']); // gato is known
    });
});

describe('isReasonableGloss', () => {
    it('accepts a word or short phrase', () => {
        expect(isReasonableGloss('bank')).toBe(true);
        expect(isReasonableGloss('after-dinner conversation')).toBe(true);
    });

    it('rejects an empty gloss and an LLM ramble (too long / too many words)', () => {
        expect(isReasonableGloss('')).toBe(false);
        expect(isReasonableGloss('   ')).toBe(false);
        const ramble =
            'term of endearment or a colloquialism, however in this case it is likely being used affectionately';
        expect(isReasonableGloss(ramble)).toBe(false);
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

describe('glossedLemmasFromHtml', () => {
    it('extracts exactly the words the settled HTML wraps in gloss ruby', () => {
        const segments = segmentLine('Quiero un gato bonito, gato mío');
        const html = buildGlossHtml(segments, (lemma) =>
            lemma === 'gato' ? 'cat' : lemma === 'bonito' ? 'pretty' : undefined
        );
        expect(glossedLemmasFromHtml(html)).toEqual(['gato', 'bonito']); // deduped, lowercased
    });

    it('is empty for plain (un-glossed) lines', () => {
        expect(glossedLemmasFromHtml('')).toEqual([]);
        expect(glossedLemmasFromHtml('nada que ver aquí')).toEqual([]);
    });
});

describe('glossedEntriesFromHtml (SV-20)', () => {
    it('extracts each glossed word WITH its displayed label', () => {
        const segments = segmentLine('Quiero un gato bonito, gato mío');
        const html = buildGlossHtml(segments, (lemma) =>
            lemma === 'gato' ? 'cat' : lemma === 'bonito' ? 'pretty' : undefined
        );
        expect(glossedEntriesFromHtml(html)).toEqual([
            { word: 'gato', gloss: 'cat' },
            { word: 'bonito', gloss: 'pretty' },
        ]);
    });

    it('unescapes label text that was HTML-escaped at render time', () => {
        const segments = segmentLine('Ley de oferta');
        const html = buildGlossHtml(segments, (lemma) =>
            lemma === 'ley' ? 'law & order' : undefined
        );
        expect(html).toContain('law &amp; order'); // escaped in the markup…
        expect(glossedEntriesFromHtml(html)[0]).toEqual({ word: 'ley', gloss: 'law & order' }); // …raw out
    });

    it('is empty for plain lines', () => {
        expect(glossedEntriesFromHtml('')).toEqual([]);
        expect(glossedEntriesFromHtml('nada que ver aquí')).toEqual([]);
    });
});

describe('glossable ⊆ reviewable', () => {
    it('does not gloss conjugations whose lemma is a function word', () => {
        // savi-core drops these (lemma ser/estar/haber is a stopword), so
        // glossing them would label a word on screen that can never enter
        // review — the founder's "voy" worry, with the examples that really
        // do fall through.
        for (const aux of ['seré', 'estuvieron', 'estaban', 'habría', 'siendo']) {
            expect(isContentWord(aux)).toBe(false);
        }
    });

    it('mirrors savi-core exactly, so nothing glossable is unreviewable', () => {
        // This set must never be NARROWER than savi-core's STOPWORDS. When the
        // nine lexical adverbs were freed, BOTH lists had to move together —
        // freeing only savi-core would have left them tracked but never
        // labelled, and freeing only this one would label a word that can
        // never enter review.
        for (const structural of ['el', 'la', 'de', 'que', 'y', 'se', 'lo', 'por', 'para']) {
            expect(isContentWord(structural)).toBe(false);
        }
    });

    it('still glosses real verbs, including ambiguous ones', () => {
        // "voy" → ir, a content verb: glossable AND reviewable, so it must
        // keep its label. "fuimos" maps to both ir and ser — the ir reading
        // makes it reviewable, so it stays glossable too.
        for (const word of ['voy', 'fuimos', 'corriendo', 'llevar']) {
            expect(isContentWord(word)).toBe(true);
        }
    });
});

// ── SV-40: the server decides, the client renders ──────────────────────────

describe('glossCandidates', () => {
    it('sends distinct content surfaces, dropping punctuation and proper nouns', () => {
        const segments = segmentLine('Yo no sabía nada, Elena. ¿Sabía algo?');
        // `sabía` twice → sent once; `Elena` mid-sentence → a proper noun;
        // `no` → a structural function word the server needn't be asked about.
        expect(glossCandidates(segments)).toEqual(['sabía', 'nada', 'algo']);
    });
});

describe('labelsFrom', () => {
    // The regression this whole endpoint exists for: a conjugation of a known
    // lemma must come back skipped, and therefore carry NO label — even though
    // its surface has never been seen before.
    it('labels only the words the server did not skip', () => {
        // The skipped words carry a label ON PURPOSE: `skip` must be what
        // excludes them, not the incidental absence of a gloss. Without this,
        // the test passes even for an implementation that ignores `skip`.
        const labels = labelsFrom([
            { word: 'sabía', lemma: 'saber', skip: 'known', proficiency: 0.97, gloss: 'knew' },
            { word: 'nada', lemma: 'nada', proficiency: 0.12, gloss: 'nothing' },
            { word: 'estuvieron', lemma: 'estar', skip: 'function-word', gloss: 'they were' },
        ]);

        expect(labels.get('sabía')).toBeUndefined();
        expect(labels.get('estuvieron')).toBeUndefined();
        expect(labels.get('nada')).toBe('nothing');
    });

    it('drops an LLM ramble rather than rendering a paragraph over a word', () => {
        const rambling = 'This word has several senses: (1) nothing, (2) not at all, (3) swim.';
        const labels = labelsFrom([{ word: 'nada', lemma: 'nada', gloss: rambling }]);

        expect(labels.get('nada')).toBeUndefined();
    });

    it('matches the server echo case-insensitively', () => {
        // The client sends lowercased surfaces but renders the original text,
        // so the join must survive a capitalised sentence-initial word.
        const labels = labelsFrom([{ word: 'sabía', lemma: 'saber', gloss: 'knew' }]);

        expect(labels.get('Sabía'.toLowerCase())).toBe('knew');
    });
});
