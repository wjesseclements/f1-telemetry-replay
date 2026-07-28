/**
 * Interpolation tests.
 *
 * Everything runs off the committed fixture (585 samples, 10 Hz, span 58.5 s) except
 * the degenerate-geometry and multi-car cases, which need shapes the fixture does not
 * contain and are built as typed `Car` values in-file. No network, ever.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import type { Car, Replay, Sample } from "./schema";
import { gridSpan, sampleAt, sampleCarAt, wrapClock } from "./interpolate";

const replay: Replay = parseReplay(sampleLap, "sample-lap.json");
const car: Car = replay.cars[0];
const samples = car.samples;
const RATE = replay.meta.sampleRateHz; // 10
const N = samples.length; // 585
const SPAN = N / RATE; // 58.5

/** Build a car from bare positions, on a 1 Hz grid. Channels are held constant. */
function carFromPoints(points: readonly [number, number][]): Car {
  const samplesOut: Sample[] = points.map(([x, y], k) => ({
    t: k,
    x,
    y,
    speed: 100,
    throttle: 50,
    brake: 0,
    gear: 4,
  }));
  return { driver: "TST", team: "Test", color: "#3671C6", samples: samplesOut };
}

describe("wrapClock", () => {
  it("leaves a clock already inside the span untouched", () => {
    expect(wrapClock(0, 58.5)).toBe(0);
    expect(wrapClock(20.05, 58.5)).toBeCloseTo(20.05, 9);
  });

  it("folds the end of the span back to zero", () => {
    expect(wrapClock(58.5, 58.5)).toBe(0);
    expect(wrapClock(58.5 + 20.05, 58.5)).toBeCloseTo(20.05, 9);
  });

  it("folds a negative clock forward, not to zero", () => {
    expect(wrapClock(-0.1, 58.5)).toBeCloseTo(58.4, 9);
    expect(wrapClock(-58.5, 58.5)).toBe(0);
    expect(wrapClock(-58.6, 58.5)).toBeCloseTo(58.4, 9);
  });

  it("rejects a span that cannot define a wrap", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => wrapClock(1, bad), `span ${bad}`).toThrow(RangeError);
    }
    expect(() => wrapClock(1, 0)).toThrow(/positive finite span/);
  });
});

