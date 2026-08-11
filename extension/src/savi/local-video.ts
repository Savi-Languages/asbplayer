// What is this local video? (SV-44)
//
// A file played from disk has no metadata API to ask — a content script cannot
// read container tags (the mkv title field, mp4 `moov` atoms) without parsing
// the file itself, which we are not going to do in a content script. The
// filename is the signal, and for downloaded media it is a good one: release
// naming is a de-facto standard.
//
// The job is to turn
//   Some.Show.Name.S01E02.1080p.WEB-DL.DDP5.1.x264-GROUP.mkv
// into
//   { title: 'Some Show Name', seasonNumber: 1, episodeNumber: 2 }
// so it can be handed to the OpenSubtitles search that SV-8 already built.
//
// ## Truncate, don't scrub
//
// The obvious approach — delete every junk token wherever it appears — is
// wrong, because "junk" words are real title words too: *Dual*, *Extended*,
// *Remux*, *Proper*, and the film *1917* is indistinguishable from a release
// year. Release names are ordered (title, then markers, then junk), so instead
// we find the FIRST unambiguous marker and keep only what precedes it. A
// filename that opens with junk yields a bad title either way; one that does
// not is safe, which is nearly all of them.
//
// Everything here is pure and total: a caller passes a string, gets a result,
// and nothing throws. A parse that gets it wrong costs one wrong search, and
// `titlesOverlap` (subtitle-relevance.ts) is what stops a wrong search from
// becoming wrong subtitles.

/** What a filename claims the video is. */
export interface ParsedVideoName {
    /** Human-readable title, suitable as an OpenSubtitles query and as a
     *  display name. Empty when the filename carried nothing usable. */
    readonly title: string;
    readonly seasonNumber?: number;
    readonly episodeNumber?: number;
    /** Release year, when the filename carried one. Disambiguates remakes
     *  (three films are called "The Thing"). */
    readonly year?: number;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

// Container extensions we strip before parsing. Deliberately a closed list:
// stripping "anything after the last dot" eats the tail of dotted release
// names that have no extension at all.
const videoExtension = /\.(?:mkv|mp4|m4v|avi|mov|webm|wmv|flv|mpg|mpeg|ts|m2ts|ogv|3gp|divx|vob|rmvb|asf)$/i;

/** Whether a filename looks like a video we can play. Used to decide whether a
 *  `file://` page is worth treating as an episode at all. */
export const looksLikeVideoFile = (name: string): boolean => videoExtension.test(asString(name).trim());

// Tokens that mark the end of a title in a release name. Every entry has to be
// a word nobody titles a film with — resolution, codec, source, container
// detail. Words like "extended", "remux", "proper" and "dual" are NOT here:
// they appear in real titles and the cost of a false positive (a truncated
// title, so a failed search) is worse than the cost of a false negative (some
// junk in the query, which OpenSubtitles tolerates).
const junkToken =
    /^(?:\d{3,4}[pi]|4k|8k|uhd|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|bluray|blu-ray|brrip|bdrip|bdremux|webrip|web-?dl|hdtv|pdtv|dvdrip|dvdscr|hdrip|camrip|telesync|aac\d?|ac3|eac3|dts(?:-hd)?|ddp?\d(?:\.\d)?|truehd|atmos|flac|opus|hdr\d*|dolby|vision|10bit|8bit|hi10p|sdr)$/i;

// A 4-digit year in the plausible range for filmed media.
const yearToken = /^(?:19\d{2}|20\d{2})$/;

// Season/episode markers, most specific first:
//   S01E02 / s01.e02 / S1E2   — the standard
//   1x02 / 01x02              — older convention
//   Season 1 Episode 2        — spelled out, seen in hand-named files
const seasonEpisodePatterns: readonly RegExp[] = [
    /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})(?!\d)/,
    /(?:^|[\s._-])(\d{1,2})[xX](\d{2,3})(?!\d)/,
    /[sS]eason[\s._-]*(\d{1,2})[\s._-]*[eE]pisode[\s._-]*(\d{1,3})(?!\d)/i,
];

// Fansubbed anime: "[Group] Show Name - 12 (1080p) [HASH].mkv" — a bare
// episode number after a dash, with no season. Requires the surrounding
// spaces so "Spider-Man 2" (a title, not episode 2) is left alone.
const bareEpisodePattern = /\s-\s(\d{1,3})(?!\d)(?:\s|$)/;

/** Strip the directory part and the container extension. */
const basenameOf = (path: string): string => {
    const withoutQuery = asString(path).split(/[?#]/)[0];
    const lastSlash = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
    const base = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
    return base.replace(videoExtension, '');
};

/** Release names separate words with dots or underscores. Convert to spaces,
 *  but only when there are no spaces already — a name that uses real spaces
 *  may legitimately contain a dot ("Dr. Strangelove", "S.W.A.T."). */
const normalizeSeparators = (name: string): string => {
    if (/\s/.test(name)) {
        return name;
    }
    return name.replace(/[._]+/g, ' ');
};

/** Drop bracketed groups: "[SubsPlease]", "(1080p)", "[ABCD1234]". These carry
 *  release metadata, never the title — a title inside brackets would be a
 *  filename nobody produces.
 *
 *  A bracketed YEAR is the exception and is unwrapped rather than dropped:
 *  "Some Film (2019).mp4" is the commonest hand-naming convention there is,
 *  and the year is the one piece of bracketed metadata worth keeping (it
 *  disambiguates remakes). Unwrapping lets the ordinary year rule in
 *  [`truncateAtJunk`] handle it, instead of duplicating that logic here. */
const stripBracketed = (name: string): string =>
    name.replace(/[[({]\s*((?:19|20)\d{2})\s*[\])}]/g, ' $1 ').replace(/[[({][^\])}]*[\])}]/g, ' ');

