/**
 * Speed-trace tests — the scrolling window's geometry.
 *
 * Coordinates are hand-computed from the box, the window and the replay's own speed range,
 * so an inverted axis, a window that is not bounded, or a playhead that drifts off its
 * fraction fails here rather than showing up as a trace that disagrees with the clock.
 *
 * The two properties this slice exists to create get their own tests and are the ones to
 * keep honest: the drawn span is BOUNDED and independent of window length, and the
 * playhead is FIXED once there is a full window behind it.
 */
import { describe, expect, it } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import type { Sample } from "./schema";
import {
  buildTraceWindow,
  PLAYHEAD_FRACTION,
  speedRange,
  TRACE_H,
  TRACE_SECONDS,
  TRACE_W,
  type TraceView,
} from "./trace";

const replay = parseReplay(sampleLap, "sample-lap.json");
const samples = replay.cars[0].samples;
const RATE = replay.meta.sampleRateHz;

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

/** A synthetic replay of `seconds` at 10 Hz, speed sweeping so nothing is degenerate. */
const lapOf = (seconds: number): Sample[] =>
  at(
    ...Array.from(
      { length: Math.round(seconds * 10) },
      (_, i) => 100 + 100 * Math.sin(i / 7),
    ),
  );

/** Parse an SVG path back into points. */
const pointsOf = (path: string): { x: number; y: number }[] =>
  [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));

/** A view over `s`, with the defaults every test would otherwise repeat. */
const view = (
  s: readonly Sample[],
  over: Partial<TraceView> = {},
): TraceView => ({
  samples: s,
  sampleRateHz: 10,
  clock: 0,
  duration: s.length / 10,
  range: speedRange(s),
  width: TRACE_W,
  height: TRACE_H,
  ...over,
});

describe("speedRange", () => {
  it("takes the range from the WHOLE replay, so the axis does not breathe", () => {
    expect(speedRange(at(240, 100, 250))).toEqual({ minKmh: 100, maxKmh: 250 });
  });

  it("reads the fixture lap", () => {
    expect(speedRange(samples)).toEqual({ minKmh: 157, maxKmh: 338 });
  });

  it("throws on no samples rather than rendering a blank box", () => {
    expect(() => speedRange([])).toThrow(RangeError);
  });
});

describe("buildTraceWindow — the bound", () => {
  /**
   * THE PROPERTY THIS SLICE EXISTS FOR, in the shape of Slice 9b's comet bound test.
   *
   * The old sparkline drew one point per sample of the whole replay: 585 on the fixture,
   * 5792 on the 9-minute endgame file. Bounded means the 9-minute file draws no more than
   * the 1-minute one, so legibility stops depending on window length.
   */
  const MAX_POINTS = TRACE_SECONDS * 10 + 2;

  it.each([30, 60, 300, 579])(
    "draws at most one window of points over a %s s replay",
    (seconds) => {
      const s = lapOf(seconds);
      const v = view(s);
      for (const clock of [0, 5, 19.9, 20, 21, seconds / 2, seconds - 0.05]) {
        const n = pointsOf(buildTraceWindow({ ...v, clock }).path).length;
        expect(n).toBeLessThanOrEqual(MAX_POINTS);
      }
    },
  );

  it("draws the SAME number of points deep into a 9-minute window as a 1-minute one", () => {
    // Independence from window length, stated as an equality rather than a bound: this
    // is what "its cost is a constant" means, and it is the claim Slice 12 will re-run.
    const short = buildTraceWindow({ ...view(lapOf(60)), clock: 45 });
    const long = buildTraceWindow({ ...view(lapOf(579)), clock: 500 });
    expect(pointsOf(long.path).length).toBe(pointsOf(short.path).length);
    expect(pointsOf(long.path).length).toBe(TRACE_SECONDS * 10 + 1);
  });

  it("keeps the window one whole `TRACE_SECONDS` wide, however long the replay", () => {
    const w = buildTraceWindow({ ...view(lapOf(579)), clock: 400 });
    expect(w.endS - w.startS).toBeCloseTo(TRACE_SECONDS, 10);
    expect(w.startS).toBeCloseTo(400 - TRACE_SECONDS, 10);
  });
});

