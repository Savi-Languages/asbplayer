// Content-script side of savi capture.
//
// Owns the segment-cutting state machine and feeds it the video
// element's events (this is the only context that can sample
// video.currentTime / playbackRate at the moment an event fires).
// Segment boundaries are forwarded straight to the offscreen document;
// capture start/stop go through the background service worker, which
// owns tabCapture stream-id minting and the daemon start/finish calls.
//
// Bound by asbplayer's Binding with four one-line hooks: construct,
// subtitles-loaded, subtitles-reset, unbind. Everything else (video
// event listeners, runtime message listener) is attached and detached
// here so the upstream diff stays minimal.

import { SettingsProvider } from '@project/common/settings';
import { Segmenter, SegmenterOutput } from './segmenter';
import { serializeToSrt, SerializableSubtitle } from './subtitle-serializer';
import { deriveEpisodeId, deriveShowAndTitle } from './episode';
import { NativeSubtitleHider, nativeSubtitleSelectorForHost } from './native-subtitle-hider';
import {
    SaviCommand,
    SaviSegmentMessage,
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
    notify: (locKey: string, replacements?: { [key: string]: string }) => void;
}

export class SaviCaptureController {
    private readonly _host: SaviCaptureHost;
    private readonly _nativeSubtitleHider = new NativeSubtitleHider();
    private _segmenter?: Segmenter;
    private _active = false;
    private _starting = false;
    private _notifiedUnsupportedRate?: number;

    private _videoListeners: [string, EventListener][] = [];
    private _messageListener?: (
        request: any,
        sender: Browser.runtime.MessageSender,
        sendResponse: (response?: any) => void
    ) => void;

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

        this._messageListener = (request, sender, sendResponse) => {
            if (request?.sender !== 'savi-extension-to-video') {
                return;
            }

            if (request.message.command === 'savi-request-start') {
                // Only the binding with loaded subtitles responds.
                if (!this._active && !this._starting && this._subtitlesForCapture().length > 0) {
                    this.start(true);
                    sendResponse({ requested: true });
                    return true;
                }
            } else if (request.message.command === 'savi-capture-ended') {
                // Arrives for explicit stops too (the finish result travels
                // out-of-band; see SaviStopCaptureResponse), so don't gate
                // on _active.
                if (request.message.src === this._host.videoSrc()) {
                    if (this._active) {
                        this._deactivate();
                    }

                    this._notifyFinished(request.message);
                }
            }
        };
        browser.runtime.onMessage.addListener(this._messageListener);
    }

    unbind() {
        this._nativeSubtitleHider.clear();

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
        this._host.settings
            .get(['saviCaptureEnabled', 'saviHideNativeSubtitles', 'saviDaemonUrl'])
            .then(({ saviCaptureEnabled, saviHideNativeSubtitles }) => {
                // Hiding the site's own subtitles is independent of capture:
                // run it first and regardless of whether auto-capture is on.
                if (saviHideNativeSubtitles) {
                    const host = this._hostname();
                    const selector = nativeSubtitleSelectorForHost(host);

                    if (selector !== undefined) {
                        this._nativeSubtitleHider.apply(selector);
                    }
                }

                if (saviCaptureEnabled && !this._active && !this._starting) {
                    this.start(false);
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

    // Called when subtitles are reset (e.g. SPA navigation to the next
    // episode). Finishes the in-flight capture; a new one auto-starts
    // when the next episode's subtitles load.
    onSubtitlesReset() {
        this._nativeSubtitleHider.clear();

        if (this._active) {
            this.stop();
        }
    }

    async start(manuallyRequested: boolean) {
        if (this._active || this._starting) {
            return;
        }

        this._starting = true;

        try {
            const { saviDaemonUrl, saviDaemonToken, streamingLastLanguagesSynced } = await this._host.settings.get([
                'saviDaemonUrl',
                'saviDaemonToken',
                'streamingLastLanguagesSynced',
            ]);

            if (!saviDaemonUrl.trim() || !saviDaemonToken.trim()) {
                this._host.notify('Savi: daemon URL/token not configured in settings');
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
            const lang = (streamingLastLanguagesSynced[window.location.host] ?? []).find((l) => l && l !== '-');

            const command: SaviCommand<SaviStartCaptureMessage> = {
                sender: 'savi-video',
                message: {
                    command: 'savi-start-capture',
                    episodeId,
                    show,
                    title,
                    lang,
                    subtitles: serializeToSrt(subtitles),
                    subtitleFormat: 'srt',
                    src: this._host.videoSrc(),
                },
            };
            const response = (await browser.runtime.sendMessage(command)) as SaviStartCaptureResponse;

            if (response?.started) {
                // The recorder is live now — only now does segmenting begin,
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
                this._host.notify('Savi: capturing episode');
            } else if (response?.errorCode === 'no-active-tab') {
                // Browsers only grant tab-audio capture after a user gesture
                // on the extension. Auto-start (on subtitle load) has none, so
                // the recorder can't grab audio — tell the user the one thing
                // that fixes it. One click arms the whole tab session
                // (active-tab permission persists until the tab reloads), so
                // auto-capture works for every episode after the first click.
                this._host.notify(
                    'Savi: click the savi toolbar icon, then Start, to record this tab. One click enables audio for the whole session.'
                );
            } else {
                this._host.notify(`Savi: capture failed — ${response?.errorMessage ?? 'unknown error'}`);
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
    private _pageMetadata(): { episodeId: string; show?: string; title: string } {
        const url = this._safeLocationHref();
        const documentTitle = this._safeDocumentTitle();
        const netflixDom = this._readNetflixOverlay();
        const { show, title } = deriveShowAndTitle(url, documentTitle, netflixDom);

        return {
            episodeId: deriveEpisodeId(url, documentTitle),
            show,
            // title is guaranteed non-empty by deriveShowAndTitle, but guard
            // the daemon's non-empty requirement one more time.
            title: title.trim() || 'episode',
        };
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

    async stop() {
        if (!this._active) {
            return;
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
    }

    private _notifyFinished(result: { ok: boolean; info?: any; errorMessage?: string; failedSegments?: number }) {
        if (result.ok && result.info !== undefined) {
            const lines = String(result.info.totalLines);
            const minutes = (result.info.keptDurationMs / 60000).toFixed(1);
            this._host.notify(`Savi: episode saved — ${lines} lines, ${minutes} min of dialogue`);

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

        const command: SaviCommand<SaviSegmentMessage> = {
            sender: 'savi-video-to-offscreen',
            message: {
                command: 'savi-segment',
                ops,
            },
        };
        browser.runtime.sendMessage(command).catch(() => {
            // The offscreen document may already be gone; harmless.
        });
    }
}
