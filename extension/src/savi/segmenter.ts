// Savi capture segmenter: a pure state machine that decides where audio
// segments begin and end.
//
// A SEGMENT is a contiguous run of playback. Audio inside a segment is
// assumed to advance in lockstep with media time (scaled by the playback
// rate), so a NEW segment must be cut on every event that breaks that
// assumption: pause, seek, and rate-change (per the savi design doc,
// Milestone 2). Buffering stalls break the assumption too — the media
// clock freezes while real time advances — so callers should map
// 'waiting' to pause() and 'playing' to play().
//
// Nothing here is stamped wall-clock: every segment carries the media
// time (video.currentTime * 1000) and playback rate sampled at the
// moment the segment starts. The savi daemon reassembles the episode
// timeline purely from these stamps.
//
// The daemon tempo-corrects rates within [0.5, 2.0] and rejects anything
// outside, so the segmenter refuses to open segments at unsupported
// rates (emitting 'rate-unsupported' instead) rather than poisoning the
// whole capture.

export interface SegmentMeta {
    readonly segmentId: string;
    readonly mediaTimeMs: number;
    readonly rate: number;
}

export type SegmenterOutput =
    | { readonly type: 'segment-start'; readonly segment: SegmentMeta }
    | { readonly type: 'segment-end' }
    | { readonly type: 'rate-unsupported'; readonly rate: number };

export const minCapturableRate = 0.5;
export const maxCapturableRate = 2.0;

const rateIsCapturable = (rate: number) => rate >= minCapturableRate && rate <= maxCapturableRate;

export class Segmenter {
    private _active = false;
    private _playing = false;
    private _recording = false;
    private _rate = 1;
    private _nextSegmentIndex = 0;
    private _current?: SegmentMeta;

    /** The segment currently open, if any.
     *
     *  Exposed so the caller can RE-ASSERT it. Boundary ops are the daemon's
     *  only picture of what is being recorded, and after a dropped
     *  'segment-start' nothing further is emitted until the next pause or
     *  seek — so continuous watching can go unrecorded indefinitely. One real
     *  episode lost a contiguous 20 minutes that way, identically in two
     *  separate takes. Repeating the open segment lets the daemon recover
     *  without the user doing anything. */
    get currentSegment(): SegmentMeta | undefined {
        return this._current;
    }

    get recording() {
        return this._recording;
    }

    get active() {
        return this._active;
    }

    // Capture begins. If the video is already playing (and the rate is
    // capturable) the first segment starts immediately.
    begin(mediaTimeMs: number, rate: number, paused: boolean): SegmenterOutput[] {
        this._active = true;
        this._playing = !paused;
        this._rate = rate;
        this._recording = false;
        return this._playing ? this._maybeStartSegment(mediaTimeMs) : [];
    }

    // 'play'/'playing' events. Idempotent while already recording.
    play(mediaTimeMs: number): SegmenterOutput[] {
        if (!this._active) {
            return [];
        }

        this._playing = true;

        if (this._recording) {
            return [];
        }

        return this._maybeStartSegment(mediaTimeMs);
    }

    // 'pause'/'waiting' events. Ends the current segment.
    pause(): SegmenterOutput[] {
        if (!this._active) {
            return [];
        }

        this._playing = false;
        return this._endSegmentIfRecording();
    }

    // 'seeked' events. Media time jumped: cut (end + start at the new
    // position). While paused there is nothing to cut — the next play()
    // samples the new position anyway.
    seeked(mediaTimeMs: number): SegmenterOutput[] {
        if (!this._active || !this._recording) {
            return [];
        }

        return [...this._endSegmentIfRecording(), ...this._maybeStartSegment(mediaTimeMs)];
    }

    // 'ratechange' events. Within a segment the rate must be constant, so
    // a real rate change while recording cuts a new segment stamped with
    // the new rate. Some players fire spurious ratechange events with an
    // unchanged value — those are ignored.
    rateChange(mediaTimeMs: number, rate: number): SegmenterOutput[] {
        if (!this._active || rate === this._rate) {
            this._rate = rate;
            return [];
        }

        this._rate = rate;

        if (this._recording) {
            return [...this._endSegmentIfRecording(), ...this._maybeStartSegment(mediaTimeMs)];
        }

        if (this._playing) {
            // Recovering from an unsupported rate without a play event.
            return this._maybeStartSegment(mediaTimeMs);
        }

        return [];
    }

    // Re-anchor: end the current segment and open a fresh one (new id) at the
    // CURRENT media time. Playback itself is unbroken — this exists for reasons
    // outside the media element:
    //
    //  - the daemon reported a different segment open (or none). It closed ours
    //    underneath us — its liveness timeout decided we were gone, or it
    //    refused to re-open a segment it had already closed. Re-asserting the
    //    same id cannot recover: only a NEW id, stamped at the live playhead,
    //    starts recording again.
    //  - the segment has simply run long. A media-time cap bounds how much any
    //    single undetected divergence can cost, and re-anchors the audio→media
    //    mapping instead of extrapolating it across the whole episode.
    //
    // No-op while not recording: there is nothing to re-anchor, and the next
    // play() samples a fresh position anyway.
    recut(mediaTimeMs: number): SegmenterOutput[] {
        if (!this._active || !this._recording) {
            return [];
        }

        return [...this._endSegmentIfRecording(), ...this._maybeStartSegment(mediaTimeMs)];
    }

    // Capture is finishing (ended / explicit stop / navigation).
    finish(): SegmenterOutput[] {
        if (!this._active) {
            return [];
        }

        this._active = false;
        this._playing = false;
        return this._endSegmentIfRecording();
    }

    private _maybeStartSegment(mediaTimeMs: number): SegmenterOutput[] {
        if (!rateIsCapturable(this._rate)) {
            return [{ type: 'rate-unsupported', rate: this._rate }];
        }

        this._recording = true;
        const segment: SegmentMeta = {
            segmentId: `s${this._nextSegmentIndex++}`,
            mediaTimeMs: Math.max(0, Math.round(mediaTimeMs)),
            rate: this._rate,
        };
        this._current = segment;
        return [{ type: 'segment-start', segment }];
    }

    private _endSegmentIfRecording(): SegmenterOutput[] {
        if (!this._recording) {
            return [];
        }

        this._recording = false;
        this._current = undefined;
        return [{ type: 'segment-end' }];
    }
}
