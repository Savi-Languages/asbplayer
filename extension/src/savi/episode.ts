// Episode identity + metadata derivation for savi captures.
//
// Capture v2 (2026-06-15): the episodeId is now PLATFORM-STABLE — the same
// episode yields the same id on every visit — so the daemon can key a
// resumable, per-show library off it (see the design addendum "Capture v2
// — episode identity, persistence, resume, organization"). The id is no
// longer title+timestamp (which looked new every visit and could not be
// resumed).
//
// Derivation, in order:
//   Netflix  → `netflix:<videoId>`  videoId = the /watch/<videoId> path
//              segment (NOT the trackId query param, which is per-play).
//   YouTube  → `youtube:<videoId>`  videoId = ?v= (watch pages) or the
//              youtu.be/<id> path segment (short links).
//   Fallback → `<hostname>:<slug(title)>` with NO date, so it stays stable
//              across visits. The title is stripped of a trailing site
//              suffix (" - Netflix", " | Netflix", " - YouTube", …) first.
//
// The daemon derives captureId = filesystem-safe(episodeId), so the id
// becomes part of a path (`~/savi-library/.capture/<captureId>/`) and must
// stay free of path separators / traversal. The platform-prefixed ids
// (`netflix:81932329`) use ':' which the daemon sanitizes; the fallback
// runs the title through `slugify`, which already guarantees safety. We
// keep the `:` in the platform ids because it's the human-readable
// namespace the daemon's manifest/sidecar expect; the daemon owns the
// final filesystem mapping.

const unsafeCharacters = /[^\p{L}\p{N}]+/gu;

// Coerces anything to a string so the pure helpers below stay total (the
// content-script glue already guards, but tests + future callers may not).
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export const slugify = (title: string): string => {
    const slug = asString(title)
        .normalize('NFKC')
        .toLowerCase()
        .replace(unsafeCharacters, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/\.\./g, '-');
    return slug.length === 0 ? 'episode' : slug.slice(0, 80);
};

// Strips a trailing " - <Site>" / " | <Site>" suffix that streaming sites
// append to document.title (e.g. "Dark - Netflix", "Some video - YouTube").
// Only known site suffixes are stripped so a real episode title that merely
// contains a dash (e.g. "Episode 3 - The Reveal") survives untouched.
const siteSuffix = /\s*[|–—-]\s*(netflix|youtube|prime video|disney\+|hulu|crunchyroll|max)\s*$/iu;

export const stripSiteSuffix = (title: string): string => asString(title).replace(siteSuffix, '').trim();

const parseUrl = (url: string): URL | undefined => {
    try {
        return new URL(url);
    } catch (e) {
        return undefined;
    }
};

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

// Netflix watch URLs look like
//   https://www.netflix.com/watch/81932329?trackId=...&tctx=...
//   https://www.netflix.com/gb/watch/81932329           (locale prefix)
// The video id is the path segment immediately after `/watch/`.
const netflixVideoId = (parsed: URL): string | undefined => {
    const match = parsed.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : undefined;
};

// YouTube ids come from `?v=` on youtube.com/watch (and music.youtube.com),
// or the first path segment of a youtu.be short link.
const youtubeVideoId = (parsed: URL): string | undefined => {
    if (hostMatches(parsed.host, 'youtu.be')) {
        const segment = parsed.pathname.split('/').filter(Boolean)[0];
        return segment || undefined;
    }

    if (hostMatches(parsed.host, 'youtube.com')) {
        const v = parsed.searchParams.get('v');
        return v || undefined;
    }

    return undefined;
};

// Pure, total: never throws; returns a non-empty, daemon-safe-ish id for any
// input. Unknown / unparseable urls fall back to a hostname:slug(title) id.
export const deriveEpisodeId = (url: string, title: string): string => {
    const parsed = parseUrl(url);

    if (parsed !== undefined) {
        if (hostMatches(parsed.host, 'netflix.com')) {
            const id = netflixVideoId(parsed);
            if (id !== undefined) {
                return `netflix:${id}`;
            }
        }

        const youtube = youtubeVideoId(parsed);
        if (youtube !== undefined) {
            return `youtube:${youtube}`;
        }
    }

    // Generic fallback: hostname namespace + stable slug of the title (no
    // date). Drop a leading "www." so the namespace is the bare domain.
    const host = (parsed?.host ?? '').replace(/^www\./, '');
    const slug = slugify(stripSiteSuffix(title));

    return host.length > 0 ? `${host}:${slug}` : slug;
};

// ── show + title extraction ─────────────────────────────────────────────
//
// Best-effort series-name (`show`) + episode-label (`title`) scrape. The
// DOM reading happens in the content-script glue (capture-controller); these
// helpers are pure and take already-read strings so they're unit-testable
// and never touch `document`.

export interface ShowAndTitle {
    readonly show?: string;
    readonly title: string;
}

