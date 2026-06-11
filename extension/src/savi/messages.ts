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
import { CaptureFinishInfo } from './daemon-client';

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
    readonly title: string;
    readonly lang?: string;
    readonly subtitles: string;
    readonly subtitleFormat: 'srt' | 'vtt';
    readonly src: string;
}

export interface SaviStopCaptureMessage {
    readonly command: 'savi-stop-capture';
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
    readonly title: string;
    readonly baseUrl: string;
    readonly token: string;
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
