export interface TargetEpisode {
    mediaType: 'tv';
    tmdbId: number;
    season: number;
    episode: number;
    title: string;
}
export interface TargetWord {
    lemma: string;
    reading?: string | null;
    gloss?: string | null;
    reason: string;
    count: number;
    firstAtMs: number;
    firstCueIndex: number;
    exampleCue: string;
    score: number;
    recall: number;
    episodesAway: number;
}
export type TargetDecision = 'target_accepted' | 'target_dismissed_known' | 'target_dismissed_not_this';
export interface TargetPreparation {
    account: string;
    identity: TargetEpisode;
    targets: TargetWord[];
    cardEnabled: boolean;
    autoMineToAnki: boolean;
}
export interface TargetFeedback {
    id: string;
    kind: TargetDecision;
    lang: string;
    lemma: string;
    source: string;
    pos: null;
    intervalDays: null;
    occurredAtMs: number;
    createdAtMs: number;
}
export function feedback(identity: TargetEpisode, lang: string, lemma: string, kind: TargetDecision): TargetFeedback {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        kind,
        lang,
        lemma,
        source: `episode:${identity.tmdbId}:S${identity.season}E${identity.episode}`,
        pos: null,
        intervalDays: null,
        occurredAtMs: now,
        createdAtMs: now,
    };
}
export interface HeardTargetMine {
    account: string;
    episodeId: string;
    tmdb: number;
    lineStartMs: number;
    occurredAtMs: number;
    lang: string;
    lineText: string;
    surface: string;
    lemma: string;
    reading?: string | null;
    gloss?: string | null;
    imageBase64?: string;
    exportToAnki: boolean;
}
