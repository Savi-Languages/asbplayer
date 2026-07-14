// Message protocol for savi capture, kept entirely separate from
// asbplayer's senders so upstream message handling is untouched.
//
// Senders:
//   'savi-video'                content script → background (start/stop)
//   'savi-popup'                popup → background (state/start/stop)
//   'savi-video-to-offscreen'   content script → offscreen document
//                               (segment cuts; skips the service worker so
//                               cuts keep flowing even if it is asleep)
//   'savi-extension-to-offscreen' background → offscreen document
//   'savi-offscreen'            offscreen document → background
//   'savi-extension-to-video'   background → content script

import { SegmentMeta } from './segmenter';
import { CaptureFinishInfo, SaviDictEntry, SaviKanjiFull, SaviKanjiInfo, SaviToken } from './daemon-client';

export interface SaviRequester {
    readonly tabId: number;
    readonly src: string;
}

// ── content script → background ─────────────────────────────────────────

// Note: no segment metadata travels with start. The first segment is cut
// by the content script only AFTER the recorder is confirmed live, so its
// media-time stamp can't go stale during the start round trip (daemon
// calls + getUserMedia can take a second or more while the video plays).
export interface SaviStartCaptureMessage {
    readonly command: 'savi-start-capture';
    readonly episodeId: string;
    // Series name (e.g. "Dark"); absent for films / unrecognized pages.
    readonly show?: string;
    // Episode label (e.g. "S1:E3 Secrets") or, when no show is known, the
    // best available page title. Always present.
    readonly title: string;
    readonly lang?: string;
    readonly subtitles: string;
    readonly subtitleFormat: 'srt' | 'vtt';
    readonly src: string;
    // True only when the user explicitly started this capture. On the
    // auto-start that fires every time subtitles load (i.e. every reload), this
    // is false, so the background suppresses the "enable audio recording"
    // permission prompt instead of nagging on each reload.
    readonly manuallyRequested: boolean;
}

export interface SaviStopCaptureMessage {
    readonly command: 'savi-stop-capture';
    // True only on a DELIBERATE user stop (manual toggle / popup). The background
    // clears the tab's recording-intent marker only then — so a reload, SPA
    // next-episode, or video-end (which also stop capture) KEEP intent, letting
    // the recording guard prompt to resume.
    readonly clearIntent: boolean;
}

export interface SaviStartCaptureResponse {
    readonly started: boolean;
    readonly captureId?: string;
    readonly errorCode?: 'not-configured' | 'already-capturing' | 'daemon-unreachable' | 'no-active-tab' | 'other';
    readonly errorMessage?: string;
}

// Acknowledges that finishing STARTED. The finish result itself (daemon
// stitch + condense can take minutes for a full episode) is delivered via
// SaviCaptureEndedMessage so it never depends on a service-worker-bound
// response channel staying alive.
export interface SaviStopCaptureResponse {
    readonly stopped: boolean;
    readonly errorMessage?: string;
}

// Ask whether THIS tab had a recording before the current page load (intent
// persisted in storage.session across the reload). The recording guard uses it
// to tell a reload-drop (intent set → prompt to resume) from a never-started
// episode (intent unset → a calmer, gated nudge).
export interface SaviGetIntentMessage {
    readonly command: 'savi-get-intent';
}

export interface SaviGetIntentResponse {
    readonly intentSet: boolean;
}

// ── popup → background ──────────────────────────────────────────────────

export interface SaviCaptureStateMessage {
    readonly command: 'savi-capture-state';
}

export interface SaviRequestStartMessage {
    readonly command: 'savi-request-start';
    readonly tabId: number;
}

export interface SaviCaptureState {
    readonly active: boolean;
    readonly episodeId?: string;
    readonly title?: string;
    readonly tabId?: number;
}

// ── content script → background (hover dictionary) ──────────────────────
// Daemon access goes through the background because MV3 blocks cross-origin
// fetches from content scripts (the daemon serves no CORS headers).

export interface SaviTokenizeMessage {
    readonly command: 'savi-tokenize';
    readonly lang: string;
    readonly text: string;
}

// AI context-aware segmentation of one line (resolves でも-conjunction vs で+も,
// は-topic vs 葉, …). A superset of tokenize: tokens still concatenate back to the
// line; AI chunks carry gloss/grammar. ai:false = rule-based fallback.
export interface SaviSegmentLineMessage {
    readonly command: 'savi-segment-line';
    readonly lang: string;
    readonly text: string;
    readonly prevLines?: string[];
    readonly nextLines?: string[];
    readonly episodeId?: string;
}

