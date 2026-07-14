import { JimakuClient, OpenSubtitlesClient } from './subtitle-sources';

const createResponse = ({
    ok = true,
    status = 200,
    statusText = 'OK',
    jsonData,
    textData,
    headers = {},
}: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    jsonData?: unknown;
    textData?: string;
    headers?: Record<string, string>;
}) => {
    return {
        ok,
        status,
        statusText,
        headers: {
            get: (key: string) => headers[key.toLowerCase()] ?? null,
        },
        text: async () => (textData !== undefined ? textData : JSON.stringify(jsonData)),
    } as unknown as Response;
};

describe('JimakuClient', () => {
    it('validates api key at construction', () => {
        expect(() => new JimakuClient({ apiKey: '   ' })).toThrow('Jimaku API key cannot be empty or whitespace-only');
    });

    it('searches entries with authorization header', async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            createResponse({
                jsonData: [{ id: 729, name: 'Sousou no Frieren' }],
                headers: {
                    'x-ratelimit-limit': '100',
                    'x-ratelimit-remaining': '99',
                    'x-ratelimit-reset-after': '1.5',
                },
            })
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new JimakuClient({ apiKey: 'test-key', minRequestIntervalMs: 0 });

        const response = await client.searchEntries('Sousou no Frieren');

        expect(fetchMock).toHaveBeenCalledWith('https://jimaku.cc/api/entries/search?query=Sousou+no+Frieren', {
            headers: { Authorization: 'test-key' },
        });
        expect(response.data).toHaveLength(1);
        expect(response.data[0].id).toBe(729);
        expect(response.rateLimit.limit).toBe(100);
        expect(response.rateLimit.remaining).toBe(99);
        expect(response.rateLimit.resetAfterSeconds).toBe(1.5);
    });

    it('searches entries with anime parameter', async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            createResponse({
                jsonData: [{ id: 999, name: 'Some Drama', flags: 2 }],
                headers: {
                    'x-ratelimit-limit': '100',
                    'x-ratelimit-remaining': '98',
                    'x-ratelimit-reset-after': '1.0',
                },
            })
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new JimakuClient({ apiKey: 'test-key', minRequestIntervalMs: 0 });

        const response = await client.searchEntries('Some Drama', false);

        expect(fetchMock).toHaveBeenCalledWith('https://jimaku.cc/api/entries/search?query=Some+Drama&anime=false', {
            headers: { Authorization: 'test-key' },
        });
        expect(response.data[0].name).toBe('Some Drama');
    });

    it('requests files with optional filters', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({ jsonData: [] }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new JimakuClient({ apiKey: 'test-key', minRequestIntervalMs: 0 });

        await client.getFiles(729, { episode: 1 });

        expect(fetchMock).toHaveBeenCalledWith('https://jimaku.cc/api/entries/729/files?episode=1', {
            headers: { Authorization: 'test-key' },
        });
    });

    it('throws parsed error message on failed request', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(createResponse({ ok: false, status: 401, jsonData: { error: 'Unauthorized' } }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new JimakuClient({ apiKey: 'test-key', minRequestIntervalMs: 0 });

        await expect(client.getEntry(123)).rejects.toThrow('Unauthorized');
    });

    it('falls back to status-based error when response is not json', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({ ok: false, status: 503, textData: '<html/>' }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new JimakuClient({ apiKey: 'test-key', minRequestIntervalMs: 0 });

        await expect(client.getEntry(123)).rejects.toThrow('Jimaku request failed with status 503');
    });

    it('throws when successful response does not contain valid json', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({ ok: true, status: 200, textData: '<html/>' }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new JimakuClient({ apiKey: 'test-key', minRequestIntervalMs: 0 });

        await expect(client.getEntry(123)).rejects.toThrow('Jimaku request failed: expected a JSON response body');
    });
});

describe('OpenSubtitlesClient', () => {
    it('validates api key at construction', () => {
        expect(() => new OpenSubtitlesClient({ apiKey: '   ' })).toThrow(
            'OpenSubtitles API key cannot be empty or whitespace-only'
        );
    });

    it('searches with Api-Key/User-Agent headers and flattens files', async () => {
        const fetchMock = jest.fn().mockResolvedValue(
            createResponse({
                jsonData: {
                    data: [
                        {
                            attributes: {
                                language: 'es',
                                download_count: 500,
                                files: [{ file_id: 111, file_name: 'Show.S01E02.es.srt' }],
                            },
                        },
                        {
                            attributes: { language: 'es', files: [{ file_id: 222, file_name: 'other.srt' }] },
                        },
                    ],
                },
            })
        );
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new OpenSubtitlesClient({ apiKey: 'os-key' });

        const files = await client.search({ query: 'Show', languages: 'ES', seasonNumber: 1, episodeNumber: 2 });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(
            'https://api.opensubtitles.com/api/v1/subtitles?query=Show&languages=es&season_number=1&episode_number=2'
        );
        expect(init.headers['Api-Key']).toBe('os-key');
        expect(init.headers['User-Agent']).toContain('savi');
        expect(files).toHaveLength(2);
        expect(files[0]).toEqual({ fileId: 111, fileName: 'Show.S01E02.es.srt', language: 'es', downloadCount: 500 });
    });

    it('requests a download link by file_id', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(
                createResponse({ jsonData: { link: 'https://dl.opensubtitles.com/x.srt', file_name: 'x.srt' } })
            );
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new OpenSubtitlesClient({ apiKey: 'os-key' });

        const download = await client.requestDownload(111);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.opensubtitles.com/api/v1/download');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ file_id: 111 });
        expect(download).toEqual({ link: 'https://dl.opensubtitles.com/x.srt', fileName: 'x.srt' });
    });

    it('fetchBestSubtitle searches, downloads, and returns the subtitle text', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(
                createResponse({
                    jsonData: { data: [{ attributes: { files: [{ file_id: 7, file_name: 'a.srt' }] } }] },
                })
            )
            .mockResolvedValueOnce(
                createResponse({ jsonData: { link: 'https://dl.opensubtitles.com/a.srt', file_name: 'a.srt' } })
            )
            .mockResolvedValueOnce(createResponse({ textData: '1\n00:00:01,000 --> 00:00:02,000\nHola\n' }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new OpenSubtitlesClient({ apiKey: 'os-key' });

        const subtitle = await client.fetchBestSubtitle({ query: 'Show', languages: 'es' });

        expect(subtitle?.fileName).toBe('a.srt');
        expect(subtitle?.content).toContain('Hola');
        expect(fetchMock.mock.calls[2][0]).toBe('https://dl.opensubtitles.com/a.srt');
    });

    it('fetchBestSubtitle returns undefined when the search has no files', async () => {
        const fetchMock = jest.fn().mockResolvedValue(createResponse({ jsonData: { data: [] } }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new OpenSubtitlesClient({ apiKey: 'os-key' });

        expect(await client.fetchBestSubtitle({ query: 'Nothing', languages: 'es' })).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws the server message on an error response', async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValue(createResponse({ ok: false, status: 403, jsonData: { message: 'invalid api key' } }));
        global.fetch = fetchMock as unknown as typeof fetch;
        const client = new OpenSubtitlesClient({ apiKey: 'os-key' });

        await expect(client.search({ query: 'Show', languages: 'es' })).rejects.toThrow('invalid api key');
    });
});
