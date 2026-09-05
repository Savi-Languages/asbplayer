import type { SaviToken } from './daemon-client';
import type { SaviTokenizeResponse } from './messages';

type Tokenizations = { tokens: SaviToken[]; rawTokens?: SaviToken[] };

/** One local tokenizer cache for hover, target decoration and heard-line mining.
 *  Language belongs in the key. Failed/offline responses never poison it. */
export class SharedTokenCache {
    private readonly entries = new Map<string, Tokenizations>();
    private readonly flights = new Map<string, Promise<Tokenizations>>();
    constructor(
        private readonly fetch: (lang: string, text: string) => Promise<SaviToken[] | Tokenizations>,
        private readonly limit = 64
    ) {}
    private load(lang: string, text: string): Promise<Tokenizations> {
        const key = JSON.stringify([lang, text]);
        const cached = this.entries.get(key);
        if (cached) return Promise.resolve(cached);
        const flight = this.flights.get(key);
        if (flight) return flight;
        const pending = this.fetch(lang, text)
            .then((value) => {
                const result = Array.isArray(value) ? { tokens: value } : value;
                if (
                    [result.tokens, ...(result.rawTokens ? [result.rawTokens] : [])].some(
                        (tokens) => tokens.map((token) => token.text).join('') !== text
                    )
                )
                    throw new Error('Tokenizer surface mismatch');
                if (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
                this.entries.set(key, result);
                return result;
            })
            .finally(() => this.flights.delete(key));
        this.flights.set(key, pending);
        return pending;
    }
    async get(lang: string, text: string): Promise<SaviToken[]> {
        return (await this.load(lang, text)).tokens;
    }
    async getRaw(lang: string, text: string): Promise<SaviToken[]> {
        const result = await this.load(lang, text);
        if (!result.rawTokens) {
            this.entries.delete(JSON.stringify([lang, text]));
            throw new Error('Update the daemon to enable target analysis');
        }
        return result.rawTokens;
    }
}
export const subtitleTokens = new SharedTokenCache(async (lang, text) => {
    const response: SaviTokenizeResponse = await browser.runtime.sendMessage({
        sender: 'savi-video',
        message: { command: 'savi-tokenize', lang, text },
    });
    if (!response?.tokens) throw new Error('Local tokenizer unavailable');
    return response;
});
