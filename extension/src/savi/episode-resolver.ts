import type { TargetEpisode } from './target-types';
const normalized = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase();
/** Only anchored episode labels count. Movie titles and arbitrary digits cannot
 *  become an episode identity. Verify the selected season against metadata. */
export async function resolveTargetEpisode(
    get: (path: string) => Promise<any>,
    show: string | undefined,
    label: string
): Promise<TargetEpisode | null> {
    const title = (show ? `${show}/${label}` : label).normalize('NFKC').trim();
    const compact = /^(.*?)\s*(?:\/|:\s*|\s)S\s*(\d{1,2})\s*:?\s*E\s*(\d{1,3})(?:\b|\s)(.*)$/i.exec(title);
    let name: string | undefined;
    let season: number | undefined;
    let episode: number | undefined;
    let episodeName: string | undefined;
    if (compact?.[1]) {
        name = compact[1].trim();
        season = +compact[2];
        episode = +compact[3];
    } else {
        const parts = title.split(/:\s+/);
        for (let i = parts.length - 2; i >= 1; i--) {
            const match = /^(?:Season|Temporada|シーズン)\s*(\d+)$/i.exec(parts[i]);
            if (!match) continue;
            name = parts.slice(0, i).join(': ');
            season = +match[1];
            const tail = parts.slice(i + 1).join(': ');
            const number = /^(?:Episode|Episodio|エピソード)\s*(\d+)(?:\s.*)?$/i.exec(tail);
            if (number) episode = +number[1];
            else episodeName = tail;
            break;
        }
    }
    if (!name || season === undefined || season > 100) return null;
    const hits = (await get(`/v2/shows/search?query=${encodeURIComponent(name)}`)).results.filter(
        (hit: any) => normalized(hit.title) === normalized(name!)
    );
    if (hits.length !== 1) return null;
    const hit = hits[0];
    const detail = await get(`/v2/shows/${hit.tmdbId}/season/${season}`);
    const episodes = detail.season.episodes.filter((ep: any) =>
        episode !== undefined
            ? ep.episodeNumber === episode
            : episodeName && ep.name && normalized(ep.name) === normalized(episodeName)
    );
    if (episodes.length !== 1) return null;
    return {
        mediaType: 'tv',
        tmdbId: hit.tmdbId,
        season,
        episode: episodes[0].episodeNumber,
        title: detail.show.title,
    };
}
