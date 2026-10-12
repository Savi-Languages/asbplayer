import { deriveEpisodeId } from './episode';

type TrackLanguage = { language: string; episode: string; names: string[] };

/** Keep recording metadata with parsed subtitles, including an app round trip,
 * without turning an inferred audio language into a saved site preference. */
export class SubtitleLanguageContext {
    private pending?: TrackLanguage | null;
    private loaded?: TrackLanguage;

    begin(language: string | undefined, names: string[], url: string, title: string) {
        this.pending =
            language && names.length > 0 ? { language, names, episode: deriveEpisodeId(url, title) ?? url } : null;
    }

    commit(names: string[]) {
        if (this.pending !== undefined && (this.pending === null || this.matches(this.pending.names, names))) {
            this.loaded = this.pending ?? undefined;
            this.pending = undefined;
            return;
        }
        // An older load may finish first. It must not consume the context
        // waiting for a newer load (or keep metadata for unrelated files).
        if (!this.loaded || !this.matches(this.loaded.names, names)) this.loaded = undefined;
    }

    language(names: string[], url: string, title: string): string | undefined {
        const context = this.loaded;
        return context?.episode === (deriveEpisodeId(url, title) ?? url) && this.matches(context.names, names)
            ? context.language
            : undefined;
    }

    private matches(expected: string[], actual: string[]) {
        return expected.length === actual.length && expected.every((name, index) => name === actual[index]);
    }
}