describe("buildTraceWindow — the fixed playhead", () => {
  const long = view(lapOf(579));

  it("pins the playhead once a full window is behind it", () => {
    for (const clock of [20, 21, 100, 300, 578])
      expect(buildTraceWindow({ ...long, clock }).playheadX).toBe(
        PLAYHEAD_FRACTION * TRACE_W,
      );
  });

  it("sweeps up to it while the clock is younger than the window", () => {
    // The fill-in: at the start of a replay — and at the start of every lap of a closed
    // one — there is no history to show yet, so the trace fills in from the left.
    expect(buildTraceWindow({ ...long, clock: 0 }).playheadX).toBe(0);
    expect(buildTraceWindow({ ...long, clock: 5 }).playheadX).toBeCloseTo(
      (5 / TRACE_SECONDS) * TRACE_W,
      6,
    );
    expect(buildTraceWindow({ ...long, clock: 0 }).startS).toBe(0);
    expect(buildTraceWindow({ ...long, clock: 5 }).startS).toBe(0);
  });

  it("clamps at the end of an open window instead of running off it", () => {
    const w = buildTraceWindow({ ...long, clock: 579 });
    expect(w.endS).toBeCloseTo(579, 6);
    expect(w.playheadX).toBe(PLAYHEAD_FRACTION * TRACE_W);
  });

  it("ships history-only — the window ends at the present", () => {
    // `PLAYHEAD_FRACTION` is the knob; this is what shipping it at 1 means, and it fails
    // if the constant moves without the decision being re-taken.
    expect(PLAYHEAD_FRACTION).toBe(1);
    const w = buildTraceWindow({ ...long, clock: 300 });
    expect(w.endS).toBeCloseTo(300, 6);
  });
});

describe("buildTraceWindow — degrading to the full trace", () => {
  /**
   * A replay SHORTER than the window is not letterboxed and is not a branch: `span`
   * clamps to `duration`, `t0` is 0 forever, and what comes out is the pre-9e full-trace
   * behaviour. The v1 laps are the regression fixtures, so this is where they land.
   */
  const short = view(lapOf(12)); // 12 s against TRACE_SECONDS = 20

  it("spans the whole replay, first sample to last", () => {
    const pts = pointsOf(buildTraceWindow({ ...short, clock: 12 }).path);
    expect(pts).toHaveLength(121); // every sample, no head duplicate
    expect(pts[0].x).toBe(0);
    expect(pts[pts.length - 1].x).toBe(TRACE_W);
  });

  it("sweeps the playhead across it exactly as the old `tracePlayheadX` did", () => {
    // The pre-9e mapping was `clamp(clock / duration) * width`. Degradation means
    // reproducing it, not approximating it.
    for (const clock of [0, 3, 6, 9, 12])
      expect(buildTraceWindow({ ...short, clock }).playheadX).toBeCloseTo(
        (clock / 12) * TRACE_W,
        6,
      );
  });

  it("never scrolls: the window is the replay", () => {
    for (const clock of [0, 6, 12]) {
      const w = buildTraceWindow({ ...short, clock });
      expect(w.startS).toBe(0);
      expect(w.endS).toBe(12);
    }
  });
});

describe("buildTraceWindow — the curve", () => {
  it("puts fast at the TOP — a chart reads upward, unlike the track canvas", () => {
    const s = at(100, 300, 200);
    const pts = pointsOf(
      buildTraceWindow({ ...view(s), clock: 0.2, height: 40 }).path,
    );
    expect(pts[0].y).toBe(40); // slowest → bottom
    expect(pts[1].y).toBe(0); // fastest → top
    expect(pts[2].y).toBe(20); // halfway
  });

  it("maps a sample to the SAME y at any clock — the axis is the replay's", () => {
    // The mutation this catches is scaling y to the visible window: the curve would
    // breathe as it scrolls and a constant-speed straight would fill the box.
    const s = lapOf(579);
    const v = view(s);
    const yAt = (clock: number, t: number) => {
      const w = buildTraceWindow({ ...v, clock });
      const pts = pointsOf(w.path);
      const x = ((t - w.startS) / (w.endS - w.startS)) * TRACE_W;
      return pts.find((p) => Math.abs(p.x - x) < 0.02)?.y;
    };
    // Sample t = 300.0 s, seen near the leading edge of one window and the trailing
    // edge of another.
    expect(yAt(301, 300)).toBeDefined();
    expect(yAt(301, 300)).toBe(yAt(319, 300));
  });

  it("ends ON the playhead, interpolated between grid points", () => {
    // Snapping the head to the grid would leave the curve up to a grid step short of
    // the playhead — visible as a gap that pulses at the sample rate.
    const s = at(100, 200, 300, 400);
    const w = buildTraceWindow({ ...view(s), clock: 0.25 });
    const pts = pointsOf(w.path);
    const head = pts[pts.length - 1];
    expect(head.x).toBeCloseTo(w.playheadX, 6);
    // Halfway between 300 and 400 on a 100-400 range, in a box of TRACE_H.
    expect(head.y).toBeCloseTo(TRACE_H - (250 / 300) * TRACE_H, 1);
  });

  it("holds the last sample past the end of the data instead of extrapolating", () => {
    const s = at(100, 200, 300);
    const w = buildTraceWindow({ ...view(s), clock: 0.25, duration: 0.3 });
    const pts = pointsOf(w.path);
    expect(pts[pts.length - 1].y).toBe(pts[2].y);
  });

  it("starts with a moveTo and continues with lineTos", () => {
    const { path } = buildTraceWindow({ ...view(at(1, 2, 3)), clock: 0.2 });
    expect(path.startsWith("M")).toBe(true);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path.match(/L/g)).toHaveLength(2);
  });

  it("draws a flat lap down the middle instead of dividing by zero", () => {
    const { path } = buildTraceWindow({
      ...view(at(200, 200, 200)),
      clock: 0.2,
      height: 10,
    });
    for (const p of pointsOf(path)) expect(p.y).toBe(5);
    expect(path).not.toContain("NaN");
  });

  it("fits the fixture lap inside the box at every clock", () => {
    const v = view(samples, {
      sampleRateHz: RATE,
      duration: replay.meta.duration,
    });
    for (let clock = 0; clock < replay.meta.duration; clock += 1.3) {
      for (const p of pointsOf(buildTraceWindow({ ...v, clock }).path)) {
        expect(p.x).toBeGreaterThanOrEqual(-TRACE_W); // left of the box is clipped
        expect(p.x).toBeLessThanOrEqual(TRACE_W);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(TRACE_H);
      }
    }
  });
});

