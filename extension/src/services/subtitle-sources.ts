export interface JimakuEntry {
    id: number;
    anilist_id?: number;
    name: string;
    japanese_name?: string;
    english_name?: string;
    created_at?: string;
    last_updated_at?: string;
    anime?: boolean;
}

export interface JimakuFile {
    id: number;
    name: string;
    url: string;
    created_at?: string;
    size?: number;
}

export interface JimakuRateLimit {
    limit?: number;
    remaining?: number;
    resetAfterSeconds?: number;
}

export interface JimakuResponse<T> {
    data: T;
    rateLimit: JimakuRateLimit;
}

interface JimakuErrorPayload {
    error?: string;
    message?: string;
}

const parseJsonSafely = (text: string): unknown | undefined => {
    if (text.length === 0) {
        return undefined;
    }

    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const defaultJimakuBaseUrl = 'https://jimaku.cc/api';

type TrustedHtmlPolicyLike = {
    createHTML: (value: string) => string | TrustedHTML;
};

let trustedHtmlPolicy: TrustedHtmlPolicyLike | undefined;

const createTrustedHtml = (html: string): string | TrustedHTML => {
    const trustedTypesApi = (
        globalThis as typeof globalThis & {
            trustedTypes?: {
                createPolicy: (
                    name: string,
                    policy: { createHTML: (value: string) => string }
                ) => TrustedHtmlPolicyLike;
                getPolicy?: (name: string) => TrustedHtmlPolicyLike | null;
            };
        }
    ).trustedTypes;

    if (!trustedTypesApi) {
        return html;
    }

    if (!trustedHtmlPolicy) {
        try {
            trustedHtmlPolicy = trustedTypesApi.createPolicy('asbplayer-subtitle-sources', {
                createHTML: (value) => value,
            });
        } catch (error) {
            trustedHtmlPolicy = trustedTypesApi.getPolicy?.('asbplayer-subtitle-sources') ?? undefined;
        }
    }

    return trustedHtmlPolicy ? trustedHtmlPolicy.createHTML(html) : html;
};

const parseHtmlDocument = (html: string) => {
    const trustedHtml = createTrustedHtml(html);
    return new DOMParser().parseFromString(trustedHtml as string, 'text/html');
};

const parseRateLimit = (headers: Headers): JimakuRateLimit => ({
    limit: parseOptionalInt(headers.get('x-ratelimit-limit')),
    remaining: parseOptionalInt(headers.get('x-ratelimit-remaining')),
    resetAfterSeconds: parseOptionalFloat(headers.get('x-ratelimit-reset-after')),
});

const parseOptionalInt = (value: string | null): number | undefined => {
    if (value === null) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
};

const parseOptionalFloat = (value: string | null): number | undefined => {
    if (value === null) {
        return undefined;
    }

    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export interface JimakuClientOptions {
    apiKey: string;
    baseUrl?: string;
    minRequestIntervalMs?: number;
}

export class JimakuClient {
    private readonly _apiKey: string;
    private readonly _baseUrl: string;
    private readonly _minRequestIntervalMs: number;
    private _lastRequestTimestampMs?: number;
    private _lastRateLimit?: JimakuRateLimit;

    constructor({ apiKey, baseUrl = defaultJimakuBaseUrl, minRequestIntervalMs = 1000 }: JimakuClientOptions) {
        const trimmedApiKey = apiKey.trim();

        if (trimmedApiKey.length === 0) {
            throw new Error('Jimaku API key cannot be empty or whitespace-only');
        }

        this._apiKey = trimmedApiKey;
        this._baseUrl = baseUrl;
        this._minRequestIntervalMs = minRequestIntervalMs;
    }

    async searchEntries(query: string, anime?: boolean): Promise<JimakuResponse<JimakuEntry[]>> {
        const searchParams = new URLSearchParams();
        searchParams.set('query', query);
        if (anime !== undefined) {
            searchParams.set('anime', `${anime}`);
        }
        return await this._request<JimakuEntry[]>(`entries/search?${searchParams.toString()}`);
    }

    async getEntry(id: number): Promise<JimakuResponse<JimakuEntry>> {
        return await this._request<JimakuEntry>(`entries/${id}`);
    }

    async getFiles(
        id: number,
        options?: {
            episode?: number;
        }
    ): Promise<JimakuResponse<JimakuFile[]>> {
        const searchParams = new URLSearchParams();

        if (options?.episode !== undefined) {
            searchParams.set('episode', `${options.episode}`);
        }

        const query = searchParams.toString();
        const endpoint = query.length > 0 ? `entries/${id}/files?${query}` : `entries/${id}/files`;
        return await this._request<JimakuFile[]>(endpoint);
    }

    private async _request<T>(endpoint: string): Promise<JimakuResponse<T>> {
        await this._waitIfNeeded();
        const response = await fetch(new URL(endpoint, `${this._baseUrl}/`).toString(), {
            headers: {
                Authorization: this._apiKey,
            },
        });
        this._lastRequestTimestampMs = Date.now();

        const rateLimit = parseRateLimit(response.headers);
        this._lastRateLimit = rateLimit;
        const bodyText = await response.text();
        const parsedBody = parseJsonSafely(bodyText) as T | JimakuErrorPayload | undefined;

        if (!response.ok) {
            const errorMessage =
                (parsedBody as JimakuErrorPayload | undefined)?.error ??
                (parsedBody as JimakuErrorPayload | undefined)?.message ??
                `Jimaku request failed with status ${response.status}`;
            throw new Error(errorMessage);
        }

        if (parsedBody === undefined) {
            throw new Error('Jimaku request failed: expected a JSON response body');
        }

        return {
            data: parsedBody as T,
            rateLimit,
        };
    }

    private async _waitIfNeeded() {
        // Prioritize server-reported rate limit data over hard-coded interval
        if (this._lastRateLimit !== undefined) {
            const { remaining, resetAfterSeconds } = this._lastRateLimit;

            if (remaining !== undefined && remaining <= 0 && resetAfterSeconds !== undefined && resetAfterSeconds > 0) {
                await new Promise((resolve) => setTimeout(resolve, resetAfterSeconds * 1000));
                return;
            }

            // If we still have quota remaining, skip the hard-coded wait
            if (remaining !== undefined && remaining > 0) {
                return;
            }
        }

        if (this._lastRequestTimestampMs === undefined || this._minRequestIntervalMs <= 0) {
            return;
        }

        const elapsedMs = Date.now() - this._lastRequestTimestampMs;
        const remainingMs = this._minRequestIntervalMs - elapsedMs;

        if (remainingMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, remainingMs));
        }
    }
}

