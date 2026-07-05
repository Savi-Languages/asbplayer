// Episode-length tab-audio recorder living in the (single, shared)
// offscreen document alongside asbplayer's short-clip AudioRecorder.
//
// Why here: MV3 service workers cannot hold a MediaRecorder and may be
// killed at any time; the offscreen document persists while it records
// (the same lifetime asbplayer's manual clip recording already relies
// on). Chunk uploads run from this document too, so a sleeping service
// worker never interrupts a capture. Segment cut messages are sent by
// the content script straight to this document for the same reason.
//
// Audio routing: capturing a tab mutes it, so the captured stream is
// routed back to the speakers via an AudioContext (asbplayer's own
// pattern) — through a gain node so the monitor can be muted while
// asbplayer's clip recorder borrows a clone of the stream (Chrome allows
// only one tabCapture of a tab at a time; without the clone handout,
// mining a card mid-capture would fail to record clip audio).

import {
    SaviCaptureEndedMessage,
    SaviCommand,
    SaviCaptureState,
    SaviOffscreenStartMessage,
    SaviSegmentOp,
    SaviRequester,
    SaviStopCaptureResponse,
} from './messages';
import { SegmentMeta } from './segmenter';
import { ChunkQueue } from './chunk-queue';
import { remoteDaemonToken } from './account';
import { CaptureFinishInfo, finishCapture, postChunk, SaviDaemonConfig } from './daemon-client';

const chunkTimesliceMs = 3000;
const cloneWatchIntervalMs = 500;
const cloneMaxAgeMs = 60000;

interface ActiveCapture {
    readonly captureId: string;
    readonly episodeId: string;
    readonly show?: string;
    readonly title: string;
    /** Resolved per daemon call, NOT snapshotted: the account JWT expires
     *  ~hourly and an episode capture routinely outlives it. */
    readonly configFor: () => Promise<SaviDaemonConfig>;
    readonly requester: SaviRequester;
    readonly stream: MediaStream;
    readonly audioContext: AudioContext;
    readonly monitorGain: GainNode;
    readonly queue: ChunkQueue;
    recorder?: MediaRecorder;
    recorderStopped?: Promise<void>;
    finishing: boolean;
}

interface CheckedOutClone {
    readonly stream: MediaStream;
    readonly checkedOutAt: number;
}

let activeCapture: ActiveCapture | undefined;
// The finish of a just-stopped capture (drain uploads + daemon stitch, which
// can take seconds) runs in the background; a new start waits on this so it
// doesn't collide with the still-finishing one.
let finishInFlight: Promise<void> | undefined;
let liveClones: CheckedOutClone[] = [];
let cloneWatchInterval: NodeJS.Timeout | undefined;

const captureStream = (streamId: string): Promise<MediaStream> => {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            // @ts-ignore
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
            },
        },
    });
};

const startSegment = (capture: ActiveCapture, segment: SegmentMeta) => {
    if (capture.recorder !== undefined) {
        endSegment(capture);
    }

    const recorder = new MediaRecorder(capture.stream);
    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            capture.queue.push({
                segmentId: segment.segmentId,
                mediaTimeMs: segment.mediaTimeMs,
                rate: segment.rate,
                data: e.data,
            });
        }
    };
    capture.recorderStopped = new Promise((resolve) => {
        recorder.onstop = () => {
            capture.queue.closeSegment(segment.segmentId);
            resolve();
        };
    });
    recorder.start(chunkTimesliceMs);
    capture.recorder = recorder;
};

const endSegment = (capture: ActiveCapture): Promise<void> => {
    const recorder = capture.recorder;
    const stopped = capture.recorderStopped ?? Promise.resolve();
    capture.recorder = undefined;
    capture.recorderStopped = undefined;

    if (recorder !== undefined && recorder.state !== 'inactive') {
        recorder.stop();
    }

    return stopped;
};

const startCapture = async (message: SaviOffscreenStartMessage): Promise<void> => {
    // A capture that was just stopped may still be finishing (draining its
    // upload queue + the daemon stitch). Wait for it to fully release the tab's
    // single tabCapture and clear the slot, or the restart throws "already in
    // progress" right after a stop.
    if (finishInFlight !== undefined) {
        await finishInFlight.catch(() => {});
        finishInFlight = undefined;
    }

    if (activeCapture !== undefined) {
        throw new Error('savi capture already in progress');
    }

    const stream = await captureStream(message.streamId);
    const audioContext = new AudioContext();
    const monitorGain = audioContext.createGain();
    audioContext.createMediaStreamSource(stream).connect(monitorGain);
    monitorGain.connect(audioContext.destination);

    // Current account token per chunk, LAN token as the fallback — reading it
    // at upload time is what keeps an hours-long capture alive across JWT
    // expiry/refresh.
    const configFor = async (): Promise<SaviDaemonConfig> => ({
        baseUrl: message.baseUrl,
        // Via the background — this offscreen document has no browser.storage.
        token: await remoteDaemonToken(message.lanToken),
    });
    const capture: ActiveCapture = {
        captureId: message.captureId,
        episodeId: message.episodeId,
        show: message.show,
        title: message.title,
        configFor,
        requester: message.requester,
        stream,
        audioContext,
        monitorGain,
        queue: new ChunkQueue(async (chunk) =>
            postChunk(await configFor(), {
                captureId: message.captureId,
                segmentId: chunk.segmentId,
                mediaTimeMs: chunk.mediaTimeMs,
                rate: chunk.rate,
                data: chunk.data as Blob,
            })
        ),
        finishing: false,
    };
    activeCapture = capture;

    // If the captured tab goes away the stream's tracks end; finish so
    // the episode-so-far still lands in the daemon.
    for (const track of stream.getTracks()) {
        track.onended = () => {
            if (activeCapture === capture && !capture.finishing) {
                finishInFlight = finishAndNotify();
            }
        };
    }

    // No segment starts here: the content script cuts the first segment
    // once it learns the recorder is live, so the media-time stamp is
    // sampled at recording time rather than at request time.
};

