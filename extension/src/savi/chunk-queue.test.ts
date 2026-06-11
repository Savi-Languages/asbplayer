import { ChunkQueue, QueuedChunk } from './chunk-queue';

const chunk = (segmentId: string, size: number, mediaTimeMs = 0, rate = 1): QueuedChunk => ({
    segmentId,
    mediaTimeMs,
    rate,
    data: { size },
});

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: any) => void;
}

const deferred = (): Deferred => {
    let resolve!: () => void;
    let reject!: (e: any) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

describe('ChunkQueue', () => {
    it('posts chunks of a segment strictly in order with one request in flight', async () => {
        const events: string[] = [];
        let seq = 0;
        const queue = new ChunkQueue(async (c) => {
            const id = seq++;
            events.push(`start-${id}:${c.segmentId}`);
            // Hold the request across a macrotask so an out-of-order or
            // overlapping POST would be visible in the event log.
            await new Promise((resolve) => setTimeout(resolve, 0));
            events.push(`end-${id}`);
        });

        queue.push(chunk('s0', 50000, 1000, 1));
        queue.push(chunk('s0', 50000));
        queue.push(chunk('s0', 50000));
        queue.closeSegment('s0');
        await queue.drain();

        // No POST starts before the previous one finished, and arrival
        // order is preserved.
        expect(events).toEqual(['start-0:s0', 'end-0', 'start-1:s0', 'end-1', 'start-2:s0', 'end-2']);
    });

    it('posts a single-chunk segment at close when it is big enough', async () => {
        const posted: QueuedChunk[] = [];
        const queue = new ChunkQueue(async (c) => {
            posted.push(c);
        });

        queue.push(chunk('s0', 40000, 5000, 1.25));
        queue.closeSegment('s0');
        const stats = await queue.drain();

        expect(posted).toHaveLength(1);
        expect(posted[0].mediaTimeMs).toBe(5000);
        expect(posted[0].rate).toBe(1.25);
        expect(stats.posted).toBe(1);
        expect(stats.droppedTinySegments).toEqual([]);
    });

    it('drops a single-chunk segment smaller than the tiny-segment floor', async () => {
        const posted: QueuedChunk[] = [];
        const queue = new ChunkQueue(
            async (c) => {
                posted.push(c);
            },
            { minTailBytes: 2048 }
        );

        // A header-only WebM blob from an instant pause/play cut
        queue.push(chunk('s0', 700));
        queue.closeSegment('s0');
        // The next, real segment still uploads
        queue.push(chunk('s1', 50000));
        queue.closeSegment('s1');
        const stats = await queue.drain();

        expect(posted.map((c) => c.segmentId)).toEqual(['s1']);
        expect(stats.droppedTinySegments).toEqual(['s0']);
        expect(stats.posted).toBe(1);
    });

    it('retries a failed POST once and succeeds', async () => {
        let attempts = 0;
        const queue = new ChunkQueue(async () => {
            ++attempts;

            if (attempts === 1) {
                throw new Error('connection reset');
            }
        });

        queue.push(chunk('s0', 50000));
        queue.closeSegment('s0');
        const stats = await queue.drain();

        expect(attempts).toBe(2);
        expect(stats.posted).toBe(1);
        expect(stats.retried).toBe(1);
        expect(stats.failedSegments).toEqual([]);
    });

    it('poisons a segment after the retry also fails and drops its remaining chunks', async () => {
        const attempted: string[] = [];
        const queue = new ChunkQueue(async (c) => {
            attempted.push(c.segmentId);

            if (c.segmentId === 's0') {
                throw new Error('daemon down');
            }
        });

        queue.push(chunk('s0', 50000));
        queue.push(chunk('s0', 50000)); // releases the held first chunk
        queue.push(chunk('s0', 50000)); // must be dropped after poisoning
        queue.closeSegment('s0');
        queue.push(chunk('s1', 50000)); // later segment is unaffected
        queue.closeSegment('s1');
        const stats = await queue.drain();

        // s0 first chunk: 2 attempts, then poisoned; s0's remaining chunks dropped
        expect(attempted).toEqual(['s0', 's0', 's1']);
        expect(stats.failedSegments).toEqual(['s0']);
        expect(stats.posted).toBe(1);
    });

    it('keeps the queue alive after a rejected POST (failure does not wedge later items)', async () => {
        let calls = 0;
        const queue = new ChunkQueue(async () => {
            ++calls;
            throw new Error('always failing');
        });

        queue.push(chunk('s0', 50000));
        queue.push(chunk('s0', 50000));
        queue.closeSegment('s0');
        queue.push(chunk('s1', 50000));
        queue.closeSegment('s1');
        const stats = await queue.drain();

        // s0 chunk1: 2 attempts -> poisoned; chunk2 dropped; s1: 2 attempts -> poisoned
        expect(calls).toBe(4);
        expect(stats.failedSegments).toEqual(['s0', 's1']);
        expect(stats.posted).toBe(0);
    });

    it('drain resolves only after queued work settles and reports cumulative stats', async () => {
        const posted: string[] = [];
        const gate = deferred();
        const queue = new ChunkQueue(async (c) => {
            await gate.promise;
            posted.push(c.segmentId);
        });

        queue.push(chunk('s0', 50000));
        queue.push(chunk('s0', 50000));
        queue.closeSegment('s0');

        let drained = false;
        const drainPromise = queue.drain().then((stats) => {
            drained = true;
            return stats;
        });

        await Promise.resolve();
        expect(drained).toBe(false);

        gate.resolve();
        const stats = await drainPromise;
        expect(posted).toEqual(['s0', 's0']);
        expect(stats.posted).toBe(2);
    });

    it('closing a segment that produced no chunks is a no-op', async () => {
        const queue = new ChunkQueue(async () => {});
        queue.closeSegment('sx');
        const stats = await queue.drain();
        expect(stats.posted).toBe(0);
        expect(stats.droppedTinySegments).toEqual([]);
    });
});