export interface SaviSegmentLineResponse {
    readonly ai: boolean;
    readonly tokens: SaviToken[];
}

// Professor-style in-context explanation of ONE word — the tap panel's "in this
// sentence" teaching note. null = no provider / every provider failed.
export interface SaviExplainWordMessage {
    readonly command: 'savi-explain-word';
    readonly lang: string;
    readonly term: string;
    readonly reading?: string;
    readonly text: string;
    readonly prevLines?: string[];
    readonly nextLines?: string[];
    readonly episodeId?: string;
}

export interface SaviExplainWordResponse {
    readonly explanation: string | null;
}

// Full per-kanji breakdown (readings, RTK keyword/components/stories, examples)
// for the tap panel's rich kanji section.
export interface SaviKanjiMessage {
    readonly command: 'savi-kanji';
    readonly lang: string;
    readonly term: string;
}

export interface SaviKanjiResponse {
    readonly kanji: SaviKanjiFull[];
}

export interface SaviTokenizeResponse {
    readonly tokens: SaviToken[];
}

export interface SaviDictMessage {
    readonly command: 'savi-dict';
    readonly lang: string;
    readonly term: string;
}

export interface SaviDictResponse {
    readonly entries: SaviDictEntry[];
    readonly kanji: SaviKanjiInfo[];
}

// Mine the hovered line+word into an Anki card. The daemon owns the episode
// audio + per-line timings, so it clips the line and writes the note; the
// content script only supplies what it can see (the line + the token).
export interface SaviMineLineMessage {
    readonly command: 'savi-mine-line';
    readonly episodeId: string;
    readonly lineText: string;
    // The inflected surface under the cursor (bolded in the card sentence).
    readonly surface?: string;
    // The headword to define (lemma when the analyzer supplied one, else surface).
    readonly term: string;
    readonly reading?: string;
    readonly deck?: string;
    // JPEG of the current video frame (base64, no data: prefix) for the card.
    readonly imageBase64?: string;
}

export interface SaviMineLineResponse {
    readonly ok: boolean;
    readonly noteId?: number;
    readonly hadAudio?: boolean;
    readonly hadImage?: boolean;
    readonly enriched?: boolean;
    readonly errorMessage?: string;
}

// Upload the episode's FULL subtitle track (every cue — the player loads the
// whole file up front, not as you watch). The daemon summarizes it once into a
// whole-episode gist that grounds the card's scene-level context, so this works
// even when the user only hover-mines and never records. Sent once per episode.
export interface SaviEpisodeTranscriptMessage {
    readonly command: 'savi-episode-transcript';
    readonly episodeId: string;
    readonly subtitles: string;
    readonly subtitleFormat: 'srt' | 'vtt';
}

export interface SaviEpisodeTranscriptResponse {
    readonly ok: boolean;
}

// Search OpenSubtitles.com for a subtitle in the target language and return its
// text (SV-8 fallback, used only when the streaming player has no target-language
// track). Runs in the background because MV3 blocks cross-origin fetches from
// content scripts; the API key is read from the roaming account settings
// (extension/src/savi/cloud-settings.ts), never carried in the message.
export interface SaviOpenSubtitlesFetchMessage {
    readonly command: 'savi-opensubtitles-fetch';
    readonly query: string;
    /** Comma-separated ISO 639-1 codes, e.g. `es`. */
    readonly languages: string;
    readonly seasonNumber?: number;
    readonly episodeNumber?: number;
}

export interface SaviOpenSubtitlesFetchResponse {
    // ok:false covers "no key configured", "no result", and errors alike — the
    // fallback is best-effort, so the caller just moves on.
    readonly ok: boolean;
    readonly name?: string;
    readonly content?: string;
    readonly errorMessage?: string;
}

// Fetch the freshest account-roaming settings (target language + OpenSubtitles
// key) from the cloud, refreshing the local cache. The content script asks the
// background because only it can reach the cloud (CORS / host permission). Used
// at auto-load time so a target language changed on another device (e.g. the
// desktop app) takes effect on the next video without reopening the extension.
// Falls back to the cache when the cloud is unreachable / signed out.
export interface SaviRoamingSettingsMessage {
    readonly command: 'savi-roaming-settings';
}

