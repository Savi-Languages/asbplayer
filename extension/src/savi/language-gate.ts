// Should savi's learning layer run on THIS video?
//
// The problem: savi used to activate wherever a subtitle track matched the
// learning language. On YouTube that is nearly always true — it offers
// auto-TRANSLATED caption tracks in dozens of languages, so an English video
// happily presents a Spanish track and the whole learning layer switched itself
// on over English speech. Worse than the visual noise, the watched lines were
// counted as Spanish exposure.
//
// The honest signal is what is being SPOKEN. YouTube marks its speech
// recognition track `kind: "asr"`; that track's language is the audio's
// language, because it was produced FROM the audio. Everything else in the
// list is an offer.
//
// Posture: FAIL OPEN. Deactivate only on a positive mismatch. No signal, or no
// configured target language, means run as before — a savi that goes quiet by
// accident loses exposure the user never sees, while a savi that is noisy in
// the wrong place is visible and can be muted by hand.

import { primarySubtag } from './track-select';

export type LanguageGateReason = 'match' | 'mismatch' | 'unknown' | 'muted';

export interface LanguageGateVerdict {
    readonly active: boolean;
    readonly reason: LanguageGateReason;
}

export interface LanguageGateInput {
    /** The language actually spoken, when it could be determined. */
    readonly spokenLanguage: string | undefined;
    /** The learner's target language (roaming setting); '' when unset. */
    readonly targetLanguage: string;
    /** Stable per-video id (deriveEpisodeId); undefined on unidentifiable pages. */
    readonly episodeId?: string;
    /** Episodes the user muted by hand — the escape hatch for sites with no signal. */
    readonly mutedEpisodes?: readonly string[];
}

/**
 * The language being spoken, from a YouTube caption-track list: the `asr`
 * track's language, or undefined when there isn't one.
 *
 * Deliberately total — a malformed entry is skipped rather than thrown, because
 * every failure here must land on "unknown" (and therefore fail open) instead
 * of taking the content script down.
 */
export function spokenLanguageFromTracks(tracks: unknown): string | undefined {
    if (!Array.isArray(tracks)) {
        return undefined;
    }
    for (const track of tracks) {
        if (typeof track !== 'object' || track === null) continue;
        const { kind, languageCode } = track as { kind?: unknown; languageCode?: unknown };
        if (kind !== 'asr') continue;
        if (typeof languageCode !== 'string' || languageCode.trim().length === 0) continue;
        return languageCode;
    }
    return undefined;
}

/** Whether savi's learning layer should run, and why — the `why` is for the
 *  console line and the hush affordance, so a quiet savi is never mysterious. */
export function decideLanguageGate({
    spokenLanguage,
    targetLanguage,
    episodeId,
    mutedEpisodes,
}: LanguageGateInput): LanguageGateVerdict {
    // A hand mute beats every automatic conclusion: it is the user telling us
    // directly, and it is the only recourse where there is no signal at all.
    if (episodeId !== undefined && mutedEpisodes?.includes(episodeId)) {
        return { active: false, reason: 'muted' };
    }

    const target = targetLanguage.trim();
    if (target.length === 0 || spokenLanguage === undefined) {
        return { active: true, reason: 'unknown' };
    }

    const spoken = spokenLanguage.trim();
    if (spoken.length === 0) {
        return { active: true, reason: 'unknown' };
    }

    // Compare primary subtags: es-419 and es-ES are both Spanish for our purposes.
    return primarySubtag(spoken) === primarySubtag(target)
        ? { active: true, reason: 'match' }
        : { active: false, reason: 'mismatch' };
}