describe("gridSpan", () => {
  it("is derived from the sample count, not meta.duration", () => {
    expect(gridSpan(car, RATE)).toBe(SPAN);
    // The fixture keeps the two in agreement; the schema now enforces that.
    expect(replay.meta.duration).toBe(SPAN);
  });

  it("indexes on its own grid when meta.duration disagrees", () => {
    // A car whose grid is shorter than the declared duration wraps on ITS grid:
    // 3 samples at 1 Hz is a 3 s span, so clock 3 is clock 0 again.
    const short = carFromPoints([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    expect(gridSpan(short, 1)).toBe(3);
    expect(sampleCarAt(short, 3, 1).index).toBe(0);
    expect(sampleCarAt(short, 3, 1).x).toBe(0);
  });
});

describe("sampleCarAt — O(1) grid lookup", () => {
  it("lands on index floor(clock * sampleRateHz) without scanning", () => {
    expect(sampleCarAt(car, 0, RATE).index).toBe(0);
    expect(sampleCarAt(car, 20, RATE).index).toBe(200);
    expect(sampleCarAt(car, 20.05, RATE).index).toBe(200);
    expect(sampleCarAt(car, 58.4, RATE).index).toBe(584);
  });

  it("reproduces every raw sample exactly at its own grid point", () => {
    for (let k = 0; k < N; k++) {
      const snap = sampleCarAt(car, k / RATE, RATE);
      expect(snap.index, `index at k=${k}`).toBe(k);
      expect(snap.x, `x at k=${k}`).toBeCloseTo(samples[k].x, 9);
      expect(snap.y, `y at k=${k}`).toBeCloseTo(samples[k].y, 9);
      expect(snap.speed, `speed at k=${k}`).toBeCloseTo(samples[k].speed, 9);
      expect(snap.gear, `gear at k=${k}`).toBe(samples[k].gear);
      expect(snap.brake, `brake at k=${k}`).toBe(samples[k].brake);
      expect(snap.drs, `drs at k=${k}`).toBe(samples[k].drs);
    }
  });

  it("does not depend on the order clocks are asked for", () => {
    // A cursor-based (non-O(1)) implementation would drift when seeking backwards.
    const forward = [0, 10, 20.05, 40, 58.4].map(
      (t) => sampleCarAt(car, t, RATE).x,
    );
    const backward = [58.4, 40, 20.05, 10, 0]
      .map((t) => sampleCarAt(car, t, RATE).x)
      .reverse();
    expect(backward).toEqual(forward);
  });
});

describe("sampleCarAt — continuous channels interpolate", () => {
  // Samples 200/201 straddle a braking point: 323 -> 313 km/h at (664.6, 815.1)
  // -> (659.5, 808.0). Expected values are the hand-computed midpoints.
  it("lerps x, y and speed halfway through a step", () => {
    const snap = sampleCarAt(car, 20.05, RATE);
    expect(snap.x).toBeCloseTo(662.05, 6);
    expect(snap.y).toBeCloseTo(811.55, 6);
    expect(snap.speed).toBeCloseTo(318, 6);
  });

  it("lerps throttle rather than carrying it", () => {
    // Sample 199 is on full throttle, 200 is off it entirely.
    expect(samples[199].throttle).toBe(100);
    expect(samples[200].throttle).toBe(0);
    expect(sampleCarAt(car, 19.95, RATE).throttle).toBeCloseTo(50, 6);
  });

  it("returns speed unrounded — rounding belongs to the HUD", () => {
    // A quarter of the way from 323 km/h to 313 km/h is 320.5.
    const snap = sampleCarAt(car, 20.025, RATE);
    expect(snap.speed).toBeCloseTo(320.5, 6);
    expect(Number.isInteger(snap.speed)).toBe(false);
  });
});

describe("sampleCarAt — discrete channels forward-fill", () => {
  it("holds gear for the whole step and changes in one jump", () => {
    expect(samples[9].gear).toBe(5);
    expect(samples[10].gear).toBe(6);
    expect(sampleCarAt(car, 0.9, RATE).gear).toBe(5);
    expect(sampleCarAt(car, 0.95, RATE).gear).toBe(5); // never 5.5
    expect(sampleCarAt(car, 0.99, RATE).gear).toBe(5);
    expect(sampleCarAt(car, 1.0, RATE).gear).toBe(6);
  });

  it("holds brake across a step where it flips", () => {
    expect(samples[101].brake).toBe(0);
    expect(samples[102].brake).toBe(1);
    expect(sampleCarAt(car, 10.15, RATE).brake).toBe(0);
    expect(sampleCarAt(car, 10.2, RATE).brake).toBe(1);
  });

  it("holds the raw DRS code across a step where it changes", () => {
    expect(samples[12].drs).toBe(0);
    expect(samples[13].drs).toBe(12);
    expect(sampleCarAt(car, 1.25, RATE).drs).toBe(0); // never 6
    expect(sampleCarAt(car, 1.3, RATE).drs).toBe(12);
  });

  it("reports drs as undefined when the replay carries no DRS channel", () => {
    const noDrs = carFromPoints([
      [0, 0],
      [1, 0],
    ]);
    expect(sampleCarAt(noDrs, 0.5, 1).drs).toBeUndefined();
  });
});

describe("sampleCarAt — boundaries and wrap", () => {
  it("treats the end of the span as the start again", () => {
    const start = sampleCarAt(car, 0, RATE);
    const wrapped = sampleCarAt(car, SPAN, RATE);
    expect(wrapped).toEqual(start);
  });

  it("wraps a clock past the end and a clock before zero", () => {
    expect(sampleCarAt(car, SPAN + 20.05, RATE).x).toBeCloseTo(662.05, 6);
    expect(sampleCarAt(car, -0.1, RATE).index).toBe(584);
    expect(sampleCarAt(car, -0.1, RATE).x).toBeCloseTo(samples[584].x, 6);
  });

  it("keeps moving across the final step instead of freezing on the last sample", () => {
    // The lap is closed: sample 584 -> sample 0 is a real segment, not a dead end.
    const snap = sampleCarAt(car, 58.45, RATE);
    expect(snap.index).toBe(584);
    expect(snap.x).toBeCloseTo((samples[584].x + samples[0].x) / 2, 6);
    expect(snap.y).toBeCloseTo((samples[584].y + samples[0].y) / 2, 6);
    expect(snap.speed).toBeCloseTo((samples[584].speed + samples[0].speed) / 2, 6);
    // and it points back toward the start/finish line, not at the last sample.
    expect(snap.heading).toBeCloseTo(0.2532657662, 6);
  });
});

describe("sampleCarAt — heading", () => {
  it("is the atan2 of the segment leaving the leading sample", () => {
    expect(sampleCarAt(car, 20.05, RATE).heading).toBeCloseTo(
      Math.atan2(samples[201].y - samples[200].y, samples[201].x - samples[200].x),
      9,
    );
  });

  it("is measured in world coordinates, before rotation is applied", () => {
    // meta.rotation is -14 deg; the heading must not have absorbed it.
    expect(replay.meta.rotation).toBe(-14);
    const snap = sampleCarAt(car, 0, RATE);
    expect(snap.heading).toBeCloseTo(
      Math.atan2(samples[1].y - samples[0].y, samples[1].x - samples[0].x),
      9,
    );
  });

  it("holds the previous direction of travel when the car is stationary", () => {
    // Heading due north (-pi/2 in screen-y-down world), then two identical points.
    const stalled = carFromPoints([
      [0, 10],
      [0, 0],
      [0, 0],
      [5, 0],
    ]);
    expect(sampleCarAt(stalled, 0.5, 1).heading).toBeCloseTo(-Math.PI / 2, 9);
    // Index 1 -> 2 is zero-length: hold index 0 -> 1 rather than snapping to east.
    expect(sampleCarAt(stalled, 1.5, 1).heading).toBeCloseTo(-Math.PI / 2, 9);
    expect(sampleCarAt(stalled, 1.5, 1).heading).not.toBe(0);
  });

  it("falls back to 0 only when there is no previous direction either", () => {
    // Stationary from the very first sample: nothing has been established yet.
    const parked = carFromPoints([
      [7, 7],
      [7, 7],
      [9, 7],
    ]);
    expect(sampleCarAt(parked, 0.5, 1).heading).toBe(0);
    // Two zero-length segments in a row, mid-array, also bottom out at 0.
    const frozen = carFromPoints([
      [3, 3],
      [3, 3],
      [3, 3],
      [4, 3],
    ]);
    expect(sampleCarAt(frozen, 1.5, 1).heading).toBe(0);
  });
});

describe("sampleAt — every car, no count branching", () => {
  it("returns one snapshot per car for a single-car replay", () => {
    const snaps = sampleAt(replay, 20.05);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].x).toBeCloseTo(662.05, 6);
  });

  it("returns one snapshot per car, in order, for a multi-car replay", () => {
    const second: Car = {
      ...car,
      driver: "LEC",
      color: "#F91536",
      // Shift the whole line by a constant so the two are distinguishable.
      samples: car.samples.map((s) => ({ ...s, x: s.x + 1000 })),
    };
    const multi: Replay = { ...replay, cars: [car, second] };

    const snaps = sampleAt(multi, 20.05);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].x).toBeCloseTo(662.05, 6);
    expect(snaps[1].x).toBeCloseTo(1662.05, 6);
    // Same instant for both — that is the whole point of the shared grid.
    expect(snaps[1].t).toBe(snaps[0].t);
  });

  it("uses meta.sampleRateHz for the lookup", () => {
    const snaps = sampleAt(replay, 20);
    expect(snaps[0].index).toBe(20 * replay.meta.sampleRateHz);
  });
});
