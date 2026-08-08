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
    skipSummary,
    SaviGlossController,
    segmentLine,
} from './gloss';

// The only thing `gloss.ts` pulls from cloud-settings, and the one piece of
// `start()` that needs a signed-in browser. Stubbed so the lifecycle tests
// below can reach the code after the early return; every other test in this
// file runs with glossing off and never touches it. Mutable because the
// controller re-reads it per line (the stale-language fix) — a test flips it
// mid-session to prove the change is picked up without a rebind.
let mockTargetLanguage = 'es';
jest.mock('./cloud-settings', () => ({
    getCachedRoamingSettings: async () => ({ targetLanguage: mockTargetLanguage }),
}));

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
        expect(isContentWord('quiero', 'es')).toBe(true);
        expect(isContentWord('gato', 'es')).toBe(true);
    });

    it('treats Spanish function words and single letters as non-content', () => {
        expect(isContentWord('de', 'es')).toBe(false);
        expect(isContentWord('que', 'es')).toBe(false);
        expect(isContentWord('el', 'es')).toBe(false);
        expect(isContentWord('a', 'es')).toBe(false); // single letter
        expect(isContentWord('y', 'es')).toBe(false);
    });

    it('glosses common lexical adverbs, which are vocabulary not grammar', () => {
        // The founder found "más" in "no sé qué más querés" silently
        // unglossable — no label, no translate request, and absent from the
        // word list, because savi-core's ingest filter dropped it before an
        // encounter was ever written. These are A1 vocabulary, not structural
        // glue; they self-resolve once the gloss threshold sees them learned.
        for (const word of ['más', 'bien', 'muy', 'también', 'tampoco', 'algo', 'así', 'aunque', 'según']) {
            expect(isContentWord(word, 'es')).toBe(true);
        }
    });
});

describe('segmentLine', () => {
    it('splits into word/gap segments that concatenate back to the line', () => {
        const line = 'Yo no quería hablar con ella, ¿sabes?';
        const segments = segmentLine(line, 'es');
        expect(segments.map((s) => s.text).join('')).toBe(line);
    });

    it('handles accents and ñ as word characters, punctuation as gaps', () => {
        const segments = segmentLine('el niño comió', 'es');
        const words = segments.filter((s) => s.word).map((s) => s.text);
        expect(words).toEqual(['el', 'niño', 'comió']);
        // Lemma is the lowercased surface (matching the es analyzer today).
        const nino = segments.find((s) => s.text === 'niño');
        expect(nino?.lemma).toBe('niño');
    });

    it('marks content words vs function words', () => {
        const segments = segmentLine('Yo quiero comer con el gato', 'es');
        const content = segments.filter((s) => s.content).map((s) => s.lemma);
        expect(content).toEqual(['quiero', 'comer', 'gato']); // yo/con/el dropped
    });
});

describe('segmentLine — proper nouns', () => {
    it('does not gloss a capitalized word mid-sentence (a name)', () => {
        const segments = segmentLine('Llegué a pensar que Elena bromeaba.', 'es');
        const elena = segments.find((s) => s.text === 'Elena');
        expect(elena?.properNoun).toBe(true);
        expect(elena?.content).toBe(false);
        expect(glossableLemmas(segments, new Set())).not.toContain('elena');
        // ...but ordinary content words are still glossed.
        expect(glossableLemmas(segments, new Set())).toEqual(['llegué', 'pensar', 'bromeaba']);
    });

    it('keeps a sentence-initial capital as an ordinary word', () => {
        const segments = segmentLine('Quiero comer.', 'es');
        const quiero = segments.find((s) => s.text === 'Quiero');
        expect(quiero?.properNoun).toBe(false);
        expect(glossableLemmas(segments, new Set())).toContain('quiero');
    });

    it('treats a capital after a sentence boundary as a new sentence start', () => {
        // 'Vino' starts the second sentence → ordinary; 'Madrid' mid-sentence → name.
        const segments = segmentLine('Comí. Vino desde Madrid.', 'es');
        expect(segments.find((s) => s.text === 'Vino')?.properNoun).toBe(false);
        expect(segments.find((s) => s.text === 'Madrid')?.properNoun).toBe(true);
    });
});

