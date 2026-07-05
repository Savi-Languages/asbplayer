// Serializes asbplayer's in-memory subtitle models to SRT text for the
// savi daemon (POST /v2/capture/subtitles, format: "srt").
//
// SRT was chosen over VTT because the timestamp format is the only
// structure required and asbplayer's SubtitleModel already carries plain
// text — no styling worth preserving.

export interface SerializableSubtitle {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly track: number;
}

const formatSrtTimestamp = (timestampMs: number) => {
    const ms = Math.max(0, Math.round(timestampMs));
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    const pad = (n: number, width: number) => String(n).padStart(width, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
};

// Serializes the given track (default: track 0, the primary/target-language
// track) to SRT. Subtitles are sorted by start time, and entries without
// usable text (empty or image-based) are skipped.
export const serializeToSrt = (subtitles: SerializableSubtitle[], track: number = 0): string => {
    const lines = subtitles
        .filter((s) => s.track === track && s.text.trim().length > 0)
        .sort((a, b) => a.start - b.start);

    const blocks: string[] = [];

    for (let i = 0; i < lines.length; ++i) {
        const subtitle = lines[i];
        blocks.push(
            `${i + 1}\n${formatSrtTimestamp(subtitle.start)} --> ${formatSrtTimestamp(subtitle.end)}\n${subtitle.text.trim()}`
        );
    }

    return blocks.join('\n\n') + (blocks.length > 0 ? '\n' : '');
};
