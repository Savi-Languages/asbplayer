import { Segmenter, SegmenterOutput } from './segmenter';

const segmentStarts = (outputs: SegmenterOutput[]) =>
    outputs.filter((o) => o.type === 'segment-start').map((o) => (o as any).segment);

describe('Segmenter', () => {
    it('starts a segment immediately when capture begins during playback', () => {
        const segmenter = new Segmenter();
        const outputs = segmenter.begin(12345, 1, false);
        expect(outputs).toEqual([{ type: 'segment-start', segment: { segmentId: 's0', mediaTimeMs: 12345, rate: 1 } }]);
        expect(segmenter.recording).toBe(true);
    });

    it('does not start a segment when capture begins paused, then starts on play', () => {
        const segmenter = new Segmenter();
        expect(segmenter.begin(5000, 1, true)).toEqual([]);
        expect(segmenter.recording).toBe(false);

        const outputs = segmenter.play(5000);
        expect(outputs).toEqual([{ type: 'segment-start', segment: { segmentId: 's0', mediaTimeMs: 5000, rate: 1 } }]);
    });

    it('cuts a segment on every pause/play cycle with fresh media time', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);

        expect(segmenter.pause()).toEqual([{ type: 'segment-end' }]);
        expect(segmenter.recording).toBe(false);

        const outputs = segmenter.play(30000);
        expect(outputs).toEqual([{ type: 'segment-start', segment: { segmentId: 's1', mediaTimeMs: 30000, rate: 1 } }]);
    });

    it('is idempotent for duplicate play/playing and pause/waiting events', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, true);

        expect(segmenter.play(0)).toHaveLength(1);
        expect(segmenter.play(100)).toEqual([]); // 'playing' after 'play'

        expect(segmenter.pause()).toEqual([{ type: 'segment-end' }]);
        expect(segmenter.pause()).toEqual([]); // 'waiting' after 'pause'
    });

    it('cuts end+start on seek while playing, stamped at the new position', () => {
        const segmenter = new Segmenter();
        segmenter.begin(1000, 1.5, false);

        const outputs = segmenter.seeked(90000);
        expect(outputs).toEqual([
            { type: 'segment-end' },
            { type: 'segment-start', segment: { segmentId: 's1', mediaTimeMs: 90000, rate: 1.5 } },
        ]);
    });

    it('does not cut on seek while paused; the next play picks up the new position', () => {
        const segmenter = new Segmenter();
        segmenter.begin(1000, 1, false);
        segmenter.pause();

        expect(segmenter.seeked(500)).toEqual([]);
        expect(segmenter.play(500)).toEqual([
            { type: 'segment-start', segment: { segmentId: 's1', mediaTimeMs: 500, rate: 1 } },
        ]);
    });

    it('cuts a new segment carrying the new rate on rate change while playing', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);

        const outputs = segmenter.rateChange(45000, 1.25);
        expect(outputs).toEqual([
            { type: 'segment-end' },
            { type: 'segment-start', segment: { segmentId: 's1', mediaTimeMs: 45000, rate: 1.25 } },
        ]);
    });

    it('ignores spurious ratechange events with an unchanged rate', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);
        expect(segmenter.rateChange(1000, 1)).toEqual([]);
        expect(segmenter.recording).toBe(true);
    });

    it('remembers a rate change made while paused for the next segment', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);
        segmenter.pause();

        expect(segmenter.rateChange(60000, 2)).toEqual([]);

        const outputs = segmenter.play(60000);
        expect(segmentStarts(outputs)[0]).toEqual({ segmentId: 's1', mediaTimeMs: 60000, rate: 2 });
    });

    it('refuses to record at unsupported rates and recovers when the rate returns to range', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);

        // 2.5x is outside the daemon's atempo range 0.5-2.0
        const outputs = segmenter.rateChange(10000, 2.5);
        expect(outputs).toEqual([{ type: 'segment-end' }, { type: 'rate-unsupported', rate: 2.5 }]);
        expect(segmenter.recording).toBe(false);

        // still playing; back to a supported rate resumes recording
        const recovered = segmenter.rateChange(15000, 1);
        expect(recovered).toEqual([
            { type: 'segment-start', segment: { segmentId: 's1', mediaTimeMs: 15000, rate: 1 } },
        ]);
    });

    it('reports rate-unsupported when capture begins at an unsupported rate', () => {
        const segmenter = new Segmenter();
        const outputs = segmenter.begin(0, 0.25, false);
        expect(outputs).toEqual([{ type: 'rate-unsupported', rate: 0.25 }]);
        expect(segmenter.recording).toBe(false);
    });

    it('accepts the boundary rates 0.5 and 2.0', () => {
        const fast = new Segmenter();
        expect(segmentStarts(fast.begin(0, 2.0, false))[0].rate).toBe(2.0);

        const slow = new Segmenter();
        expect(segmentStarts(slow.begin(0, 0.5, false))[0].rate).toBe(0.5);
    });

    it('ends the open segment on finish and goes inactive', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);

        expect(segmenter.finish()).toEqual([{ type: 'segment-end' }]);
        expect(segmenter.active).toBe(false);
        expect(segmenter.play(1000)).toEqual([]); // inert after finish
    });

    it('emits nothing on finish while paused', () => {
        const segmenter = new Segmenter();
        segmenter.begin(0, 1, false);
        segmenter.pause();
        expect(segmenter.finish()).toEqual([]);
    });

    it('produces unique, ordered segment ids across a realistic viewing session', () => {
        const segmenter = new Segmenter();
        const all: SegmenterOutput[] = [
            ...segmenter.begin(0, 1, false), // s0 at 0
            ...segmenter.pause(), // line auto-pause
            ...segmenter.play(4000), // s1 resumes
            ...segmenter.seeked(1000), // replay the line: s2
            ...segmenter.rateChange(2000, 0.75), // slow down: s3
            ...segmenter.finish(),
        ];
        const segments = segmentStarts(all);
        expect(segments.map((s: any) => s.segmentId)).toEqual(['s0', 's1', 's2', 's3']);
        expect(segments.map((s: any) => s.mediaTimeMs)).toEqual([0, 4000, 1000, 2000]);
        expect(segments.map((s: any) => s.rate)).toEqual([1, 1, 1, 0.75]);
    });

    it('clamps negative media times to zero and rounds fractional ones', () => {
        const segmenter = new Segmenter();
        const outputs = segmenter.begin(-50.7, 1, false);
        expect(segmentStarts(outputs)[0].mediaTimeMs).toBe(0);

        segmenter.seeked(1000.4);
        // finished above; create a new one to check rounding cleanly
        const s2 = new Segmenter();
        expect(segmentStarts(s2.begin(1000.5, 1, false))[0].mediaTimeMs).toBe(1001);
    });
});
