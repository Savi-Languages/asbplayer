// Content-script side of savi capture.
//
// Owns the segment-cutting state machine and feeds it the video
// element's events (this is the only context that can sample
// video.currentTime / playbackRate at the moment an event fires).
// SV-18: audio is recorded by the DAEMON's own system tap, so segment
// boundaries travel content → background → daemon as playback-state ops;
// no tab capture, no user-gesture requirement, and auto-start actually
// records — fullscreen included.
//
// Bound by asbplayer's Binding with four one-line hooks: construct,
// subtitles-loaded, subtitles-reset, unbind. Everything else (video
// event listeners, runtime message listener) is attached and detached
// here so the upstream diff stays minimal.

import { SettingsProvider } from '@project/common/settings';
import { daemonCredentials } from './account';
import { SegmentMeta, Segmenter, SegmenterOutput } from './segmenter';
import { serializeToSrt, SerializableSubtitle } from './subtitle-serializer';
import { deriveEpisodeId, deriveShowAndTitle, deriveShowAndTitleFromBasename } from './episode';
import { NativeSubtitleHider, nativeSubtitleSelectorForHost } from './native-subtitle-hider';
import { SaviRecordButton } from './record-button';
import { SaviReplayButton } from './replay-button';
import { SaviSpeedControl } from './speed-control';
import { SaviRecordingGuard } from './recording-guard';
import {
    SaviCommand,
    SaviPlaybackStateMessage,
    SaviPlaybackStateResponse,
    SaviSegmentOp,
    SaviStartCaptureMessage,
    SaviStartCaptureResponse,
    SaviStopCaptureMessage,
    SaviStopCaptureResponse,
} from './messages';

export interface SaviCaptureHost {
    readonly video: HTMLMediaElement;
    readonly settings: SettingsProvider;
    currentSubtitles: () => SerializableSubtitle[];
    videoSrc: () => string;
    // asbplayer's own detected name for the loaded subtitle track, e.g.
    // "<Show> S<NN>E<NN> <Episode Title>" (films: just "<Show>"). Derived from
    // the streaming site's video metadata API, so it's the most reliable
    // source of show/title — preferred over DOM/document.title scraping.
    subtitleFileName: () => string;
    notify: (locKey: string, replacements?: { [key: string]: string }) => void;
}

/** Delivery attempts for a segment boundary op. MV3 rejects `sendMessage`
 *  while the service worker is tearing down, and a pause op is likely to be
 *  sent at exactly that moment. */
const segmentOpSendAttempts = 3;
const segmentOpRetryDelayMs = 150;
/** How often the open segment is re-asserted to the daemon. Bounds how much
 *  audio a dropped op can cost; small enough to be a few seconds, large enough
 *  that it is not chatter. */
const segmentReassertIntervalMs = 5_000;
/** Media time a single segment may span before it is re-anchored (`recut`).
 *
 *  Two jobs. It bounds what any UNDETECTED divergence between us and the
 *  recorder can cost — worst case one cap, instead of the rest of the episode.
 *  And it re-anchors the audio→media mapping periodically rather than
 *  extrapolating `media_start + audio_ms * rate` across a 40-minute segment.
 *
 *  Five minutes: ~9 segments on a typical episode, which is nothing for the
 *  stitcher, and small enough that a lost stretch is an annoyance rather than
 *  a hole. */
const segmentCapMs = 5 * 60_000;

/**
 * Deliver a message, retrying transient failures.
 *
 * Exported for its own test: the controller needs a live video element and a
 * settings provider to construct, and this behaviour is worth pinning without
 * either.
 */
export const sendWithRetry = async (
    send: () => Promise<unknown>,
    attempts = segmentOpSendAttempts,
    delayMs = segmentOpRetryDelayMs,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            await send();
            return true;
        } catch {
            if (attempt + 1 < attempts) {
                await sleep(delayMs * (attempt + 1));
            }
        }
    }
    return false;
};