describe('glossableLemmas', () => {
    it('returns distinct content lemmas, skipping known ones', () => {
        const segments = segmentLine('el gato y el perro y el gato', 'es');
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
        const segments = segmentLine('quiero un gato', 'es');
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
        const segments = segmentLine('quiero un gato', 'es');
        expect(buildGlossHtml(segments, () => undefined)).toBe('');
    });

    it('escapes HTML in the gloss and in gap text', () => {
        const segments = segmentLine('gato & perro', 'es');
        const html = buildGlossHtml(segments, (lemma) => (lemma === 'gato' ? '<b>cat</b>' : undefined));
        expect(html).toContain('&lt;b&gt;cat&lt;/b&gt;'); // gloss escaped, not injected as markup
        expect(html).not.toContain('<b>');
        expect(html).toContain(' &amp; '); // the '&' gap is escaped
    });
});

describe('glossedLemmasFromHtml', () => {
    it('extracts exactly the words the settled HTML wraps in gloss ruby', () => {
        const segments = segmentLine('Quiero un gato bonito, gato mío', 'es');
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
        const segments = segmentLine('Quiero un gato bonito, gato mío', 'es');
        const html = buildGlossHtml(segments, (lemma) =>
            lemma === 'gato' ? 'cat' : lemma === 'bonito' ? 'pretty' : undefined
        );
        expect(glossedEntriesFromHtml(html)).toEqual([
            { word: 'gato', gloss: 'cat' },
            { word: 'bonito', gloss: 'pretty' },
        ]);
    });

    it('unescapes label text that was HTML-escaped at render time', () => {
        const segments = segmentLine('Ley de oferta', 'es');
        const html = buildGlossHtml(segments, (lemma) => (lemma === 'ley' ? 'law & order' : undefined));
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
            expect(isContentWord(aux, 'es')).toBe(false);
        }
    });

    it('mirrors savi-core exactly, so nothing glossable is unreviewable', () => {
        // This set must never be NARROWER than savi-core's STOPWORDS. When the
        // nine lexical adverbs were freed, BOTH lists had to move together —
        // freeing only savi-core would have left them tracked but never
        // labelled, and freeing only this one would label a word that can
        // never enter review.
        for (const structural of ['el', 'la', 'de', 'que', 'y', 'se', 'lo', 'por', 'para']) {
            expect(isContentWord(structural, 'es')).toBe(false);
        }
    });

    it('still glosses real verbs, including ambiguous ones', () => {
        // "voy" → ir, a content verb: glossable AND reviewable, so it must
        // keep its label. "fuimos" maps to both ir and ser — the ir reading
        // makes it reviewable, so it stays glossable too.
        for (const word of ['voy', 'fuimos', 'corriendo', 'llevar']) {
            expect(isContentWord(word, 'es')).toBe(true);
        }
    });
});

// ── SV-40: the server decides, the client renders ──────────────────────────

