import { describe, expect, it } from '@jest/globals';
import { localVideoName, looksLikeVideoFile, parseVideoFilename, videoFilenameFromUrl } from './local-video';

describe('parseVideoFilename — series', () => {
    it('parses the standard dotted release name', () => {
        expect(parseVideoFilename('Some.Show.Name.S01E02.1080p.WEB-DL.DDP5.1.x264-GROUP.mkv')).toEqual({
            title: 'Some Show Name',
            seasonNumber: 1,
            episodeNumber: 2,
            year: undefined,
        });
    });

    it('parses a spaced, hand-named file', () => {
        expect(parseVideoFilename('Some Show Name - S01E02 - The Episode Title.mkv')).toMatchObject({
            title: 'Some Show Name',
            seasonNumber: 1,
            episodeNumber: 2,
        });
    });

    it('accepts the older 1x02 convention', () => {
        expect(parseVideoFilename('Some.Show.1x02.HDTV.avi')).toMatchObject({
            title: 'Some Show',
            seasonNumber: 1,
            episodeNumber: 2,
        });
    });

    it('accepts the spelled-out form', () => {
        expect(parseVideoFilename('Some Show Season 2 Episode 5.mp4')).toMatchObject({
            title: 'Some Show',
            seasonNumber: 2,
            episodeNumber: 5,
        });
    });

    it('keeps two-digit seasons and three-digit episodes apart', () => {
        expect(parseVideoFilename('Show.S12E103.1080p.mkv')).toMatchObject({
            seasonNumber: 12,
            episodeNumber: 103,
        });
    });

    it('does not read a longer number as a season marker', () => {
        // S01E099999 must not parse as episode 999 — the \d guard exists for this.
        const parsed = parseVideoFilename('Show.S01E099999.mkv');
        expect(parsed.episodeNumber).toBeUndefined();
    });
});

describe('parseVideoFilename — films', () => {
    it('splits the title from a release year', () => {
        expect(parseVideoFilename('Some.Film.2019.1080p.BluRay.x264-GRP.mkv')).toEqual({
            title: 'Some Film',
            year: 2019,
        });
    });

    it('reads a parenthesised year', () => {
        expect(parseVideoFilename('Some Film (2019).mp4')).toEqual({ title: 'Some Film', year: 2019 });
    });

    it('keeps a numeric title that IS the film', () => {
        // "1917" and "2012" are films. A leading year is the title, not metadata
        // — which is why the year rule only fires once a title word precedes it.
        expect(parseVideoFilename('1917.2019.1080p.BluRay.x264.mkv')).toEqual({ title: '1917', year: 2019 });
        expect(parseVideoFilename('2012.mkv')).toMatchObject({ title: '2012' });
    });

    it('stops at the first quality marker when there is no year', () => {
        expect(parseVideoFilename('Some.Film.1080p.WEBRip.x265-GRP.mkv')).toMatchObject({ title: 'Some Film' });
    });
});

describe('parseVideoFilename — the truncate-not-scrub rule', () => {
    it('keeps title words that double as release junk', () => {
        // Scrubbing junk tokens wherever they appear would gut these. Each
        // word here is a real title word AND a common release tag.
        expect(parseVideoFilename('Dual.2022.1080p.WEB-DL.mkv')).toMatchObject({ title: 'Dual' });
        expect(parseVideoFilename('The.Proposal.2009.720p.mkv')).toMatchObject({ title: 'The Proposal' });
    });

    it('does not mistake a hyphenated title for an episode number', () => {
        // The bare-episode rule needs " - N " with spaces, so "Spider-Man 2"
        // stays a film title rather than becoming episode 2.
        const parsed = parseVideoFilename('Spider-Man 2.mkv');
        expect(parsed.episodeNumber).toBeUndefined();
        expect(parsed.title).toBe('Spider-Man 2');
    });

    it('leaves dots alone in a spaced name that legitimately contains them', () => {
        // Only a name with NO spaces gets dot-to-space treatment; otherwise
        // "Dr. Strangelove" would become "Dr Strangelove".
        expect(parseVideoFilename('Dr. Strangelove (1964).mkv')).toMatchObject({ title: 'Dr. Strangelove' });
    });
});

describe('parseVideoFilename — fansub naming', () => {
    it('reads a bracketed group and a bare episode number', () => {
        expect(parseVideoFilename('[SubsPlease] Some Anime - 12 (1080p) [A1B2C3D4].mkv')).toMatchObject({
            title: 'Some Anime',
            episodeNumber: 12,
        });
    });

    it('prefers a season marker over the bare-number rule', () => {
        expect(parseVideoFilename('[Group] Some Anime - S02E03 - 1080p.mkv')).toMatchObject({
            title: 'Some Anime',
            seasonNumber: 2,
            episodeNumber: 3,
        });
    });
});

describe('parseVideoFilename — degenerate input', () => {
    it('never throws and returns an empty title when there is nothing to read', () => {
        for (const input of ['', '   ', '.mkv', undefined as unknown as string, null as unknown as string]) {
            expect(() => parseVideoFilename(input)).not.toThrow();
            expect(parseVideoFilename(input).title).toBe('');
        }
    });

    it('strips a directory path', () => {
        expect(parseVideoFilename('/Users/me/Videos/Some.Film.2019.1080p.mkv')).toMatchObject({
            title: 'Some Film',
        });
    });
});

describe('videoFilenameFromUrl', () => {
    it('reads the filename out of a file:// URL, percent-decoding it', () => {
        expect(videoFilenameFromUrl('file:///Users/me/Videos/Some%20Film%20(2019).mkv')).toBe('Some Film (2019).mkv');
    });

    it('reads a video filename from an http URL', () => {
        expect(videoFilenameFromUrl('https://example.com/media/Show.S01E02.mkv?token=abc')).toBe('Show.S01E02.mkv');
    });

    it('is undefined when the URL does not name a video file', () => {
        // The signal to fall back to document.title.
        expect(videoFilenameFromUrl('https://www.netflix.com/watch/81932329')).toBeUndefined();
        expect(videoFilenameFromUrl('file:///Users/me/notes.txt')).toBeUndefined();
        expect(videoFilenameFromUrl('')).toBeUndefined();
    });
});

describe('looksLikeVideoFile', () => {
    it('accepts the containers a browser can actually play, and common downloads', () => {
        for (const name of ['a.mkv', 'a.mp4', 'a.webm', 'a.avi', 'A.MKV']) {
            expect(looksLikeVideoFile(name)).toBe(true);
        }
    });

    it('rejects everything else', () => {
        for (const name of ['a.srt', 'a.txt', 'a', '', 'mkv']) {
            expect(looksLikeVideoFile(name)).toBe(false);
        }
    });
});

describe('localVideoName', () => {
    it('prefers the URL filename over the page title', () => {
        // A served file can have a page title that is not the episode; the URL
        // is the more reliable of the two.
        expect(localVideoName('file:///Users/me/Some.Show.S01E02.1080p.mkv', 'Video player')).toMatchObject({
            title: 'Some Show',
            seasonNumber: 1,
            episodeNumber: 2,
        });
    });

    it('falls back to the page title when the URL names no video', () => {
        expect(localVideoName('https://example.com/player', 'Some Show S01E02')).toMatchObject({
            title: 'Some Show',
            seasonNumber: 1,
            episodeNumber: 2,
        });
    });

    it('falls back when the URL filename parses to nothing usable', () => {
        expect(localVideoName('file:///Users/me/.mkv', 'Some Film (2019)')).toMatchObject({ title: 'Some Film' });
    });
});