export class SaviCaptureController {
    private readonly _host: SaviCaptureHost;
    private readonly _nativeSubtitleHider = new NativeSubtitleHider();
    private readonly _recordButton = new SaviRecordButton(
        () => this._toggleCapture(),
        () => this._host.video
    );
    private readonly _replayButton = new SaviReplayButton(() => this._replayCurrentLine());
    private readonly _speedControl = new SaviSpeedControl(() => this._host.video);
    // "You're not recording" guard: loud button + banner + chime + re-nag, raised
    // when a video plays but capture is off (a reload dropped it, or never started).
    private readonly _guard = new SaviRecordingGuard(this._recordButton);
    private _segmenter?: Segmenter;
    private _active = false;
    private _starting = false;
    private _notifiedUnsupportedRate?: number;
    // episodeIds for which the calmer "never started" guard already showed this
    // session — so casual watching isn't nagged more than once per episode.
    private readonly _guardShownEpisodes = new Set<string>();
    // episodeIds the user DELIBERATELY stopped this page session — auto-start
    // must not re-arm them. (Replaces the old per-tab recording-intent marker,
    // whose reason to exist — the tabCapture gesture lost on reload — is gone.)
    private readonly _deliberatelyStopped = new Set<string>();

    private _videoListeners: [string, EventListener][] = [];
    private _messageListener?: (
        request: any,
        sender: Browser.runtime.MessageSender,
        sendResponse: (response?: any) => void
    ) => void;
    // The show's stable platform id ("netflix:80209013"), announced by the
    // page script when metadata loads. Display titles are localized and can
    // change with the profile language; this can't — the library groups by it,
    // falling back to the show NAME on sites without one.
    private _showId?: string;
    private _showIdListener?: EventListener;
    private _lastReassertMs = 0;

    constructor(host: SaviCaptureHost) {
        this._host = host;
    }

    get active() {
        return this._active;
    }

    bind() {
        if (this._messageListener !== undefined) {
            return;
        }

        this._showIdListener = (event) => {
            const showId = (event as CustomEvent).detail?.showId;
            if (typeof showId === 'string' && showId.length > 0) {
                this._showId = showId;
            }
        };
        document.addEventListener('savi-netflix-show-id', this._showIdListener);

        this._messageListener = (request, sender, sendResponse) => {
            if (request?.sender !== 'savi-extension-to-video') {
                return;
            }

            if (request.message.command === 'savi-request-start') {
                // The record shortcut / toolbar / popup TOGGLES: pressing it again
                // STOPS. Only the binding with loaded subtitles responds.
                if (this._active) {
                    this.stop(true); // deliberate stop → clears intent (no resume nag)
                    sendResponse({ requested: true });
                    return true;
                }
                if (!this._starting && this._subtitlesForCapture().length > 0) {
                    this.start(true);
                    sendResponse({ requested: true });
                    return true;
                }
            } else if (request.message.command === 'savi-notify') {
                // Sent to the top frame only, when a start request reached no
                // frame that could act on it (see savi/request-start.ts).
                this._host.notify(request.message.text);
            } else if (request.message.command === 'savi-capture-ended') {
                // Arrives for explicit stops too (the finish result travels
                // out-of-band; see SaviStopCaptureResponse), so don't gate
                // on _active.
                if (request.message.src === this._host.videoSrc()) {
                    if (this._active) {
                        this._deactivate();
                    }

                    if (request.message.expired) {
                        // The daemon auto-finished the session while we were
                        // idle (or restarted). The user is clearly watching
                        // again — restart the capture; the new take merges
                        // with what was already finished. A deliberate stop
                        // stays stopped.
                        const { episodeId } = this._pageMetadata();
                        if (episodeId !== undefined && !this._starting && !this._deliberatelyStopped.has(episodeId)) {
                            this._host.notify('Savi: capture restarted after idle timeout');
                            this.start(false);
                        }
                        return;
                    }

                    this._notifyFinished(request.message);
                }
            }
        };
        browser.runtime.onMessage.addListener(this._messageListener);
    }

    unbind() {
        if (this._showIdListener !== undefined) {
            document.removeEventListener('savi-netflix-show-id', this._showIdListener);
            this._showIdListener = undefined;
        }
        this._nativeSubtitleHider.clear();
        this._recordButton.destroy();
        this._replayButton.destroy();
        this._speedControl.destroy();
        this._guard.destroy();

        if (this._messageListener !== undefined) {
            browser.runtime.onMessage.removeListener(this._messageListener);
            this._messageListener = undefined;
        }

        if (this._active) {
            // Best effort: the video element is going away; finish so the
            // episode-so-far reaches the daemon.
            this.stop();
        }
    }