// ── OpenSubtitles.com (SV-8 fallback) ─────────────────────────────────────
// Fallback subtitle source when the streaming player exposes no track in the
// learner's language. Uses the opensubtitles.com REST API v1 with the user's
// own consumer API key (https://www.opensubtitles.com/vi/consumers). Docs:
// https://opensubtitles.stoplight.io/. Run from the background service worker
// (host permission for *.opensubtitles.com bypasses CORS). NOTE: browsers forbid
// overriding User-Agent via fetch, so in the extension the request carries the
// browser's own UA; if OpenSubtitles ever rejects that, add a
// declarativeNetRequest header rule for api.opensubtitles.com.

export interface OpenSubtitlesFile {
    fileId: number;
    fileName: string;
    language?: string;
    downloadCount?: number;
}

export interface OpenSubtitlesDownload {
    link: string;
    fileName: string;
}

export interface OpenSubtitlesSubtitle {
    fileName: string;
    content: string;
}

export interface OpenSubtitlesSearchQuery {
    query: string;
    /** Comma-separated ISO 639-1 codes, e.g. `es` or `es,en`. */
    languages: string;
    seasonNumber?: number;
    episodeNumber?: number;
}

const defaultOpenSubtitlesBaseUrl = 'https://api.opensubtitles.com/api/v1';
const defaultOpenSubtitlesUserAgent = 'savi-asbplayer v1.0';

