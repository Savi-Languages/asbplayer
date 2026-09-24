/** Coverage of actual forward playback. Seeks, paused time and overlapping
 *  replays cannot manufacture a heard line. A line needs 90% media coverage. */
export class TargetHeardCoverage {
    private last?: { position: number; wall: number; playing: boolean; rate: number };
    private spans = new Map<number, [number, number][]>();
    clear(): void {
        this.last = undefined;
        this.spans.clear();
    }
    tick(
        position: number,
        wall: number,
        playing: boolean,
        rate: number,
        lines: readonly { start: number; end: number; track?: number }[]
    ): void {
        const previous = this.last;
        this.last = { position, wall, playing, rate };
        if (!previous || !playing || !previous.playing) return;
        const elapsed = wall - previous.wall,
            delta = position - previous.position;
        if (
            elapsed <= 0 ||
            elapsed > 2000 ||
            delta <= 0 ||
            Math.abs(delta - elapsed * previous.rate) > Math.max(400, elapsed * previous.rate * 0.35)
        )
            return;
        for (const line of lines) {
            if ((line.track ?? 0) !== 0 || line.end <= previous.position || line.start >= position) continue;
            const spans = [
                ...(this.spans.get(line.start) ?? []),
                [Math.max(line.start, previous.position), Math.min(line.end, position)] as [number, number],
            ].sort((a, b) => a[0] - b[0]);
            const merged: [number, number][] = [];
            for (const span of spans) {
                const last = merged[merged.length - 1];
                if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
                else merged.push(span);
            }
            this.spans.set(line.start, merged);
        }
        while (this.spans.size > 128) this.spans.delete(this.spans.keys().next().value!);
    }
    heard(start: number, end: number): boolean {
        return end > start && (this.spans.get(start) ?? []).reduce((n, [a, b]) => n + b - a, 0) >= (end - start) * 0.9;
    }
}