// Netflix renders its player title overlay as two stacked lines: the series
// name on top and the episode label (often "S1:E3 The Title" or just the
// episode name) below. When a content script can read those two DOM strings,
// this assembles them. Either may be absent (films have no episode line).
export const netflixShowAndTitleFromDom = (
    seriesName: string | undefined,
    episodeLabel: string | undefined
): ShowAndTitle | undefined => {
    const show = seriesName?.trim();
    const episode = episodeLabel?.trim();

    if (show && episode) {
        return { show, title: episode };
    }

    if (show && !episode) {
        // A film: the overlay shows only the title, which Netflix puts in the
        // series-name slot. Treat it as the title with no separate show.
        return { show: undefined, title: show };
    }

    if (!show && episode) {
        return { show: undefined, title: episode };
    }

    return undefined;
};

// Fallback that works off document.title alone. Netflix sets document.title
// to e.g. "Watch Dark | Netflix" or "Dark - Netflix"; after stripping the
// "Watch " prefix and the site suffix we have the show (for a series the
// page title is the series name, not the per-episode label — which is why
// the DOM overlay above is preferred when available).
const watchPrefix = /^watch\s+/iu;

export const showAndTitleFromDocumentTitle = (documentTitle: string): ShowAndTitle => {
    const raw = asString(documentTitle);
    const cleaned = stripSiteSuffix(raw).replace(watchPrefix, '').trim();
    const title = cleaned.length > 0 ? cleaned : raw.trim();
    return { show: undefined, title };
};

// Top-level resolver used by the content-script glue. Prefers the Netflix DOM
// overlay strings when the page is Netflix and they were found; otherwise
// falls back to parsing document.title. Always returns a usable title and
// never throws.
export const deriveShowAndTitle = (
    url: string,
    documentTitle: string,
    netflixDom?: { seriesName?: string; episodeLabel?: string }
): ShowAndTitle => {
    const parsed = parseUrl(url);

    if (parsed !== undefined && hostMatches(parsed.host, 'netflix.com') && netflixDom !== undefined) {
        const fromDom = netflixShowAndTitleFromDom(netflixDom.seriesName, netflixDom.episodeLabel);
        if (fromDom !== undefined) {
            return fromDom;
        }
    }

    return showAndTitleFromDocumentTitle(documentTitle);
};

// ── show + title from asbplayer's detected subtitle basename ──────────────
//
// asbplayer derives its own basename from the streaming site's video metadata
// API (see netflix-page.ts → determineBasename): for a series it is
// "<Show> S<NN>E<NN> <Episode Title>" and for a film it is just "<Show>". That
// basename is FAR more reliable than scraping the player DOM or document.title
// (which is often just "Netflix" at capture time), so the savi capture host
// prefers it. This helper turns the basename back into {show, title} and is
// pure/total: it coerces non-strings to '' and never throws.

// A trailing subtitle-container extension the basename may pick up once it has
// flowed through subtitle bookkeeping (".srt"/".vtt"/".ass").
const subtitleExtensionSuffix = /\.(?:srt|vtt|ass)$/i;

// A trailing language tag that subtitle filenames sometimes carry. Kept
// deliberately narrow so a real (non-Latin) episode title is never mistaken
// for a language suffix:
//   - " (English)" / " (English [CC])" — parenthesized language label, OR
//   - " .en" / " .en-US" / " .jpn" — a dotted 2–3 letter ISO-ish code,
// each anchored to the end. A bare " English" (no parens, no dot) is NOT
// stripped, because that is indistinguishable from a real title word.
const languageTagSuffix = /(?:\s*\([A-Za-z][A-Za-z ]*(?:\[CC\])?\)|\s+\.[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)$/;

const stripSubtitleFileSuffix = (value: string): string => {
    // Strip at most one extension, then at most one language tag. Order
    // matters: "Foo .en.srt" → drop ".srt" → "Foo .en" → drop " .en".
    const withoutExtension = value.replace(subtitleExtensionSuffix, '');
    return withoutExtension.replace(languageTagSuffix, '').trim();
};

// Series form: "<Show> S<NN>E<NN> <rest>". Show is everything before the
// season/episode marker; title keeps the "S##E##" label plus any trailing
// episode title. Season is 1–3 digits, episode 1–4. The `\b` after the
// episode number prevents matching e.g. "S01E099999".
const seriesBasenamePattern = /^(.*?)\s+S(\d{1,3})E(\d{1,4})\b(.*)$/;

export const deriveShowAndTitleFromBasename = (basename: string): ShowAndTitle => {
    const cleaned = stripSubtitleFileSuffix(asString(basename).trim());

    if (cleaned.length === 0) {
        return { title: '' };
    }

    const match = cleaned.match(seriesBasenamePattern);

    if (match) {
        const show = match[1].trim();
        // Keep the canonical "S##E##" label (re-emitted from the captured
        // groups so it is consistently formatted) followed by the episode
        // title remainder. e.g. groups → "S01E09 ライオンを助けたい!".
        const title = `S${match[2]}E${match[3]}${match[4]}`.trim();
        return { show: show.length > 0 ? show : undefined, title };
    }

    // No season/episode marker → treat the whole thing as a film title.
    return { show: undefined, title: cleaned };
};
