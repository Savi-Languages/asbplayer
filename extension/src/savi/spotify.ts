/** Spotify-specific evidence. A browsed page is never playback identity. */
export interface SpotifyIdentity {
    id: string;
    kind: 'track' | 'episode';
    url: string;
}
export interface SpotifyLine {
    text: string;
    timing: 'timed' | 'untimed';
    start?: number;
    end?: number;
}
export interface SpotifyPlayback {
    identity?: SpotifyIdentity;
    title: string;
    show: string;
    positionMs?: number;
    playing: boolean;
    local: boolean;
    rate: number;
    media?: SpotifyMedia;
}
export type SpotifyMedia = Pick<
    HTMLMediaElement,
    | 'currentTime'
    | 'duration'
    | 'paused'
    | 'ended'
    | 'muted'
    | 'volume'
    | 'readyState'
    | 'playbackRate'
    | 'play'
    | 'pause'
    | 'addEventListener'
    | 'removeEventListener'
> & {
    replay?(time: number): Promise<void>;
};
export function spotifyIdentity(value: string): SpotifyIdentity | undefined {
    let match = value.match(/^spotify:(track|episode):([A-Za-z0-9]{22})$/);
    if (!match) {
        try {
            const u = new URL(value, 'https://open.spotify.com');
            if (u.protocol !== 'https:' || u.hostname !== 'open.spotify.com') return;
            match = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|episode)\/([A-Za-z0-9]{22})\/?$/);
        } catch {
            return;
        }
    }
    if (!match) return;
    const kind = match[1] as 'track' | 'episode';
    return { id: `spotify:${kind}:${match[2]}`, kind, url: `https://open.spotify.com/${kind}/${match[2]}` };
}
function time(s: string): number | undefined {
    const p = s.trim().replace(',', '.').split(':').map(Number);
    if (p.length < 2 || p.length > 3 || p.some((n) => !Number.isFinite(n) || n < 0) || p.slice(1).some((n) => n >= 60))
        return;
    return Math.round(p.reduce((a, b) => a * 60 + b, 0) * 1000);
}
const clean = (s: string) =>
    s
        .replace(/<[^>]*>/g, '')
        .trim()
        .slice(0, 4000);