export interface OpenSubtitlesClientOptions {
    apiKey: string;
    baseUrl?: string;
    userAgent?: string;
}

export class OpenSubtitlesClient {
    private readonly _apiKey: string;
    private readonly _baseUrl: string;
    private readonly _userAgent: string;

    constructor({
        apiKey,
        baseUrl = defaultOpenSubtitlesBaseUrl,
        userAgent = defaultOpenSubtitlesUserAgent,
    }: OpenSubtitlesClientOptions) {
        const trimmedApiKey = apiKey.trim();

        if (trimmedApiKey.length === 0) {
            throw new Error('OpenSubtitles API key cannot be empty or whitespace-only');
        }

        this._apiKey = trimmedApiKey;
        this._baseUrl = baseUrl.replace(/\/+$/, '');
        this._userAgent = userAgent;
    }

    private get _headers(): Record<string, string> {
        return { 'Api-Key': this._apiKey, 'User-Agent': this._userAgent, Accept: 'application/json' };
    }

    /** Search subtitles, flattening the results' `files[]` into a ranked list
     *  (the API returns most-relevant first). */
    async search({
        query,
        languages,
        seasonNumber,
        episodeNumber,
    }: OpenSubtitlesSearchQuery): Promise<OpenSubtitlesFile[]> {
        const params = new URLSearchParams();
        params.set('query', query);

        const trimmedLanguages = languages.trim().toLowerCase();
        if (trimmedLanguages.length > 0) {
            params.set('languages', trimmedLanguages);
        }
        if (seasonNumber !== undefined) {
            params.set('season_number', `${seasonNumber}`);
        }
        if (episodeNumber !== undefined) {
            params.set('episode_number', `${episodeNumber}`);
        }

        const response = await fetch(`${this._baseUrl}/subtitles?${params.toString()}`, { headers: this._headers });
        const body = await this._json(response);
        const data: any[] = Array.isArray(body?.data) ? body.data : [];
        const files: OpenSubtitlesFile[] = [];

        for (const item of data) {
            const attributes = item?.attributes ?? {};
            for (const file of attributes.files ?? []) {
                if (typeof file?.file_id === 'number') {
                    files.push({
                        fileId: file.file_id,
                        fileName: typeof file.file_name === 'string' ? file.file_name : `${file.file_id}.srt`,
                        language: attributes.language,
                        downloadCount: attributes.download_count,
                    });
                }
            }
        }

        return files;
    }

    /** Exchange a `file_id` for a temporary download link. */
    async requestDownload(fileId: number): Promise<OpenSubtitlesDownload> {
        const response = await fetch(`${this._baseUrl}/download`, {
            method: 'POST',
            headers: { ...this._headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: fileId }),
        });
        const body = await this._json(response);

        if (typeof body?.link !== 'string') {
            throw new Error('OpenSubtitles download response is missing a link');
        }

        return { link: body.link, fileName: typeof body.file_name === 'string' ? body.file_name : `${fileId}.srt` };
    }

    /** Search → download link → fetch the subtitle text of the best match.
     *  `undefined` when the search returns no files; throws on a request error. */
    async fetchBestSubtitle(searchQuery: OpenSubtitlesSearchQuery): Promise<OpenSubtitlesSubtitle | undefined> {
        const files = await this.search(searchQuery);

        if (files.length === 0) {
            return undefined;
        }

        const best = files[0];
        const download = await this.requestDownload(best.fileId);
        const response = await fetch(download.link);

        if (!response.ok) {
            throw new Error(`OpenSubtitles download failed with status ${response.status}`);
        }

        const content = await response.text();
        return { fileName: download.fileName || best.fileName, content };
    }

    private async _json(response: Response): Promise<any> {
        const text = await response.text();
        const parsed = parseJsonSafely(text) as any;

        if (!response.ok) {
            const message =
                parsed?.message ??
                (Array.isArray(parsed?.errors) ? parsed.errors.join(', ') : undefined) ??
                `OpenSubtitles request failed with status ${response.status}`;
            throw new Error(message);
        }

        return parsed;
    }
}