    // Called when subtitle tracks have been loaded for the video.
    onSubtitlesLoaded() {
        // The Replay control is a playback aid, independent of capture — surface
        // it whenever there are subtitles to replay.
        this._replayButton.show();
        this._host.settings
            .get(['saviCaptureEnabled', 'saviHideNativeSubtitles', 'saviDaemonUrl'])
            .then(({ saviCaptureEnabled, saviHideNativeSubtitles }) => {
                // Speed selection now lives in asbplayer's own top control bar
                // (MobileVideoOverlay), so the separate floating control stays
                // hidden — kept around only as a fallback.

                // Hiding the site's own subtitles is independent of capture:
                // run it first and regardless of whether auto-capture is on.
                if (saviHideNativeSubtitles) {
                    const host = this._hostname();
                    const selector = nativeSubtitleSelectorForHost(host);

                    if (selector !== undefined) {
                        this._nativeSubtitleHider.apply(selector);
                    }
                }

                if (saviCaptureEnabled) {
                    // Surface the Record control whenever capture is on offer,
                    // and auto-start for the no-friction case — unless the user
                    // deliberately stopped this episode earlier in the session.
                    this._recordButton.show();
                    // The speed selector rides with the Record control: both are
                    // capture affordances, and SAVI.md documents them together.
                    // (It was constructed and hidden but never shown, so the
                    // documented 0.5x-1.5x picker could not appear at all.)
                    this._speedControl.show();
                    const { episodeId } = this._pageMetadata();
                    // No stable id yet (Netflix mid-navigation) — the next
                    // heartbeat will have one. Starting now would mint a
                    // throwaway id and split the episode's takes in two.
                    if (
                        episodeId !== undefined &&
                        !this._active &&
                        !this._starting &&
                        !this._deliberatelyStopped.has(episodeId)
                    ) {
                        this.start(false);
                    }
                } else {
                    this._recordButton.hide();
                    this._speedControl.hide();
                }
            });
    }

    private _hostname(): string {
        try {
            return new URL(this._safeLocationHref()).host;
        } catch (e) {
            return '';
        }
    }

    /** Replay the current subtitle line: seek to its start and play (asbplayer's
     *  S key, as a clickable control). The current line is the cue whose window
     *  holds the playhead — or, when auto-pause has stopped just past a line, the
     *  most recent cue that has started. */
    private _replayCurrentLine() {
        const video = this._host.video;
        const t = video.currentTime * 1000;
        const all = this._host.currentSubtitles();
        const onTrack0 = all.filter((s) => s.track === 0);
        const subs = onTrack0.length > 0 ? onTrack0 : all;
        const current =
            [...subs].reverse().find((s) => s.start <= t && t < s.end) ?? [...subs].reverse().find((s) => s.start <= t);
        if (!current) {
            return;
        }
        video.currentTime = current.start / 1000;
        void video.play();
    }

    // Called when subtitles are reset (e.g. SPA navigation to the next
    // episode). Finishes the in-flight capture; a new one auto-starts
    // when the next episode's subtitles load.
    onSubtitlesReset() {
        this._nativeSubtitleHider.clear();
        this._recordButton.hide();
        this._replayButton.hide();
        this._speedControl.hide();
        // A next-episode reset is not a deliberate stop — keep intent so the new
        // episode can prompt — but drop the visible guard; it re-evaluates on the
        // next episode's auto-start.
        this._guard.clear();

        if (this._active) {
            this.stop();
        }
    }

    private _toggleCapture() {
        if (this._active) {
            this.stop(true); // a manual toggle-off is deliberate → clears intent
        } else {
            this.start(true);
        }
    }

