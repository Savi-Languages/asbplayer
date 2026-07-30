// Speech-exposure accrual for measured WPM (SV-30).
//
// The subtitle controller already tells us every primary-track cue that starts
// showing (the same hook the encounter reporter rides); this sums their
// durations and token counts between engagement-clock flushes, so each
// ≤5-minute session block carries the speech that actually played during it.
// Cues on track 0 are sequential in practice, so summing durations is the
// overlap-merged speech time.

/** Raw whitespace tokens — the show-simulation WPM convention (function words
 *  count, no analyzer involved). Matches packages/ui's countSpokenTokens. */
export const countSpokenTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const PRIMARY_TRACK = 0;

/** The displayed-cue slice this needs (structurally satisfied by asbplayer's
 *  SubtitleModel). */
export interface ShownSubtitleLike {
    readonly text: string;
    readonly start: number; // ms, media time
    readonly end: number;
    readonly track?: number;
}

export interface SpeechStats {
    speakingMs: number;
    spokenTokenCount: number;
}

export class SpeechAccumulator {
    private _speakingMs = 0;
    private _spokenTokenCount = 0;

    /** Record a cue that started showing. Secondary tracks (the known-language
     *  subs) are not the speech being learned from — only track 0 counts. A
     *  degenerate cue (blank text or no span) carries no speech: counting its
     *  half would skew the ratio, so it contributes nothing. */
    addShownSubtitle(subtitle: ShownSubtitleLike): void {
        if ((subtitle.track ?? PRIMARY_TRACK) !== PRIMARY_TRACK) {
            return;
        }
        const durationMs = subtitle.end - subtitle.start;
        const tokens = countSpokenTokens(subtitle.text ?? '');
        if (durationMs <= 0 || tokens === 0) {
            return;
        }
        this._speakingMs += durationMs;
        this._spokenTokenCount += tokens;
    }

    /** Take everything accrued since the last drain — or `undefined` unless
     *  BOTH halves are positive (a WPM datum needs both; the daemon drops a
     *  lone half anyway, so never send one). */
    drain(): SpeechStats | undefined {
        const out =
            this._speakingMs > 0 && this._spokenTokenCount > 0
                ? { speakingMs: this._speakingMs, spokenTokenCount: this._spokenTokenCount }
                : undefined;
        this._speakingMs = 0;
        this._spokenTokenCount = 0;
        return out;
    }
}