export interface SaviRoamingSettingsResponse {
    readonly targetLanguage: string;
    readonly openSubtitlesApiKey: string;
}

// ── Glossing (SV-12 / SV-13) ────────────────────────────────────────────
// Translate ONE target-language word into the user's known language for the
// on-subtitle gloss label. The full line rides as `context` so the cloud's
// DeepL call is sentence-aware (banco → "bank" vs "bench"). Runs in the
// background because MV3 blocks cross-origin fetches (to the cloud) from
// content scripts; the account JWT is added there, never in the message.
export interface SaviGlossTranslateMessage {
    readonly command: 'savi-gloss-translate';
    readonly word: string;
    /** BCP-47 target (learning) language, e.g. `es` — the source for translation. */
    readonly targetLang: string;
    /** Language to gloss INTO (the user's known language), e.g. `en`. */
    readonly glossLang: string;
    /** The whole subtitle line (± neighbours) — influences the translation, not translated itself. */
    readonly context?: string;
}

export interface SaviGlossTranslateResponse {
    /** The gloss, or undefined when signed out / every provider failed. */
    readonly text?: string;
    /** "deepl" or "llm:<provider>", for diagnostics. */
    readonly provider?: string;
}

// Known-inclusive per-lemma buckets for the target language (SV-13). The content
// script uses it to gloss a word iff its lemma is not yet `known`. Empty map =
// signed out / unreachable → the caller falls back to glossing all content words.
export interface SaviWordBucketsMessage {
    readonly command: 'savi-word-buckets';
    readonly lang: string;
}

export interface SaviWordBucketsResponse {
    readonly buckets: Record<string, 'new' | 'word_box' | 'known'>;
}

// Capture a JPEG of the current video frame for a mined card. A content script
// can't call tabs.captureVisibleTab (background-only), so it asks the
// background for the full-tab data URL, then crops it locally to the video.
export interface SaviCaptureFrameMessage {
    readonly command: 'savi-capture-frame';
}

export interface SaviCaptureFrameResponse {
    readonly dataUrl?: string;
}

// ── content script → offscreen document ─────────────────────────────────

export type SaviSegmentOp =
    | { readonly op: 'segment-start'; readonly segment: SegmentMeta }
    | { readonly op: 'segment-end' };

export interface SaviSegmentMessage {
    readonly command: 'savi-segment';
    readonly ops: SaviSegmentOp[];
}

// ── background → offscreen document ─────────────────────────────────────

export interface SaviOffscreenStartMessage {
    readonly command: 'savi-offscreen-start';
    readonly streamId: string;
    readonly captureId: string;
    readonly episodeId: string;
    readonly show?: string;
    readonly title: string;
    readonly baseUrl: string;
    /** The legacy LAN token, as a FALLBACK only (may be ''). The offscreen
     *  document resolves the signed-in account's token per chunk — a capture
     *  outlives the ~1h JWT, so a token snapshotted at start would go stale
     *  mid-episode. */
    readonly lanToken: string;
    readonly requester: SaviRequester;
}

export interface SaviOffscreenStopMessage {
    readonly command: 'savi-offscreen-stop';
}

export interface SaviOffscreenStateMessage {
    readonly command: 'savi-offscreen-state';
}

// ── offscreen document → background ─────────────────────────────────────

// Sent whenever a capture finishes — explicit stop, video ended, or the
// captured tab going away — carrying the daemon's episode summary (or the
// failure). Forwarded to the capture's tab as a toast.
export interface SaviCaptureEndedMessage {
    readonly command: 'savi-capture-ended';
    readonly requester: SaviRequester;
    readonly ok: boolean;
    readonly info?: CaptureFinishInfo;
    readonly failedSegments?: number;
    readonly errorMessage?: string;
}

// ── background → content script ─────────────────────────────────────────

export interface SaviCaptureEndedToVideoMessage {
    readonly command: 'savi-capture-ended';
    readonly src: string;
    readonly ok: boolean;
    readonly info?: CaptureFinishInfo;
    readonly failedSegments?: number;
    readonly errorMessage?: string;
}

export interface SaviRequestStartToVideoMessage {
    readonly command: 'savi-request-start';
}

export interface SaviCommand<M> {
    readonly sender:
        | 'savi-video'
        | 'savi-popup'
        | 'savi-video-to-offscreen'
        | 'savi-extension-to-offscreen'
        | 'savi-offscreen'
        | 'savi-extension-to-video';
    readonly message: M;
}