// Flush, drain the upload queue, ask the daemon to stitch + condense, and
// report the outcome via 'savi-capture-ended'. The daemon side can take
// minutes for a long episode, which is why the outcome is a push message
// rather than a response: a response chain would die with the MV3 service
// worker's idle timeout.
const finishAndNotify = async (): Promise<void> => {
    const capture = activeCapture;

    if (capture === undefined || capture.finishing) {
        return;
    }

    capture.finishing = true;

    try {
        await endSegment(capture);
        const stats = await capture.queue.drain();
        const info = await finishCapture(await capture.configFor(), capture.captureId);
        notifyCaptureEnded(capture.requester, {
            ok: true,
            info,
            failedSegments: stats.failedSegments.length,
        });
    } catch (e) {
        console.error('savi: finishing capture failed', e);
        notifyCaptureEnded(capture.requester, {
            ok: false,
            errorMessage: e instanceof Error ? e.message : String(e),
        });
    } finally {
        cleanupCapture(capture);
    }
};

const stopCapture = (): SaviStopCaptureResponse => {
    const capture = activeCapture;

    if (capture === undefined) {
        return { stopped: false, errorMessage: 'no savi capture in progress' };
    }

    if (capture.finishing) {
        return { stopped: false, errorMessage: 'savi capture already finishing' };
    }

    finishInFlight = finishAndNotify();
    return { stopped: true };
};

const cleanupCapture = (capture: ActiveCapture) => {
    for (const track of capture.stream.getTracks()) {
        track.onended = null;
        track.stop();
    }

    capture.audioContext.close().catch(() => {});

    if (activeCapture === capture) {
        activeCapture = undefined;
    }
};

const handleSegmentOps = (ops: SaviSegmentOp[]) => {
    const capture = activeCapture;

    if (capture === undefined || capture.finishing) {
        return;
    }

    for (const op of ops) {
        if (op.op === 'segment-start') {
            startSegment(capture, op.segment);
        } else {
            endSegment(capture);
        }
    }
};

const captureState = (): SaviCaptureState => {
    if (activeCapture === undefined || activeCapture.finishing) {
        return { active: false };
    }

    return {
        active: true,
        episodeId: activeCapture.episodeId,
        title: activeCapture.title,
        tabId: activeCapture.requester.tabId,
    };
};

const notifyCaptureEnded = (
    requester: SaviRequester,
    result: { ok: boolean; info?: CaptureFinishInfo; failedSegments?: number; errorMessage?: string }
) => {
    const command: SaviCommand<SaviCaptureEndedMessage> = {
        sender: 'savi-offscreen',
        message: {
            command: 'savi-capture-ended',
            requester,
            ok: result.ok,
            info: result.info,
            failedSegments: result.failedSegments,
            errorMessage: result.errorMessage,
        },
    };
    browser.runtime.sendMessage(command).catch(() => {});
};

// Lends asbplayer's clip recorder a clone of the captured stream while a
// savi capture holds the tab's one allowed tabCapture. The monitor is
// muted while a clone is live because the clip recorder routes its
// stream to the speakers itself — without this the tab would play
// doubled audio for the duration of the clip.
export const saviSharedStreamClone = (): MediaStream | undefined => {
    if (activeCapture === undefined || activeCapture.finishing) {
        return undefined;
    }

    const clone = activeCapture.stream.clone();
    liveClones.push({ stream: clone, checkedOutAt: Date.now() });
    updateMonitorMute();

    if (cloneWatchInterval === undefined) {
        cloneWatchInterval = setInterval(() => {
            const now = Date.now();
            liveClones = liveClones.filter(
                (clone) =>
                    now - clone.checkedOutAt < cloneMaxAgeMs &&
                    clone.stream.getTracks().some((t) => t.readyState === 'live')
            );
            updateMonitorMute();

            if (liveClones.length === 0 && cloneWatchInterval !== undefined) {
                clearInterval(cloneWatchInterval);
                cloneWatchInterval = undefined;
            }
        }, cloneWatchIntervalMs);
    }

    return clone;
};

const updateMonitorMute = () => {
    if (activeCapture !== undefined) {
        activeCapture.monitorGain.gain.value = liveClones.length > 0 ? 0 : 1;
    }
};

export const bindSaviOffscreenRecorder = () => {
    const listener = (request: any, sender: Browser.runtime.MessageSender, sendResponse: (r?: any) => void) => {
        if (request?.sender === 'savi-extension-to-offscreen') {
            switch (request.message.command) {
                case 'savi-offscreen-start':
                    startCapture(request.message as SaviOffscreenStartMessage)
                        .then(() => sendResponse({ started: true }))
                        .catch((e) => {
                            console.error(e);
                            sendResponse({
                                started: false,
                                errorCode:
                                    e instanceof DOMException && e.name === 'AbortError' ? 'no-active-tab' : 'other',
                                errorMessage: e instanceof Error ? e.message : String(e),
                            });
                        });
                    return true;
                case 'savi-offscreen-stop':
                    sendResponse(stopCapture());
                    break;
                case 'savi-offscreen-state':
                    sendResponse(captureState());
                    break;
            }
        } else if (request?.sender === 'savi-video-to-offscreen') {
            if (request.message.command === 'savi-segment') {
                handleSegmentOps(request.message.ops as SaviSegmentOp[]);
            }
        }
    };
    browser.runtime.onMessage.addListener(listener);

    window.addEventListener('beforeunload', () => {
        browser.runtime.onMessage.removeListener(listener);
    });
};
