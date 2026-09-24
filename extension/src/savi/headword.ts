// The reading printed beside a dictionary headword. Its own module because both
// the hover popup (hover-dict) and the tap panel (word-panel) render that header,
// and hover-dict already imports word-panel — sharing it either way round would
// close an import cycle.

import { SaviDictEntry, SaviToken } from './daemon-client';

/** The reading to print beside the headword we actually SHOW.
 *
 *  `token.reading` is the reading of the SURFACE form, and the headword is the
 *  lemma (`lookupTermFor` in hover-dict) — so on any inflected word the two disagree:
 *  hovering 負って showed "負う おっ", the conjugated stem's reading pinned under
 *  the dictionary form. When the headword is the lemma we therefore take the
 *  reading from the dictionary entry for it (負う → おう) instead, and print
 *  nothing rather than something wrong when no entry matches.
 *
 *  A kana headword (しかし) needs no reading at all — hence the `!== term` guard,
 *  which also covers entries whose kanji list is empty. */
export function headwordReading(term: string, token: SaviToken, entries: SaviDictEntry[]): string | undefined {
    const reading = token.text === term ? token.reading : lemmaReading(term, entries);
    return reading && reading !== term ? reading : undefined;
}

/** The dictionary reading of headword `term`: the first reading of the entry
 *  that actually lists `term` as one of its kanji spellings. Search results can
 *  contain related spellings, so using an unmatched first result would attach a
 *  plausible but wrong reading to the displayed headword. Kana-only entries
 *  carry no distinct reading, so they yield none. */
function lemmaReading(term: string, entries: SaviDictEntry[]): string | undefined {
    const entry = entries.find((e) => e.kanji.includes(term));
    return entry && entry.kanji.length > 0 ? entry.readings[0] : undefined;
}