/** Everything up to the first junk token or year. See the header: truncating
 *  beats scrubbing because junk words double as title words. */
const truncateAtJunk = (name: string): { title: string; year?: number } => {
    const tokens = name.split(/\s+/).filter((t) => t.length > 0);
    const kept: string[] = [];
    let year: number | undefined;

    for (const token of tokens) {
        const bare = token.replace(/^[-–—]+|[-–—]+$/g, '');

        if (junkToken.test(bare)) {
            break;
        }
        if (yearToken.test(bare)) {
            // A leading year IS the title ("1917", "2012"), so only treat it as
            // a release year once at least one title word precedes it.
            if (kept.length > 0) {
                year = Number(bare);
                break;
            }
        }
        kept.push(token);
    }

    return { title: kept.join(' '), year };
};

/** A trailing "-GROUP" release-group tag, and any leftover separator debris. */
const tidy = (title: string): string =>
    title
        .replace(/-[A-Za-z0-9]{2,}$/, '') // trailing release group
        .replace(/[\s._-]+$/g, '')
        .replace(/^[\s._-]+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

/**
 * Parse a filename (or a whole path / `file://` URL) into a searchable title
 * plus season/episode when the name carries them.
 *
 * Total: any input yields a result, and an unparseable name yields an empty
 * title rather than a throw. Callers treat an empty title as "ask the user".
 */
export const parseVideoFilename = (input: string): ParsedVideoName => {
    const base = basenameOf(decodeFilename(asString(input).trim()));
    if (base.length === 0) {
        return { title: '' };
    }

    const normalized = normalizeSeparators(base);

    for (const pattern of seasonEpisodePatterns) {
        const match = normalized.match(pattern);
        if (match && match.index !== undefined) {
            const before = stripBracketed(normalized.slice(0, match.index));
            const { title, year } = truncateAtJunk(before);
            const cleaned = tidy(title);
            return {
                title: cleaned,
                seasonNumber: Number(match[1]),
                episodeNumber: Number(match[2]),
                year,
            };
        }
    }

    // Anime-style bare episode number. Checked after the season patterns so
    // "Show - S01E02" never reaches it.
    const bare = normalized.match(bareEpisodePattern);
    if (bare && bare.index !== undefined) {
        const before = stripBracketed(normalized.slice(0, bare.index));
        const { title, year } = truncateAtJunk(before);
        const cleaned = tidy(title);
        if (cleaned.length > 0) {
            return { title: cleaned, episodeNumber: Number(bare[1]), year };
        }
    }

    // No episode markers → a film. Truncate at junk/year over the whole name.
    const { title, year } = truncateAtJunk(stripBracketed(normalized));
    return { title: tidy(title), year };
};

/** Percent-decode a path segment from a `file://` URL, leaving a plain name
 *  untouched. Malformed escapes are left as-is rather than throwing. */
const decodeFilename = (value: string): string => {
    if (!value.includes('%')) {
        return value;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

/**
 * The filename a page is playing, from its URL — `file:///…/Show.S01E02.mkv`
 * or an http URL that ends in a video file. `undefined` when the URL does not
 * name a video, which is the signal to fall back to `document.title`.
 */
export const videoFilenameFromUrl = (url: string): string | undefined => {
    const raw = asString(url).trim();
    if (raw.length === 0) {
        return undefined;
    }

    let pathname = raw;
    try {
        pathname = new URL(raw).pathname;
    } catch {
        // Not a URL — treat the input as a bare path.
    }

    const decoded = decodeFilename(pathname);
    const lastSlash = Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf('\\'));
    const base = lastSlash >= 0 ? decoded.slice(lastSlash + 1) : decoded;

    return looksLikeVideoFile(base) ? base : undefined;
};

/**
 * A human-readable name for a parsed video, used as the `basename` the picker
 * shows and the capture pipeline files the episode under.
 *
 * Deliberately re-emits the canonical `S01E02` form rather than the filename's
 * original spelling, so the name round-trips: `parseShowQuery` (track-select.ts)
 * re-reads it correctly, and two files for the same episode named differently
 * (`S01E02` vs `1x02`) produce the SAME display name — and therefore the same
 * episode id, so re-watching a re-downloaded file resumes rather than forking
 * the library.
 */
export const displayNameFor = ({ title, seasonNumber, episodeNumber, year }: ParsedVideoName): string => {
    const base = title.trim();
    if (base.length === 0) {
        return '';
    }
    if (seasonNumber !== undefined && episodeNumber !== undefined) {
        const s = String(seasonNumber).padStart(2, '0');
        const e = String(episodeNumber).padStart(2, '0');
        return `${base} S${s}E${e}`;
    }
    if (episodeNumber !== undefined) {
        return `${base} E${String(episodeNumber).padStart(2, '0')}`;
    }
    return year !== undefined ? `${base} (${year})` : base;
};

/**
 * The best display/search name for a page playing a local video: the filename
 * when the URL names one, else `document.title`.
 *
 * Chrome sets `document.title` to the filename for a bare `file://` video, so
 * the two usually agree — but the URL is the more reliable of the two (a title
 * can be overwritten by script, and a served file may have a nicer page title
 * that is not the episode).
 */
export const localVideoName = (url: string, documentTitle: string): ParsedVideoName => {
    const fromUrl = videoFilenameFromUrl(url);
    if (fromUrl !== undefined) {
        const parsed = parseVideoFilename(fromUrl);
        if (parsed.title.length > 0) {
            return parsed;
        }
    }
    return parseVideoFilename(asString(documentTitle));
};
