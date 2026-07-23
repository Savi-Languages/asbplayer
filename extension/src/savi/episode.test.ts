import {
    deriveEpisodeId,
    deriveShowAndTitle,
    deriveShowAndTitleFromBasename,
    netflixShowAndTitleFromDom,
    showAndTitleFromDocumentTitle,
    slugify,
    stripSiteSuffix,
} from './episode';

describe('slugify', () => {
    it('lowercases and dashes Latin titles', () => {
        expect(slugify('Watch Better Call Saul | Netflix')).toBe('watch-better-call-saul-netflix');
    });

    it('keeps unicode letters so Japanese titles survive', () => {
        expect(slugify('名探偵コナン 第1話')).toBe('名探偵コナン-第1話');
    });

    it('never produces path separators or traversal sequences', () => {
        const slug = slugify('../..\\evil/title .. here');
        expect(slug).not.toContain('/');
        expect(slug).not.toContain('\\');
        expect(slug).not.toContain('..');
    });

    it('falls back to "episode" when nothing survives', () => {
        expect(slugify('!!! ###')).toBe('episode');
        expect(slugify('')).toBe('episode');
    });

    it('caps very long titles', () => {
        expect(slugify('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    });
});

describe('stripSiteSuffix', () => {
    it('strips a trailing " - Netflix" / " | Netflix" suffix', () => {
        expect(stripSiteSuffix('Dark - Netflix')).toBe('Dark');
        expect(stripSiteSuffix('Dark | Netflix')).toBe('Dark');
    });

    it('strips a trailing " - YouTube" suffix', () => {
        expect(stripSiteSuffix('Some Great Video - YouTube')).toBe('Some Great Video');
    });

    it('leaves an internal dash that is part of the real title alone', () => {
        expect(stripSiteSuffix('Episode 3 - The Reveal')).toBe('Episode 3 - The Reveal');
    });

    it('is a no-op for an unknown / missing suffix', () => {
        expect(stripSiteSuffix('Just A Title')).toBe('Just A Title');
    });
});

describe('deriveEpisodeId — Netflix', () => {
    it('uses the /watch/<videoId> path segment, ignoring trackId', () => {
        expect(
            deriveEpisodeId('https://www.netflix.com/watch/81932329?trackId=255824129&tctx=0%2C0%2C', 'Dark | Netflix')
        ).toBe('netflix:81932329');
    });

    it('derives the id with no query params at all', () => {
        expect(deriveEpisodeId('https://www.netflix.com/watch/70143836', 'Breaking Bad | Netflix')).toBe(
            'netflix:70143836'
        );
    });

    it('handles a locale-prefixed watch path', () => {
        expect(deriveEpisodeId('https://www.netflix.com/gb/watch/81932329?trackId=abc', 'Dark')).toBe(
            'netflix:81932329'
        );
    });

    it('falls back to hostname:slug on a non-watch Netflix page (no videoId)', () => {
        expect(deriveEpisodeId('https://www.netflix.com/browse', 'Home - Netflix')).toBe('netflix.com:home');
    });
});

describe('deriveEpisodeId — YouTube', () => {
    it('uses the ?v= param on a watch URL', () => {
        expect(deriveEpisodeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'Never Gonna - YouTube')).toBe(
            'youtube:dQw4w9WgXcQ'
        );
    });

    it('uses the path segment for a youtu.be short link', () => {
        expect(deriveEpisodeId('https://youtu.be/dQw4w9WgXcQ?si=xyz', 'Never Gonna')).toBe('youtube:dQw4w9WgXcQ');
    });

    it('handles music.youtube.com via the ?v= param', () => {
        expect(deriveEpisodeId('https://music.youtube.com/watch?v=abc123', 'Song')).toBe('youtube:abc123');
    });

    it('falls back to hostname:slug when ?v= is missing', () => {
        expect(deriveEpisodeId('https://www.youtube.com/feed/subscriptions', 'Subscriptions - YouTube')).toBe(
            'youtube.com:subscriptions'
        );
    });
});

describe('deriveEpisodeId — generic fallback', () => {
    it('uses hostname:slug(title) with no date for an unknown host', () => {
        expect(
            deriveEpisodeId('https://www.crunchyroll.com/watch/abc/something', 'Naruto Episode 1 | Crunchyroll')
        ).toBe('crunchyroll.com:naruto-episode-1');
    });

    it('strips a leading www. from the hostname namespace', () => {
        expect(deriveEpisodeId('https://www.example.org/video', 'My Video')).toBe('example.org:my-video');
    });

    it('is stable across visits (no date component)', () => {
        const a = deriveEpisodeId('https://www.example.org/video', 'My Video');
        const b = deriveEpisodeId('https://www.example.org/video', 'My Video');
        expect(a).toBe(b);
        expect(a).not.toMatch(/\d{8}/); // no YYYYMMDD date suffix
    });

    it('falls back to a bare slug when the url is unparseable', () => {
        expect(deriveEpisodeId('not a url', 'Some Title - Netflix')).toBe('some-title');
    });

    it('falls back to a bare slug when the url is empty', () => {
        expect(deriveEpisodeId('', 'Mystery Show')).toBe('mystery-show');
    });

    it('produces a daemon-safe fallback id (no separators / traversal)', () => {
        const id = deriveEpisodeId('https://x.test/v', '日本語/タイトル..テスト');
        expect(id.length).toBeGreaterThan(0);
        expect(id.split(':').pop()).not.toContain('/');
        expect(id.split(':').pop()).not.toContain('\\');
        expect(id.split(':').pop()).not.toContain('..');
    });

    it('never throws on garbage input', () => {
        expect(() => deriveEpisodeId(null as unknown as string, undefined as unknown as string)).not.toThrow();
    });
});

describe('netflixShowAndTitleFromDom', () => {
    it('combines series name + episode label into show/title', () => {
        expect(netflixShowAndTitleFromDom('Dark', 'S1:E3 Secrets')).toEqual({ show: 'Dark', title: 'S1:E3 Secrets' });
    });

    it('treats a lone series-name (film) as the title with no show', () => {
        expect(netflixShowAndTitleFromDom('The Irishman', undefined)).toEqual({
            show: undefined,
            title: 'The Irishman',
        });
    });

    it('uses a lone episode label as the title', () => {
        expect(netflixShowAndTitleFromDom(undefined, 'Pilot')).toEqual({ show: undefined, title: 'Pilot' });
    });

    it('returns undefined when neither is present', () => {
        expect(netflixShowAndTitleFromDom(undefined, undefined)).toBeUndefined();
        expect(netflixShowAndTitleFromDom('   ', '  ')).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
        expect(netflixShowAndTitleFromDom('  Dark  ', '  Alpha and Omega  ')).toEqual({
            show: 'Dark',
            title: 'Alpha and Omega',
        });
    });
});

describe('showAndTitleFromDocumentTitle', () => {
    it('strips the "Watch " prefix and site suffix', () => {
        expect(showAndTitleFromDocumentTitle('Watch Dark | Netflix')).toEqual({ show: undefined, title: 'Dark' });
    });

    it('strips a " - Netflix" suffix', () => {
        expect(showAndTitleFromDocumentTitle('Dark - Netflix')).toEqual({ show: undefined, title: 'Dark' });
    });

    it('falls back to the raw title when stripping leaves nothing', () => {
        expect(showAndTitleFromDocumentTitle('Netflix')).toEqual({ show: undefined, title: 'Netflix' });
    });

    it('leaves a plain title untouched', () => {
        expect(showAndTitleFromDocumentTitle('My Home Movie')).toEqual({ show: undefined, title: 'My Home Movie' });
    });
});

describe('deriveShowAndTitle', () => {
    it('prefers the Netflix DOM overlay when present on a netflix page', () => {
        expect(
            deriveShowAndTitle('https://www.netflix.com/watch/81932329', 'Watch Dark | Netflix', {
                seriesName: 'Dark',
                episodeLabel: 'S1:E3 Secrets',
            })
        ).toEqual({ show: 'Dark', title: 'S1:E3 Secrets' });
    });

    it('falls back to document.title when the Netflix overlay is empty', () => {
        expect(
            deriveShowAndTitle('https://www.netflix.com/watch/81932329', 'Watch Dark | Netflix', {
                seriesName: undefined,
                episodeLabel: undefined,
            })
        ).toEqual({ show: undefined, title: 'Dark' });
    });

    it('ignores Netflix DOM hints on a non-netflix page', () => {
        expect(
            deriveShowAndTitle('https://www.youtube.com/watch?v=abc', 'Cool Video - YouTube', {
                seriesName: 'Should Be Ignored',
            })
        ).toEqual({ show: undefined, title: 'Cool Video' });
    });

    it('uses document.title when no DOM hints are passed', () => {
        expect(deriveShowAndTitle('https://www.netflix.com/watch/1', 'Watch Better Call Saul | Netflix')).toEqual({
            show: undefined,
            title: 'Better Call Saul',
        });
    });

    it('never throws on an unparseable url', () => {
        expect(() => deriveShowAndTitle('::::', 'whatever')).not.toThrow();
        expect(deriveShowAndTitle('::::', 'whatever')).toEqual({ show: undefined, title: 'whatever' });
    });
});

describe('deriveShowAndTitleFromBasename', () => {
    it('splits a Japanese series basename into show + S##E## title', () => {
        expect(deriveShowAndTitleFromBasename('ライオンの隠れ家 S01E09 ライオンを助けたい!')).toEqual({
            show: 'ライオンの隠れ家',
            title: 'S01E09 ライオンを助けたい!',
        });
    });

    it('splits a Latin series basename into show + S##E## title', () => {
        expect(deriveShowAndTitleFromBasename('Alice in Borderland S02E03 Knight of Swords')).toEqual({
            show: 'Alice in Borderland',
            title: 'S02E03 Knight of Swords',
        });
    });

    it('treats a film basename (no S##E##) as the title with no show', () => {
        expect(deriveShowAndTitleFromBasename('君の名は。')).toEqual({ show: undefined, title: '君の名は。' });
    });

    it('returns an empty title for an empty basename', () => {
        expect(deriveShowAndTitleFromBasename('')).toEqual({ title: '' });
    });

    it('strips a trailing subtitle-file extension', () => {
        expect(deriveShowAndTitleFromBasename('Alice in Borderland S02E03 Knight of Swords.srt')).toEqual({
            show: 'Alice in Borderland',
            title: 'S02E03 Knight of Swords',
        });
        // A film basename with an extension stays a film.
        expect(deriveShowAndTitleFromBasename('君の名は。.vtt')).toEqual({ show: undefined, title: '君の名は。' });
        expect(deriveShowAndTitleFromBasename('Some Movie.ass')).toEqual({ show: undefined, title: 'Some Movie' });
    });

    it('strips the Netflix track-label tail + IMSC extension', () => {
        expect(
            deriveShowAndTitleFromBasename(
                'Go! Live Your Way S01E15 Episode 15 - es - Spanish (Latin America) [CC].nfimsc'
            )
        ).toEqual({
            show: 'Go! Live Your Way',
            title: 'S01E15 Episode 15',
        });
    });

    it('strips a parenthesized language label followed by a bare [CC]', () => {
        expect(deriveShowAndTitleFromBasename('Dark S02E03 The Heist (English) [CC]')).toEqual({
            show: 'Dark',
            title: 'S02E03 The Heist',
        });
    });

    it('never eats real dashed titles as track labels', () => {
        expect(deriveShowAndTitleFromBasename('Spider-Man - Into the Spider-Verse')).toEqual({
            show: undefined,
            title: 'Spider-Man - Into the Spider-Verse',
        });
    });

    it('handles a single-digit season/episode form', () => {
        expect(deriveShowAndTitleFromBasename('Show S1E9 Foo')).toEqual({ show: 'Show', title: 'S1E9 Foo' });
    });

    it('keeps an S##E## label with no trailing episode title', () => {
        expect(deriveShowAndTitleFromBasename('Dark S01E03')).toEqual({ show: 'Dark', title: 'S01E03' });
    });

    it('strips a parenthesized language tag without touching a non-Latin title', () => {
        expect(deriveShowAndTitleFromBasename('君の名は。 (English)')).toEqual({
            show: undefined,
            title: '君の名は。',
        });
        expect(deriveShowAndTitleFromBasename('Alice in Borderland S02E03 Knight of Swords (English [CC])')).toEqual({
            show: 'Alice in Borderland',
            title: 'S02E03 Knight of Swords',
        });
    });

    it('strips a dotted ISO language code suffix', () => {
        expect(deriveShowAndTitleFromBasename('Alice in Borderland S02E03 Knight of Swords .en-US.srt')).toEqual({
            show: 'Alice in Borderland',
            title: 'S02E03 Knight of Swords',
        });
    });

    it('does NOT over-strip a real trailing word that is not a language tag', () => {
        // No parens and no dot → "English" here is just a title word, kept.
        expect(deriveShowAndTitleFromBasename('An English Affair')).toEqual({
            show: undefined,
            title: 'An English Affair',
        });
    });

    it('coerces non-string input to an empty title and never throws', () => {
        expect(() => deriveShowAndTitleFromBasename(undefined as unknown as string)).not.toThrow();
        expect(deriveShowAndTitleFromBasename(undefined as unknown as string)).toEqual({ title: '' });
        expect(deriveShowAndTitleFromBasename(null as unknown as string)).toEqual({ title: '' });
        expect(deriveShowAndTitleFromBasename(42 as unknown as string)).toEqual({ title: '' });
    });

    it('trims surrounding whitespace before parsing', () => {
        expect(deriveShowAndTitleFromBasename('   Alice in Borderland S02E03 Knight of Swords   ')).toEqual({
            show: 'Alice in Borderland',
            title: 'S02E03 Knight of Swords',
        });
    });
});