describe('glossCandidates', () => {
    it('sends distinct content surfaces, dropping punctuation and proper nouns', () => {
        const segments = segmentLine('Yo no sabía nada, Elena. ¿Sabía algo?', 'es');
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

describe('skipSummary', () => {
    // The candidates ARE the line's content words, so a per-word log would
    // reconstruct what the user is watching — the transcript-snippet tier hard
    // constraint #2 keeps independently toggleable. The first version of this
    // log emitted every word while its commit message claimed it did not, so
    // the property is pinned here rather than trusted to a comment.
    it('never carries the words themselves, only reasons and counts', () => {
        const summary = skipSummary([
            { word: 'supieras', lemma: 'saber', skip: 'known' },
            { word: 'pareces', lemma: 'parecer', skip: 'known' },
            { word: 'estuvieron', lemma: 'estar', skip: 'function-word' },
        ]);

        for (const word of ['supieras', 'pareces', 'estuvieron', 'saber', 'parecer', 'estar']) {
            expect(summary).not.toContain(word);
        }
    });

    it('still answers the diagnostic question: which reason, and how many', () => {
        const summary = skipSummary([
            { word: 'a', skip: 'known' },
            { word: 'b', skip: 'known' },
            { word: 'c', skip: 'function-word' },
        ]);

        expect(summary).toContain('known: 2');
        expect(summary).toContain('function-word: 1');
    });

    it('ignores words that were NOT skipped — they got labels, not reasons', () => {
        const summary = skipSummary([
            { word: 'nube', lemma: 'nube', gloss: 'cloud' },
            { word: 'saber', lemma: 'saber', skip: 'known' },
        ]);

        expect(summary).toBe('known: 1');
    });
});

describe('SaviGlossController debug logging', () => {
    // The healthy case — "you already know every word here" — is the COMMON
    // one. At ~900 subtitle lines an episode, logging it per line would burn
    // work nobody asked for and bury the rare reason under the frequent one,
    // which is the opposite of what the log is for.
    const settings = { get: async () => ({ saviGlossing: false }) as any };

    it('says a reason once, then goes quiet while it holds', async () => {
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
        const controller = new SaviGlossController(settings, () => {});
        const why = (controller as any)._why.bind(controller);

        why('all-skipped', 'all 4 word(s) skipped — known: 4');
        why('all-skipped', 'all 3 word(s) skipped — known: 3');
        why('all-skipped', 'all 5 word(s) skipped — known: 5');

        expect(debug).toHaveBeenCalledTimes(1);
        debug.mockRestore();
    });

    it('speaks up when the reason changes, and says how long the last one ran', async () => {
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
        const controller = new SaviGlossController(settings, () => {});
        const why = (controller as any)._why.bind(controller);

        why('all-skipped', 'all 4 word(s) skipped — known: 4');
        why('all-skipped', 'all 3 word(s) skipped — known: 3');
        why('call-failed', 'call returned no decisions for 2 word(s)');

        const lines = debug.mock.calls.map((c) => String(c[0]));
        expect(lines).toHaveLength(3);
        expect(lines[1]).toContain('previous ×2'); // the run that just ended
        expect(lines[2]).toContain('call returned no decisions');
        debug.mockRestore();
    });
});

describe('per-line target language re-read (the stale-"fr" bug)', () => {
    // A language switched in the app mid-watch never reached a running
    // binding: `start()` read the roaming cache once, so a stale "fr" glossed
    // half an episode as all-"untokenized" until a page refresh. The fix
    // re-reads the cache on every line.
    afterEach(() => {
        mockTargetLanguage = 'es';
    });

    it('picks up a language change without a rebind', async () => {
        const { controller, sent } = makeGlossController();
        await controller.start();
        const glossLine = (controller as any)._glossLine.bind(controller);

        await glossLine('Hola mundo', ['mundo'], true);
        mockTargetLanguage = 'ja';
        await glossLine('Hola cielo', ['cielo'], true);

        const langs = sent
            .filter((c) => c.message?.command === 'savi-gloss-line')
            .map((c) => c.message.lang);
        expect(langs).toEqual(['es', 'ja']);
    });

    it('logs the server no-analyzer verdict as its own reason, without the words', async () => {
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
        (globalThis as any).browser = {
            runtime: {
                sendMessage: jest.fn(async () => ({
                    words: [
                        { word: 'mundo', skip: 'no-analyzer' },
                        { word: 'cielo', skip: 'no-analyzer' },
                    ],
                    threshold: 0.8,
                })),
            },
        };
        const settings = { get: async () => ({ saviGlossing: true }) as any };
        const controller = new SaviGlossController(settings, () => {});
        const glossLine = (controller as any)._glossLine.bind(controller);

        const labels = await glossLine('mundo cielo', ['mundo', 'cielo'], true);

        expect(labels.size).toBe(0);
        const logged = debug.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain('no analyzer');
        // Hard constraint #2: the debug log never carries the line's words.
        expect(logged).not.toContain('mundo');
        expect(logged).not.toContain('cielo');
        debug.mockRestore();
    });
});

// ── the duplicate-request bug ───────────────────────────────────────────────

// ── bind-time projection warm ───────────────────────────────────────────────

/** Build a `SaviGlossController` with faked settings + a faked
 *  `browser.runtime.sendMessage`, returning `{ controller, sent }` where
 *  `sent` records every message passed to `sendMessage`. `failCommands`
 *  makes those specific commands reject, so a test can simulate one call
 *  failing (e.g. the warm call timing out) without the rest of the fakes
 *  changing behaviour.
 *
 *  `settingsOverrides.targetLanguage` is a NO-OP: `start()` reads the target
 *  language from `getCachedRoamingSettings()`, which this file mocks at the
 *  top to always return 'es' — the real language always comes from there,
 *  never from this options object. Passing anything but 'es' here would be
 *  silently ignored, not honored. */
function makeGlossController(
    settingsOverrides: { saviGlossing?: boolean; targetLanguage?: string } = {},
    options: { failCommands?: string[] } = {}
): { controller: SaviGlossController; sent: Array<{ message: any }> } {
    const failCommands = new Set(options.failCommands ?? []);
    const sent: Array<{ message: any }> = [];
    (globalThis as any).browser = {
        runtime: {
            sendMessage: jest.fn(async (command: any) => {
                sent.push(command);
                if (failCommands.has(command?.message?.command)) {
                    throw new Error(`simulated failure: ${command?.message?.command}`);
                }
                return {};
            }),
        },
    };
    const settings = { get: async () => ({ saviGlossing: true, ...settingsOverrides }) as any };
    const controller = new SaviGlossController(settings, () => {});
    return { controller, sent };
}

describe('bind-time projection warm', () => {
    it('fires exactly one warm message per bind', async () => {
        const { controller, sent } = makeGlossController({ saviGlossing: true, targetLanguage: 'es' });
        await controller.start();
        const warms = sent.filter((m) => m.message?.command === 'savi-warm-projections');
        expect(warms).toHaveLength(1);
        expect(warms[0].message.lang).toBe('es');
    });

    it('keeps glossing enabled when the warm call fails', async () => {
        const { controller, sent } = makeGlossController(
            { saviGlossing: true, targetLanguage: 'es' },
            { failCommands: ['savi-warm-projections'] }
        );
        await controller.start();
        // The warm call is fire-and-forget: its only job is the server-side
        // side effect, so a failure must never take glossing down with it.
        // `glossable` is the actual discriminator here — `glossHtmlFor`
        // returns undefined both when glossing is off AND when a line simply
        // hasn't settled yet, so it can't tell the two cases apart on its own.
        expect(controller.glossable).toBe(true);
        expect(controller.glossHtmlFor('hola mundo')).toBeUndefined();
        expect(sent.some((m) => m.message?.command === 'savi-warm-projections')).toBe(true);
    });

    it('never populates the client-side known set', async () => {
        // SV-40 moved the decision server-side because the client keys by
        // SURFACE while the data keys by LEMMA. Reviving a client-side known
        // set would reintroduce exactly that bug, so the warm response must
        // never be read back into a decision path.
        const { controller } = makeGlossController({ saviGlossing: true, targetLanguage: 'es' });
        await controller.start();
        expect((controller as unknown as { _known: Set<string> })._known.size).toBe(0);
    });
});

describe('SaviGlossController.start is re-entrant', () => {
    // The founder saw the same line requested twice, back to back, with
    // identical payloads:
    //
    //   { line: "Hablando de milagros, Rubén, vení,", words: [...] }
    //   { line: "Hablando de milagros, Rubén, vení,", words: [...] }
    //
    // `start()` documented itself as "safe to call again" and was not: it
    // assigned a fresh prefetch interval over a live one — leaking the old
    // handle, which is the only reference anyone holds — so two tickers ran
    // forever. `_reset()` cleared the in-flight set at the same moment, so the
    // duplicate suppression had nothing left to suppress against.
    //
    // Gloss calls are billed per character downstream, so a duplicate costs
    // money, not just tidiness.
    const settings = { get: async () => ({ saviGlossing: true }) as any };

    it('does not leak a prefetch interval when started twice', async () => {
        jest.useFakeTimers();
        try {
            const controller = new SaviGlossController(settings, () => {});
            const ticks: number[] = [];
            (controller as any)._prefetchTick = () => ticks.push(1);

            await controller.start();
            await controller.start();

            const running = jest.getTimerCount();
            expect(running).toBe(1); // two starts, ONE ticker

            // And stopping really stops: a leaked handle would keep firing.
            controller.stop();
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('isContentWord — the target language decides which stoplist applies', () => {
    // Before 0.46.0 the Spanish sets were applied to EVERY space-delimited
    // language. These are the words that silently lost their gloss forever:
    // the client never asks the server about a word it has already filtered.
    it('does not apply Spanish function words to French', () => {
        // `sons` (plural of `son`, a sound) and `os` (bone) are ordinary French
        // vocabulary that the Spanish lists filtered out. The three languages'
        // function words overlap heavily, so these are the real casualties
        // rather than a long list — measured against frequency-fr.txt.
        for (const word of ['sons', 'os']) {
            expect(isContentWord(word, 'fr')).toBe(true);
        }
        // …while real French function words are still filtered.
        for (const word of ['le', 'les', 'des', 'que', 'est', 'vous', 'qu']) {
            expect(isContentWord(word, 'fr')).toBe(false);
        }
    });

    it('does not apply Spanish function words to German', () => {
        // `los` ("was ist los?") and `tu` (imperative of `tun`) are real German
        // words that the Spanish stoplist dropped — measured against
        // frequency-de.txt, which ranks both inside the top 20k.
        for (const word of ['los', 'tu']) {
            expect(isContentWord(word, 'de')).toBe(true);
        }
        for (const word of ['der', 'die', 'das', 'nicht', 'sind', 'sie']) {
            expect(isContentWord(word, 'de')).toBe(false);
        }
    });

    it('sends everything for a language with no mirror', () => {
        // A payload prefilter, not the decision — the server owns that. For an
        // unmirrored language the safe failure is over-sending.
        for (const word of ['de', 'que', 'der', 'le']) {
            expect(isContentWord(word, 'it')).toBe(true);
        }
        // The length rule is language-independent and still applies.
        expect(isContentWord('a', 'it')).toBe(false);
    });

    it('applies the Spanish auxiliary list only to Spanish', () => {
        // `estuvieron`/`seré` are unreviewable in Spanish (their lemma is a
        // function word) but are just unknown strings elsewhere.
        expect(isContentWord('estuvieron', 'es')).toBe(false);
        expect(isContentWord('estuvieron', 'fr')).toBe(true);
    });

    it('reads the primary subtag, so regional variants behave alike', () => {
        expect(isContentWord('le', 'fr-CA')).toBe(false);
        expect(isContentWord('das', 'DE-AT')).toBe(false);
    });
});

describe('segmentLine — German capitalizes every noun', () => {
    it('glosses mid-sentence German nouns instead of taking them for names', () => {
        // The Romance heuristic ("a mid-sentence capital is a name") would
        // refuse to gloss Haus, Buch and Kind — most of the content words a
        // German learner needs.
        const segments = segmentLine('Ich habe das Buch im Haus gelesen.', 'de');
        const buch = segments.find((s) => s.text === 'Buch');
        expect(buch?.properNoun).toBe(false);
        expect(buch?.content).toBe(true);
        const haus = segments.find((s) => s.text === 'Haus');
        expect(haus?.content).toBe(true);
        expect(glossCandidates(segments)).toEqual(['buch', 'haus', 'gelesen']);
    });

    it('still suppresses mid-sentence capitals for Romance languages', () => {
        // The German exemption must not leak: French names stay unglossed.
        const segments = segmentLine("J'ai vu Marie hier.", 'fr');
        const marie = segments.find((s) => s.text === 'Marie');
        expect(marie?.properNoun).toBe(true);
        expect(marie?.content).toBe(false);
    });

    it('accepts German letters as word characters', () => {
        const segments = segmentLine('Die Größe der Straße überrascht.', 'de');
        const words = segments.filter((s) => s.word).map((s) => s.text);
        expect(words).toEqual(['Die', 'Größe', 'der', 'Straße', 'überrascht']);
        expect(segments.map((s) => s.text).join('')).toBe('Die Größe der Straße überrascht.');
    });

    it('splits French elision without emitting the clitic as a word', () => {
        const segments = segmentLine("Qu'il parle de l'homme.", 'fr');
        expect(segments.map((s) => s.text).join('')).toBe("Qu'il parle de l'homme.");
        // qu / il / de / l are all structural or too short.
        expect(glossCandidates(segments)).toEqual(['parle', 'homme']);
    });
});