/** Only file-supplied timestamps become cues; no guessed tail duration. */
export function parseSpotifyText(input: string): SpotifyLine[] {
    const text = input.replace(/\r/g, '').slice(0, 500000);
    if (text.includes('-->')) {
        const lines: SpotifyLine[] = [];
        for (const block of text.split(/\n\s*\n/)) {
            const rows = block.split('\n');
            const i = rows.findIndex((r) => r.includes('-->'));
            if (i < 0) continue;
            const m = rows[i].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
            if (!m) continue;
            const start = time(m[1]),
                end = time(m[2]),
                value = clean(rows.slice(i + 1).join('\n'));
            if (start !== undefined && end !== undefined && end > start && end - start <= 120000 && value)
                lines.push({ text: value, start, end, timing: 'timed' });
        }
        return lines.slice(0, 5000);
    }
    const lrc: Array<{ text: string; start: number }> = [];
    for (const row of text.split('\n')) {
        const stamps = [...row.matchAll(/\[(\d+:\d{2}(?:\.\d+)?)\]/g)];
        const value = clean(row.replace(/\[[^\]]*\]/g, ''));
        for (const m of stamps) {
            const start = time(m[1]);
            if (start !== undefined && value) lrc.push({ text: value, start });
        }
    }
    if (lrc.length) {
        lrc.sort((a, b) => a.start - b.start);
        return lrc.slice(0, 5000).map((l, i) => {
            const end = lrc.slice(i + 1).find((n) => n.start > l.start)?.start;
            return end !== undefined && end - l.start <= 120000
                ? { ...l, end, timing: 'timed' }
                : { text: l.text, timing: 'untimed' };
        });
    }
    return text
        .split(/\n+/)
        .map(clean)
        .filter(Boolean)
        .slice(0, 5000)
        .map((text) => ({ text, timing: 'untimed' }));
}
export interface PlaybackPoint {
    id: string;
    positionMs: number;
    at: number;
    playing: boolean;
    local: boolean;
    rate: number;
}
/** Credit elapsed ear time, not media duration (2x playback does not double time). */
export function playbackDelta(a: PlaybackPoint | undefined, b: PlaybackPoint): number {
    if (!a || a.id !== b.id || !a.playing || !b.playing || !a.local || !b.local || a.rate !== b.rate) return 0;
    const wall = b.at - a.at,
        delta = b.positionMs - a.positionMs;
    if (
        wall <= 0 ||
        wall > 2500 ||
        delta <= 0 ||
        !Number.isFinite(delta) ||
        b.rate <= 0 ||
        Math.abs(delta - wall * b.rate) > 650
    )
        return 0;
    return Math.min(wall, delta / b.rate);
}
export function readSpotifyPlayback(doc: Document, detached: readonly SpotifyMedia[] = []): SpotifyPlayback {
    const bar = doc.querySelector('[data-testid="now-playing-bar"]') ?? doc.querySelector('footer');
    const link = bar?.querySelector<HTMLAnchorElement>(
        '[data-testid="context-item-link"], [data-testid="now-playing-widget"] a[href*="/track/"], [data-testid="now-playing-widget"] a[href*="/episode/"]'
    );
    const identity = link ? spotifyIdentity(link.getAttribute('href') ?? '') : undefined;
    const control = bar?.querySelector<HTMLButtonElement>('[data-testid="control-button-playpause"]');
    const candidates = [...Array.from(doc.querySelectorAll<HTMLMediaElement>('audio,video')), ...detached].filter(
        (m) => Number.isFinite(m.duration) && m.duration > 0 && m.readyState >= 3
    );
    const active = candidates.filter((m) => !m.paused && !m.ended);
    // Multiple advancing clocks (crossfade, previews, advertisements) are ambiguous.
    const candidate =
        active.length === 1 ? active[0] : active.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
    const position = time(bar?.querySelector('[data-testid="playback-position"]')?.textContent ?? '');
    // A local media clock is required for audio capture. UI-only playback can be
    // displayed, but remote Spotify Connect playback must never accrue local audio.
    const duration = time(bar?.querySelector('[data-testid="playback-duration"]')?.textContent ?? '');
    const media =
        candidate &&
        position !== undefined &&
        Math.abs(candidate.currentTime * 1000 - position) < 2000 &&
        duration !== undefined &&
        Math.abs(candidate.duration * 1000 - duration) < 2000
            ? candidate
            : undefined;
    const local = Boolean(media && identity && !media.muted && media.volume > 0);
    const playing = Boolean(
        identity &&
            control &&
            !control.disabled &&
            ((media && !media.paused && !media.ended && media.readyState >= 2) ||
                (!media && control.getAttribute('aria-label') === 'Pause'))
    );
    return {
        identity,
        title: link?.textContent?.trim() ?? '',
        show: bar?.querySelector('[data-testid="context-item-info-subtitles"]')?.textContent?.trim() ?? '',
        positionMs: media && Number.isFinite(media.currentTime) ? Math.round(media.currentTime * 1000) : position,
        playing,
        local,
        rate: media?.playbackRate ?? 1,
        media,
    };
}
/** Read only text that Spotify actually renders. Highlight is not a timestamp. */
export function readSpotifyLines(doc: Document): SpotifyLine[] {
    const nodes = doc.querySelectorAll(
        '[data-testid="lyrics-line"], [data-testid="transcript-segment"], [data-testid="transcript-line"], #transcript-panel[role="tabpanel"] [data-encore-id="text"][dir="auto"]'
    );
    return Array.from(nodes)
        .slice(0, 5000)
        .map((n) => ({ text: clean(n.textContent ?? ''), timing: 'untimed' as const }))
        .filter((l) => l.text);
}
/** Decode only supported provider payload fields, never arbitrary page objects. */
export function spotifyPayloadLines(payload: unknown): SpotifyLine[] {
    const p = payload as any;
    const lyrics = p?.lyrics;
    const sections = p?.section ?? p?.sections ?? p?.transcript?.sections ?? p?.timedText?.cues;
    const rawRows = Array.isArray(lyrics?.lines)
        ? lyrics.lines
        : Array.isArray(sections)
          ? sections.flatMap((s: any) => (Array.isArray(s?.lines) ? s.lines : [s]))
          : [];
    const rows = rawRows
        .filter((r: any) => r && typeof r === 'object')
        .map((r: any) => ({
            ...r,
            startMs: r.text?.sentence?.startMs ?? r.startMs,
            endMs: r.text?.sentence?.endMs ?? r.endMs,
        }));
    return rows
        .slice(0, 5000)
        .map((row: any, i: number) => {
            const text = clean(
                typeof row.words === 'string'
                    ? row.words
                    : typeof row.text === 'string'
                      ? row.text
                      : typeof row.text?.sentence?.text === 'string'
                        ? row.text.sentence.text
                        : ''
            );
            const number = (v: unknown) =>
                v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
            const start = number(row.startTimeMs ?? row.startMs),
                explicit = number(row.endTimeMs ?? row.endMs);
            const next = number(rows[i + 1]?.startTimeMs ?? rows[i + 1]?.startMs);
            const end = explicit !== undefined && start !== undefined && explicit > start ? explicit : next;
            const timed = lyrics ? lyrics.syncType === 'LINE_SYNCED' : true;
            return timed &&
                start !== undefined &&
                end !== undefined &&
                start >= 0 &&
                end > start &&
                end - start <= 120000
                ? { text, timing: 'timed', start: Math.round(start), end: Math.round(end) }
                : { text, timing: 'untimed' };
        })
        .filter((l: SpotifyLine) => l.text);
}
