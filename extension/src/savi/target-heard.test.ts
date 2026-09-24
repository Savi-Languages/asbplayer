import { TargetHeardCoverage } from './target-heard';
it('requires actual playback coverage; a seek or repeated fragment does not qualify', () => {
    const coverage = new TargetHeardCoverage();
    const lines = [{ start: 0, end: 2000 }];
    coverage.tick(0, 0, true, 1, lines);
    coverage.tick(500, 500, true, 1, lines);
    expect(coverage.heard(0, 2000)).toBe(false);
    coverage.tick(2000, 750, true, 1, lines);
    expect(coverage.heard(0, 2000)).toBe(false);
    coverage.tick(0, 1000, false, 1, lines);
    coverage.tick(0, 1100, true, 1, lines);
    coverage.tick(500, 1600, true, 1, lines);
    expect(coverage.heard(0, 2000)).toBe(false);
    coverage.tick(1000, 2100, true, 1, lines);
    coverage.tick(1500, 2600, true, 1, lines);
    coverage.tick(2000, 3100, true, 1, lines);
    expect(coverage.heard(0, 2000)).toBe(true);
});
it('does not count paused time or translation tracks and resets between episodes', () => {
    const coverage = new TargetHeardCoverage();
    const lines = [{ start: 0, end: 1000, track: 1 }];
    coverage.tick(0, 0, true, 1, lines);
    coverage.tick(1000, 1000, true, 1, lines);
    expect(coverage.heard(0, 1000)).toBe(false);
    coverage.clear();
    coverage.tick(0, 0, false, 1, [{ start: 0, end: 1000 }]);
    coverage.tick(1000, 1000, false, 1, [{ start: 0, end: 1000 }]);
    expect(coverage.heard(0, 1000)).toBe(false);
});