    async start(manuallyRequested: boolean) {
        if (this._active || this._starting) {
            return;
        }

        this._starting = true;

        try {
            const { saviDaemonUrl, saviDaemonToken, streamingLastLanguagesSynced, saviRecordingGuard } =
                await this._host.settings.get([
                    'saviDaemonUrl',
                    'saviDaemonToken',
                    'streamingLastLanguagesSynced',
                    'saviRecordingGuard',
                ]);

            // The LAN token opens the daemon; the account JWT covers a setup
            // that never configured one (the JWT doubles as the bearer then).
            if (!saviDaemonUrl.trim() || !(await daemonCredentials(saviDaemonToken)).bearer) {
                this._host.notify('Savi: sign in (or set a daemon token) in the extension settings');
                return;
            }

            const subtitles = this._subtitlesForCapture();

            if (subtitles.length === 0) {
                if (manuallyRequested) {
                    this._host.notify('Savi: no subtitle track loaded to capture');
                }
                return;
            }

            const video = this._host.video;
            const { episodeId, show, title } = this._pageMetadata();
            if (episodeId === undefined) {
                // The page has no stable platform id yet. Refusing is the
                // whole fix: the daemon keys its episode store on this id, so
                // capturing under a made-up one produces a SECOND store for an
                // episode that already has one — a duplicate library row with
                // its own line count, and takes that never stitch together.
                this._host.notify('Savi: waiting for the episode to load');
                return;
            }
            const lang = (streamingLastLanguagesSynced[window.location.host] ?? []).find((l) => l && l !== '-');

            const command: SaviCommand<SaviStartCaptureMessage> = {
                sender: 'savi-video',
                message: {
                    command: 'savi-start-capture',
                    episodeId,
                    show,
                    showId: this._showId,
                    title,
                    lang,
                    subtitles: serializeToSrt(subtitles),
                    subtitleFormat: 'srt',
                    src: this._host.videoSrc(),
                    manuallyRequested,
                },
            };
            const response = (await browser.runtime.sendMessage(command)) as SaviStartCaptureResponse;

            if (response?.started) {
                // The session is live now — only now does segmenting begin,
                // so the first segment's media-time stamp is sampled fresh
                // rather than aging across the start round trip.
                const segmenter = new Segmenter();
                this._segmenter = segmenter;
                this._active = true;
                this._notifiedUnsupportedRate = undefined;
                this._attachVideoListeners();
                this._sendSegmentOps(
                    this._opsFromOutputs(segmenter.begin(video.currentTime * 1000, video.playbackRate, video.paused))
                );
                this._guard.clear(); // capturing now — drop any "not recording" guard

                // SV-18: the daemon reports whether ITS tap is recording audio.
                const audioState = response.audio?.state ?? 'legacy';
                if (audioState === 'recording' || audioState === 'legacy') {
                    this._host.notify('Savi: capturing episode');
                    this._recordButton.setState('recording');
                } else {
                    // disabled / unavailable — the session still captures
                    // subtitles (transcript-only finish + word encounters).
                    this._host.notify(
                        audioState === 'disabled'
                            ? 'Savi: capturing episode (subtitles only — audio recording is off)'
                            : `Savi: capturing episode WITHOUT audio — ${response.audio?.reason ?? 'audio unavailable'}`
                    );
                    this._recordButton.setState('recording');
                    if (audioState === 'unavailable') {
                        this._recordButton.flashHint('No audio — check the savi desktop app');
                    }
                }
            } else {
                if (manuallyRequested) {
                    this._host.notify(`Savi: capture failed — ${response?.errorMessage ?? 'unknown error'}`);
                } else if (saviRecordingGuard && !this._guardShownEpisodes.has(episodeId)) {
                    // A silently-failing auto-start (daemon down, signed out):
                    // nudge once per episode instead of toasting every reload.
                    this._guardShownEpisodes.add(episodeId);
                    this._guard.activate('never-started');
                }
            }
        } catch (e) {
            console.error('savi: failed to start capture', e);
            this._host.notify(`Savi: capture failed — ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this._starting = false;
        }
    }

    // Computes the stable episode id + best-effort show/title at capture
    // start. All DOM reading lives here (content-script context); the
    // parsing/derivation is delegated to the pure helpers in episode.ts so
    // it stays unit-tested. Fully defensive — never throws.
    private _pageMetadata(): { episodeId: string | undefined; show?: string; title: string } {
        const url = this._safeLocationHref();
        const documentTitle = this._safeDocumentTitle();

        // Prefer asbplayer's own detected subtitle name — it comes from the
        // streaming site's video metadata API ("<Show> S<NN>E<NN> <Episode
        // Title>"), not a flaky DOM/document.title scrape (document.title is
        // frequently just "Netflix" at capture time). Fall back to the DOM /
        // document.title path only when the basename yields nothing usable.
        const { show, title } = this._resolveShowAndTitle(url, documentTitle);

        return {
            episodeId: deriveEpisodeId(url, documentTitle),
            show,
            // title is guaranteed non-empty by the resolvers below, but guard
            // the daemon's non-empty requirement one more time.
            title: title.trim() || 'episode',
        };
    }

    // Picks the best {show, title}: the asbplayer subtitle basename first, the
    // existing DOM/document.title derivation second. Never throws.
    private _resolveShowAndTitle(url: string, documentTitle: string): { show?: string; title: string } {
        const fromBasename = deriveShowAndTitleFromBasename(this._safeSubtitleFileName());
        if (fromBasename.title.trim().length > 0) {
            return fromBasename;
        }

        return deriveShowAndTitle(url, documentTitle, this._readNetflixOverlay());
    }

    private _safeSubtitleFileName(): string {
        try {
            return this._host.subtitleFileName();
        } catch (e) {
            return '';
        }
    }

    private _safeLocationHref(): string {
        try {
            return window.location.href;
        } catch (e) {
            return '';
        }
    }

    private _safeDocumentTitle(): string {
        try {
            return document.title.trim();
        } catch (e) {
            return '';
        }
    }

    // Best-effort read of Netflix's player title overlay (series name +
    // episode label). Netflix's markup is unstable and class-hashed, so this
    // tries a couple of known structures and silently yields undefined when
    // none match — the caller then falls back to document.title.
    private _readNetflixOverlay(): { seriesName?: string; episodeLabel?: string } | undefined {
        try {
            if (!/(^|\.)netflix\.com$/i.test(window.location.host)) {
                return undefined;
            }

            const text = (selector: string): string | undefined => {
                const el = document.querySelector(selector);
                const value = el?.textContent?.trim();
                return value && value.length > 0 ? value : undefined;
            };

            // The watch-screen title overlay: series name on top, episode
            // label below. These data-uia hooks have been the most stable
            // surface across Netflix's frequent class-name churn.
            const seriesName =
                text('[data-uia="video-title"] h4') ?? text('.video-title h4') ?? text('[data-uia="video-title"]');
            const episodeLabel = text('[data-uia="video-title"] span') ?? text('.video-title span');

            if (seriesName === undefined && episodeLabel === undefined) {
                return undefined;
            }

            return { seriesName, episodeLabel };
        } catch (e) {
            return undefined;
        }
    }

    // `deliberate` = a manual toggle-off / popup stop (the user is done with
    // this episode) — auto-start won't re-arm it this page session. Reset /
    // unbind / video-end stops pass false.
    async stop(deliberate = false) {
        if (!this._active) {
            return;
        }

        if (deliberate) {
            const { episodeId } = this._pageMetadata();
            if (episodeId !== undefined) {
                this._deliberatelyStopped.add(episodeId);
            }
        }

        const segmenter = this._segmenter;

        if (segmenter !== undefined) {
            this._sendSegmentOps(this._opsFromOutputs(segmenter.finish()));
        }

        this._deactivate();

        try {
            const command: SaviCommand<SaviStopCaptureMessage> = {
                sender: 'savi-video',
                message: { command: 'savi-stop-capture' },
            };
            const response = (await browser.runtime.sendMessage(command)) as SaviStopCaptureResponse;

            if (response?.stopped) {
                // The episode summary toast follows via 'savi-capture-ended'
                // once the daemon finishes stitching.
                this._host.notify('Savi: finishing episode…');
            } else {
                this._host.notify(`Savi: capture failed — ${response?.errorMessage ?? 'unknown error'}`);
            }
        } catch (e) {
            console.error('savi: failed to stop capture', e);
            this._host.notify(`Savi: capture failed — ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private _deactivate() {
        this._active = false;
        this._segmenter = undefined;
        this._detachVideoListeners();
        this._recordButton.setState('idle');
    }

    private _notifyFinished(result: { ok: boolean; info?: any; errorMessage?: string; failedSegments?: number }) {
        if (result.ok && result.info !== undefined) {
            const lines = String(result.info.totalLines);

            if (result.info.transcriptOnly === true) {
                this._host.notify(`Savi: episode saved (subtitles only) — ${lines} lines`);
            } else {
                const minutes = (result.info.keptDurationMs / 60000).toFixed(1);
                this._host.notify(`Savi: episode saved — ${lines} lines, ${minutes} min of dialogue`);
            }

            if (result.failedSegments !== undefined && result.failedSegments > 0) {
                console.warn(`savi: ${result.failedSegments} segment(s) failed to upload and were dropped`);
            }
        } else {
            this._host.notify(`Savi: capture failed — ${result.errorMessage ?? 'unknown error'}`);
        }
    }

    private _subtitlesForCapture(): SerializableSubtitle[] {
        return this._host.currentSubtitles().filter((s) => s.track === 0 && s.text.trim().length > 0);
    }

    private _reassertSegment() {
        const segment = this._segmenter?.currentSegment;
        if (segment === undefined) {
            return;
        }
        const now = Date.now();
        if (now - this._lastReassertMs < segmentReassertIntervalMs) {
            return;
        }
        this._lastReassertMs = now;

        // Capped: re-anchor instead of re-asserting. See `segmentCapMs`.
        const mediaTimeMs = this._host.video.currentTime * 1000;
        if (mediaTimeMs - segment.mediaTimeMs >= segmentCapMs) {
            this._recut(mediaTimeMs);
            return;
        }

        void this._keepalive(segment);
    }

    /** Re-assert the open segment, then act on what the daemon says is ACTUALLY
     *  open.
     *
     *  A mismatch means the recorder closed our segment underneath us — its
     *  liveness timeout decided we were gone, or it refused to re-open a segment
     *  it had already closed. Re-asserting the same id cannot recover from
     *  either; only a new segment at the live playhead does. Until the daemon
     *  reported this, the capture simply stopped until the next pause or seek. */
    private async _keepalive(segment: SegmentMeta) {
        const response = await this._deliverOps([{ op: 'segment-start', segment }]);

        // `undefined` = a daemon that does not report the open segment (< 0.44.4)
        // or an undelivered batch. Infer nothing: reading either as "your segment
        // is closed" would recut every keepalive and shred the capture.
        if (response?.audio !== 'recording' || response.openSegment === undefined) {
            return;
        }
        if (response.openSegment === segment.segmentId) {
            return;
        }
        // Moved on while the batch was in flight — the answer is about a segment
        // we have already replaced.
        if (this._segmenter?.currentSegment?.segmentId !== segment.segmentId) {
            return;
        }

        console.warn(
            `savi: daemon has ${response.openSegment ?? 'nothing'} open, not ${segment.segmentId} — re-anchoring`
        );
        this._recut(this._host.video.currentTime * 1000);
    }

    /** End the current segment and open a fresh one at `mediaTimeMs`.
     *
     *  Re-stamps the throttle, so a persistent mismatch costs one recut per
     *  interval rather than one per `timeupdate` — an unthrottled recut loop
     *  would chop the capture into fragments, which is how the 0.33.0 keepalive
     *  nearly made things worse instead of better. */
    private _recut(mediaTimeMs: number) {
        this._sendSegmentOps(this._opsFromOutputs(this._segmenter?.recut(mediaTimeMs) ?? []));
        this._lastReassertMs = Date.now();
    }

    private _attachVideoListeners() {
        const video = this._host.video;
        const nowMs = () => video.currentTime * 1000;
        const handle = (outputs: SegmenterOutput[]) => this._sendSegmentOps(this._opsFromOutputs(outputs));

        this._videoListeners = [
            ['play', () => handle(this._segmenter?.play(nowMs()) ?? [])],
            ['playing', () => handle(this._segmenter?.play(nowMs()) ?? [])],
            ['pause', () => handle(this._segmenter?.pause() ?? [])],
            ['waiting', () => handle(this._segmenter?.pause() ?? [])],
            ['seeked', () => handle(this._segmenter?.seeked(nowMs()) ?? [])],
            ['ratechange', () => handle(this._segmenter?.rateChange(nowMs(), video.playbackRate) ?? [])],
            ['ended', () => this.stop()],
            // KEEPALIVE. `timeupdate` fires ~4x/s while playing; throttled to
            // one re-assertion every few seconds.
            //
            // Boundary ops are the daemon's ONLY picture of what is being
            // recorded, and after a dropped 'segment-start' the segmenter has
            // no reason to emit anything again until the next pause or seek.
            // So continuous watching goes unrecorded indefinitely: one real
            // episode lost a contiguous 20 minutes, identically in two
            // separate takes, and the tap then hit its 10-minute idle watchdog
            // and stopped altogether. Retrying the send (0.32.2) narrows the
            // window; only re-asserting closes it, because it recovers from a
            // loss that already happened.
            //
            // Safe to repeat: the daemon ignores a Begin for the segment it
            // already has open, and registers segments idempotently by id.
            ['timeupdate', () => this._reassertSegment()],
        ];

        for (const [event, listener] of this._videoListeners) {
            video.addEventListener(event, listener);
        }
    }

    private _detachVideoListeners() {
        for (const [event, listener] of this._videoListeners) {
            this._host.video.removeEventListener(event, listener);
        }

        this._videoListeners = [];
    }

    private _opsFromOutputs(outputs: SegmenterOutput[]): SaviSegmentOp[] {
        const ops: SaviSegmentOp[] = [];

        for (const output of outputs) {
            if (output.type === 'segment-start') {
                ops.push({ op: 'segment-start', segment: output.segment });
            } else if (output.type === 'segment-end') {
                ops.push({ op: 'segment-end' });
            } else if (output.type === 'rate-unsupported') {
                this._notifyUnsupportedRate(output.rate);
            }
        }

        return ops;
    }

    private _notifyUnsupportedRate(rate: number) {
        if (this._notifiedUnsupportedRate !== rate) {
            this._notifiedUnsupportedRate = rate;
            this._host.notify(`Savi: playback rate ${rate.toFixed(2)} cannot be captured (supported: 0.5–2)`);
        }
    }

    private _sendSegmentOps(ops: SaviSegmentOp[]) {
        if (ops.length === 0) {
            return;
        }

        // Relayed via the background, which attaches captureId + seq and talks
        // to the daemon (content scripts can't — CORS).
        //
        // RETRIED, because these are not advisory. A dropped 'segment-end' is
        // not a lost hint that the stitcher can paper over: the daemon has no
        // other way to learn playback stopped — the playback-state route
        // carries no playing flag, and the recorder's watchdog only fires when
        // NO segment is open. So the tap keeps recording into the abandoned
        // segment, and because a take's coverage is
        // `media_start + audio_ms * rate`, that silence is claimed as covered
        // audio. One real episode ended up 48% digital silence with 229 of its
        // 469 lines promising audio that did not exist.
        //
        // MV3 suspends this service worker routinely and `sendMessage` rejects
        // while it is tearing down, which is exactly when a pause op is likely
        // to be sent. Re-applying is safe: the daemon registers segments
        // idempotently by id, and a duplicate end with nothing open is a
        // no-op.
        void this._deliverOps(ops);
    }

    /** Deliver a batch and hand back the daemon's answer (`undefined` when it
     *  could not be delivered at all). */
    private async _deliverOps(ops: SaviSegmentOp[]): Promise<SaviPlaybackStateResponse | undefined> {
        const command: SaviCommand<SaviPlaybackStateMessage> = {
            sender: 'savi-video',
            message: {
                command: 'savi-playback-state',
                ops,
            },
        };
        let response: SaviPlaybackStateResponse | undefined;
        const delivered = await sendWithRetry(async () => {
            response = (await browser.runtime.sendMessage(command)) as SaviPlaybackStateResponse;
        });
        if (!delivered) {
            // Out of attempts. Say so: the daemon still believes a segment is
            // open and keeps recording into it, so coverage will overstate.
            // A silent failure here is what made this take days to find.
            console.warn('savi: could not deliver segment ops after retries; coverage may overstate', ops);
            return undefined;
        }
        return response;
    }
}
