/**
 * Speed-trace tests — sparkline geometry.
 *
 * Coordinates are hand-computed from the box and the lap's own speed range, so an
 * inverted axis or an off-by-one on the last sample fails here rather than showing up as
 * a sparkline that disagrees with the scrubber.
 */
import { describe, expect, it } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import type { Sample } from "./schema";
import { buildSpeedTrace, tracePlayheadX } from "./trace";

const replay = parseReplay(sampleLap, "sample-lap.json");
const samples = replay.cars[0].samples;

/** Minimal samples — only `speed` matters to the trace. */
const at = (...speeds: number[]): Sample[] =>
  speeds.map((speed, i) => ({
    t: i / 10,
    x: 0,
    y: 0,
    speed,
    throttle: 0,
    brake: 0 as const,
    gear: 1,
  }));

/** Parse an SVG path back into points. */
const pointsOf = (path: string): { x: number; y: number }[] =>
  [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));

describe("buildSpeedTrace", () => {
  it("spans the full width, first sample to last", () => {
    const { path } = buildSpeedTrace(at(100, 200, 300), 90, 30);
    const pts = pointsOf(path);
    expect(pts).toHaveLength(3);
    expect(pts[0].x).toBe(0);
    expect(pts[1].x).toBe(45);
    expect(pts[2].x).toBe(90);
  });

  it("puts fast at the TOP — a chart reads upward, unlike the track canvas", () => {
    const { path } = buildSpeedTrace(at(100, 300, 200), 100, 40);
    const pts = pointsOf(path);
    expect(pts[0].y).toBe(40); // slowest → bottom
    expect(pts[1].y).toBe(0); // fastest → top
    expect(pts[2].y).toBe(20); // halfway
  });

  it("scales to the lap's own range, not a fixed axis", () => {
    // A narrow, slow lap still fills the box: 250 is the max here even though the
    // thermal ramp goes to 340.
    const { path, minKmh, maxKmh } = buildSpeedTrace(at(240, 250), 10, 10);
    expect([minKmh, maxKmh]).toEqual([240, 250]);
    const pts = pointsOf(path);
    expect(pts[0].y).toBe(10);
    expect(pts[1].y).toBe(0);
  });

  it("starts with a moveTo and continues with lineTos", () => {
    const { path } = buildSpeedTrace(at(1, 2, 3), 10, 10);
    expect(path.startsWith("M")).toBe(true);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path.match(/L/g)).toHaveLength(2);
  });

  it("draws a flat lap down the middle instead of dividing by zero", () => {
    const { path } = buildSpeedTrace(at(200, 200, 200), 20, 10);
    for (const p of pointsOf(path)) expect(p.y).toBe(5);
    expect(path).not.toContain("NaN");
  });

  it("handles a single sample without dividing by zero", () => {
    const { path } = buildSpeedTrace(at(200), 20, 10);
    expect(pointsOf(path)).toEqual([{ x: 0, y: 5 }]);
  });

  it("throws on no samples rather than rendering a blank box", () => {
    expect(() => buildSpeedTrace([], 10, 10)).toThrow(RangeError);
  });

  it("fits the fixture lap inside the box", () => {
    const w = 220;
    const h = 44;
    const { path, minKmh, maxKmh } = buildSpeedTrace(samples, w, h);
    expect(minKmh).toBe(157);
    expect(maxKmh).toBe(338);

    const pts = pointsOf(path);
    expect(pts).toHaveLength(samples.length);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(w);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(h);
    }
  });
});

describe("tracePlayheadX", () => {
  it("maps the clock across the width on meta.duration", () => {
    expect(tracePlayheadX(0, 58.5, 100)).toBe(0);
    expect(tracePlayheadX(29.25, 58.5, 100)).toBe(50);
    expect(tracePlayheadX(58.5, 58.5, 100)).toBe(100);
  });

  it("uses duration, so it agrees with the scrubber's range", () => {
    // The scrubber is ranged on meta.duration; deriving the playhead from the sample
    // count instead would drift them apart by a grid step.
    const w = 200;
    expect(
      tracePlayheadX(replay.meta.duration / 2, replay.meta.duration, w),
    ).toBe(w / 2);
  });

  it("clamps rather than running off either end", () => {
    expect(tracePlayheadX(-5, 58.5, 100)).toBe(0);
    expect(tracePlayheadX(1000, 58.5, 100)).toBe(100);
  });

  it("returns 0 for a nonsense duration instead of NaN", () => {
    expect(tracePlayheadX(5, 0, 100)).toBe(0);
    expect(tracePlayheadX(5, NaN, 100)).toBe(0);
    expect(tracePlayheadX(5, Infinity, 100)).toBe(0);
  });
});
