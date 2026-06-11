// Ordered upload queue for savi capture chunks.
//
// The savi daemon appends chunks of a segment to one file in arrival
// order, so chunks of a segment MUST be POSTed strictly in order: this
// queue keeps at most one POST in flight and processes items FIFO.
//
// Failure policy: a failed POST is retried once; a second failure
// poisons the segment — its remaining (and future) chunks are dropped so
// a mid-segment gap can't silently corrupt the daemon-side file, and the
// capture keeps going with the next segment.
//
// Tiny-segment suppression: rapid pause/play (or cut storms) can produce
// segments whose only chunk is a header-only WebM blob. A corrupt or
// empty segment file would fail the daemon's ffmpeg stitch for the WHOLE
// episode at finish time, so the first chunk of each segment is held
// until either a second chunk arrives (the segment is clearly real) or
// the segment closes — and a single-chunk segment smaller than
// minTailBytes is dropped instead of posted. MediaRecorder emits a
// segment's final chunk before its close in all cases, so holding the
// first chunk never reorders anything.

export interface QueuedChunk {
    readonly segmentId: string;
    readonly mediaTimeMs: number;
    readonly rate: number;
    readonly data: { readonly size: number };
}

export type ChunkPoster = (chunk: QueuedChunk) => Promise<void>;

export interface ChunkQueueStats {
    readonly posted: number;
    readonly retried: number;
    readonly failedSegments: string[];
    readonly droppedTinySegments: string[];
}

const defaultMinTailBytes = 2048;

export class ChunkQueue {
    private readonly _post: ChunkPoster;
    private readonly _minTailBytes: number;

    private _tail: Promise<void> = Promise.resolve();
    private _heldFirstChunk: Map<string, QueuedChunk> = new Map();
    private _chunkCounts: Map<string, number> = new Map();
    private _poisonedSegments: Set<string> = new Set();

    private _posted = 0;
    private _retried = 0;
    private _failedSegments: string[] = [];
    private _droppedTinySegments: string[] = [];

    constructor(post: ChunkPoster, { minTailBytes }: { minTailBytes?: number } = {}) {
        this._post = post;
        this._minTailBytes = minTailBytes ?? defaultMinTailBytes;
    }

    push(chunk: QueuedChunk) {
        this._enqueue(() => this._handleChunk(chunk));
    }

    closeSegment(segmentId: string) {
        this._enqueue(() => this._handleClose(segmentId));
    }

    // Resolves once everything queued so far has been posted or dropped.
    drain(): Promise<ChunkQueueStats> {
        return this._tail.then(() => this.stats());
    }

    stats(): ChunkQueueStats {
        return {
            posted: this._posted,
            retried: this._retried,
            failedSegments: [...this._failedSegments],
            droppedTinySegments: [...this._droppedTinySegments],
        };
    }

    private _enqueue(task: () => Promise<void>) {
        this._tail = this._tail.then(task, task);
    }

    private async _handleChunk(chunk: QueuedChunk) {
        const segmentId = chunk.segmentId;

        if (this._poisonedSegments.has(segmentId)) {
            return;
        }

        const count = (this._chunkCounts.get(segmentId) ?? 0) + 1;
        this._chunkCounts.set(segmentId, count);

        if (count === 1) {
            this._heldFirstChunk.set(segmentId, chunk);
            return;
        }

        const held = this._heldFirstChunk.get(segmentId);

        if (held !== undefined) {
            this._heldFirstChunk.delete(segmentId);
            await this._postWithRetry(held);
        }

        if (this._poisonedSegments.has(segmentId)) {
            return;
        }

        await this._postWithRetry(chunk);
    }

    private async _handleClose(segmentId: string) {
        const held = this._heldFirstChunk.get(segmentId);
        this._heldFirstChunk.delete(segmentId);
        this._chunkCounts.delete(segmentId);

        if (held === undefined) {
            return;
        }

        if (held.data.size < this._minTailBytes) {
            this._droppedTinySegments.push(segmentId);
            return;
        }

        await this._postWithRetry(held);
    }

    private async _postWithRetry(chunk: QueuedChunk) {
        try {
            await this._post(chunk);
            ++this._posted;
        } catch (e) {
            ++this._retried;

            try {
                await this._post(chunk);
                ++this._posted;
            } catch (e2) {
                console.error('savi: dropping segment after repeated chunk upload failure', chunk.segmentId, e2);
                this._poisonedSegments.add(chunk.segmentId);
                this._failedSegments.push(chunk.segmentId);
            }
        }
    }
}
