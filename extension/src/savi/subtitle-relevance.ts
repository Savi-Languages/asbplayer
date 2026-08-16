// Does an OpenSubtitles result actually belong to the video being watched?
//
// The fallback search (SV-8 Path B) asks OpenSubtitles for a title and loads
// what comes back. OpenSubtitles is a FILM/TV database and its search is fuzzy:
// given a title it does not have, it returns its nearest match rather than
// nothing. Nothing downstream compared that result to what was asked for, so a
// YouTube comedy song ("Garfunkel and Oates — …") loaded the subtitles of an
// unrelated film ("Hussain: Who Said No"), in perfect sync with nothing.
//
// Wrong subtitles are worse than no subtitles: they are silently plausible, and
// every line of them is fed to glossing and counted as exposure.
//
// This is a deliberately blunt check — it only has to reject the obviously
// unrelated, and a false reject just means "no subtitles", which is the state
// the user would have been in anyway.

/** Words too common to carry identity in a release name. */
const STOPWORDS = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'of',
    'in',
    'on',
    'to',
    'for',
    'with',
    'hd',
    'web',
    'dl',
    'bluray',
    'x264',
    'x265',
    'srt',
    'ass',
    'ssa',
    'vtt',
    'sub',
    'subs',
    'english',
    'spanish',
    // SV-33 — a language name in a release filename says which SUBTITLE this
    // is, never which show, so it carries no identity for matching.
    'french',
    'german',
    'francais',
    'français',
    'deutsch',
    'season',
    'episode',
]);

/** Identity-bearing lowercase tokens: letters/digits, 2+ chars, non-stopword. */
export function significantTokens(text: string): string[] {
    return (text ?? '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Whether `candidate` (an OpenSubtitles release name) plausibly refers to the
 * same thing as `query` (the page's title).
 *
 * Rule: at least half of the query's significant tokens must appear in the
 * candidate, and at least one must — so a query that reduces to nothing
 * identifying rejects rather than matching everything.
 */
export function titlesOverlap(query: string, candidate: string | undefined): boolean {
    if (!candidate) {
        return false;
    }
    const wanted = significantTokens(query);
    if (wanted.length === 0) {
        return false;
    }
    const have = new Set(significantTokens(candidate));
    const hits = wanted.filter((t) => have.has(t)).length;
    return hits >= Math.ceil(wanted.length / 2);
}