describe("buildTraceWindow — a view of the clock, never its own time base", () => {
  it("is bit-identical walking the window backwards and forwards", () => {
    // Slice 9d's test, for the same reason: "cumulative" and "recomputable" part company
    // at a backwards seek, and this module must never grow an accumulator that drifts.
    const v = view(lapOf(300));
    const clocks = Array.from({ length: 200 }, (_, i) => i * 1.5);
    const forwards = clocks.map((clock) => buildTraceWindow({ ...v, clock }));
    const backwards = [...clocks]
      .reverse()
      .map((clock) => buildTraceWindow({ ...v, clock }))
      .reverse();
    expect(backwards).toEqual(forwards);
  });

  it("jumps with a seek rather than scrolling to it", () => {
    const v = view(lapOf(300));
    expect(buildTraceWindow({ ...v, clock: 250 }).startS).toBeCloseTo(230, 6);
    expect(buildTraceWindow({ ...v, clock: 30 }).startS).toBeCloseTo(10, 6);
  });
});

describe("buildTraceWindow — impossible data", () => {
  it("throws on no samples rather than rendering a blank box", () => {
    expect(() =>
      buildTraceWindow({
        samples: [],
        sampleRateHz: 10,
        clock: 0,
        duration: 1,
        range: { minKmh: 0, maxKmh: 1 },
        width: TRACE_W,
        height: TRACE_H,
      }),
    ).toThrow(RangeError);
  });

  it.each([0, NaN, Infinity, -5])(
    "draws nothing rather than NaN for a duration of %s",
    (duration) => {
      const w = buildTraceWindow({ ...view(at(1, 2, 3)), duration, clock: 1 });
      expect(w).toEqual({ path: "", playheadX: 0, startS: 0, endS: 0 });
    },
  );

  it.each([0, NaN, -1])(
    "draws nothing rather than NaN for a sample rate of %s",
    (sampleRateHz) => {
      const w = buildTraceWindow({
        ...view(at(1, 2, 3)),
        sampleRateHz,
        clock: 1,
      });
      expect(w.path).toBe("");
    },
  );

  it("clamps a clock outside the replay instead of running off the box", () => {
    const v = view(lapOf(60));
    expect(buildTraceWindow({ ...v, clock: -5 }).playheadX).toBe(0);
    expect(buildTraceWindow({ ...v, clock: 1000 }).playheadX).toBe(
      PLAYHEAD_FRACTION * TRACE_W,
    );
  });
});

describe("TRACE_SECONDS", () => {
  it("never asks the box for more samples than it has pixels", () => {
    /**
     * The defect this slice fixes, as an inequality. The old sparkline put 5792 samples
     * into ~192 CSS px — thirty per pixel — and every braking zone became noise.
     *
     * Pinned at the DRAWING BOX, which is a proxy: `TRACE_W` user units stretch to the
     * sidebar's real width (~192 CSS px at `md:w-56` less `p-4`), so this is the same
     * order, not the same number. The real bar is the human's eye at that width; this
     * exists so the constant cannot drift back into the defect in silence, which is
     * exactly what `TAIL_SECONDS` did until Slice 9b's follow-up pinned it.
     */
    expect(TRACE_SECONDS * RATE).toBeLessThanOrEqual(TRACE_W);
  });

  it("is long enough to hold a braking event and its recovery", () => {
    expect(TRACE_SECONDS).toBeGreaterThanOrEqual(6);
  });
});
