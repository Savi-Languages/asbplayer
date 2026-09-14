// Shared capture finish wording for video and Spotify adapters.
export interface FinishNotice {
    readonly text: string;
    /** Loud, in the tab console where the person watching is — the treatment
     *  `condenseWarning` already gets. */
    readonly consoleError?: string;
}

export const finishNotice = (info: {
    totalLines?: number;
    keptDurationMs?: number;
    transcriptOnly?: boolean;
    audioRequested?: boolean;
    audioLost?: string | null;
    condenseWarning?: string | null;
}): FinishNotice => {
    const lines = String(info.totalLines ?? 0);

    if (info.transcriptOnly === true) {
        if (info.audioRequested !== true) {
            // Audio was deliberately off: subtitles ARE the deliverable.
            return { text: `Savi: episode saved (subtitles only) — ${lines} lines` };
        }
        const why = info.audioLost ?? 'nothing was recorded';
        return {
            text: `Savi: NO AUDIO recorded — kept ${lines} subtitle lines, but this episode is not in your library`,
            consoleError: `savi: capture finished with no audio though recording was on — ${why}`,
        };
    }

    const minutes = ((info.keptDurationMs ?? 0) / 60000).toFixed(1);
    const text = `Savi: episode saved — ${lines} lines, ${minutes} min of dialogue`;
    return typeof info.condenseWarning === 'string'
        ? {
              text: `${text}, but ${info.condenseWarning}`,
              consoleError: `savi: SUSPICIOUS CAPTURE — ${info.condenseWarning}`,
          }
        : { text };
};
