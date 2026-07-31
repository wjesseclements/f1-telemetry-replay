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
    expect(sampleCarAt(short, 3, 1, "closed").index).toBe(0);
    expect(sampleCarAt(short, 3, 1, "closed").x).toBe(0);
  });
});

describe("sampleCarAt — O(1) grid lookup", () => {
  it("lands on index floor(clock * sampleRateHz) without scanning", () => {
    expect(sampleCarAt(car, 0, RATE, "closed").index).toBe(0);
    expect(sampleCarAt(car, 20, RATE, "closed").index).toBe(200);
    expect(sampleCarAt(car, 20.05, RATE, "closed").index).toBe(200);
    expect(sampleCarAt(car, 58.4, RATE, "closed").index).toBe(584);
  });

  it("reproduces every raw sample exactly at its own grid point", () => {
    for (let k = 0; k < N; k++) {
      const snap = sampleCarAt(car, k / RATE, RATE, "closed");
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
      (t) => sampleCarAt(car, t, RATE, "closed").x,
    );
    const backward = [58.4, 40, 20.05, 10, 0]
      .map((t) => sampleCarAt(car, t, RATE, "closed").x)
      .reverse();
    expect(backward).toEqual(forward);
  });
});

describe("sampleCarAt — continuous channels interpolate", () => {
  // Samples 200/201 straddle a braking point: 323 -> 313 km/h at (664.6, 815.1)
  // -> (659.5, 808.0). Expected values are the hand-computed midpoints.
  it("lerps x, y and speed halfway through a step", () => {
    const snap = sampleCarAt(car, 20.05, RATE, "closed");
    expect(snap.x).toBeCloseTo(662.05, 6);
    expect(snap.y).toBeCloseTo(811.55, 6);
    expect(snap.speed).toBeCloseTo(318, 6);
  });

  it("lerps throttle rather than carrying it", () => {
    // Sample 199 is on full throttle, 200 is off it entirely.
    expect(samples[199].throttle).toBe(100);
    expect(samples[200].throttle).toBe(0);
    expect(sampleCarAt(car, 19.95, RATE, "closed").throttle).toBeCloseTo(50, 6);
  });

  it("returns speed unrounded — rounding belongs to the HUD", () => {
    // A quarter of the way from 323 km/h to 313 km/h is 320.5.
    const snap = sampleCarAt(car, 20.025, RATE, "closed");
    expect(snap.speed).toBeCloseTo(320.5, 6);
    expect(Number.isInteger(snap.speed)).toBe(false);
  });
});

describe("sampleCarAt — discrete channels forward-fill", () => {
  it("holds gear for the whole step and changes in one jump", () => {
    expect(samples[9].gear).toBe(5);
    expect(samples[10].gear).toBe(6);
    expect(sampleCarAt(car, 0.9, RATE, "closed").gear).toBe(5);
    expect(sampleCarAt(car, 0.95, RATE, "closed").gear).toBe(5); // never 5.5
    expect(sampleCarAt(car, 0.99, RATE, "closed").gear).toBe(5);
    expect(sampleCarAt(car, 1.0, RATE, "closed").gear).toBe(6);
  });

  it("holds brake across a step where it flips", () => {
    expect(samples[101].brake).toBe(0);
    expect(samples[102].brake).toBe(1);
    expect(sampleCarAt(car, 10.15, RATE, "closed").brake).toBe(0);
    expect(sampleCarAt(car, 10.2, RATE, "closed").brake).toBe(1);
  });

  it("holds the raw DRS code across a step where it changes", () => {
    expect(samples[12].drs).toBe(0);
    expect(samples[13].drs).toBe(12);
    expect(sampleCarAt(car, 1.25, RATE, "closed").drs).toBe(0); // never 6
    expect(sampleCarAt(car, 1.3, RATE, "closed").drs).toBe(12);
  });

  it("reports drs as undefined when the replay carries no DRS channel", () => {
    const noDrs = carFromPoints([
      [0, 0],
      [1, 0],
    ]);
    expect(sampleCarAt(noDrs, 0.5, 1, "closed").drs).toBeUndefined();
  });
});

describe("sampleCarAt — boundaries and wrap", () => {
  it("treats the end of the span as the start again", () => {
    const start = sampleCarAt(car, 0, RATE, "closed");
    const wrapped = sampleCarAt(car, SPAN, RATE, "closed");
    expect(wrapped).toEqual(start);
  });

  it("wraps a clock past the end and a clock before zero", () => {
    expect(sampleCarAt(car, SPAN + 20.05, RATE, "closed").x).toBeCloseTo(
      662.05,
      6,
    );
    expect(sampleCarAt(car, -0.1, RATE, "closed").index).toBe(584);
    expect(sampleCarAt(car, -0.1, RATE, "closed").x).toBeCloseTo(
      samples[584].x,
      6,
    );
  });

  it("keeps moving across the final step instead of freezing on the last sample", () => {
    // The lap is closed: sample 584 -> sample 0 is a real segment, not a dead end.
    const snap = sampleCarAt(car, 58.45, RATE, "closed");
    expect(snap.index).toBe(584);
    expect(snap.x).toBeCloseTo((samples[584].x + samples[0].x) / 2, 6);
    expect(snap.y).toBeCloseTo((samples[584].y + samples[0].y) / 2, 6);
    expect(snap.speed).toBeCloseTo(
      (samples[584].speed + samples[0].speed) / 2,
      6,
    );
    // and it points back toward the start/finish line, not at the last sample.
    expect(snap.heading).toBeCloseTo(0.2532657662, 6);
  });
});

describe("sampleCarAt — open replays hold the last sample", () => {
  /**
   * A v2 session-time window: four samples at 1 Hz tracing an L, so the closing
   * chord back to sample 0 is a different direction from the last real segment and
   * the two modes cannot accidentally agree. Speed varies for the same reason.
   */
  const window: Car = {
    driver: "WIN",
    team: "Test",
    color: "#3671C6",
    samples: [
      [0, 0],
      [10, 0],
      [10, 10],
      [10, 20],
    ].map(([x, y], k) => ({
      t: k,
      x,
      y,
      speed: 100 + 10 * k,
      throttle: 50,
      brake: 0 as const,
      gear: 4,
    })),
  };
  /** Heading of the last real segment, (10,10) -> (10,20): due south-in-world. */
  const LAST_SEGMENT_HEADING = Math.PI / 2;

  it("holds position and speed through the final step", () => {
    const held = sampleCarAt(window, 3.5, 1, "open");
    expect(held.index).toBe(3);
    expect(held.x).toBe(10);
    expect(held.y).toBe(20);
    expect(held.speed).toBe(130);
  });

  it("holds the previous direction of travel, not the chord back to the start", () => {
    const held = sampleCarAt(window, 3.5, 1, "open");
    // headingAt already falls back to the previous segment on a zero-length step,
    // which is exactly what a held last sample is.
    expect(held.heading).toBeCloseTo(LAST_SEGMENT_HEADING, 9);
  });

  it("glides across that same step in closed mode — the modes really differ", () => {
    // The negative half of the pair: if `loop` were ignored, this test and the two
    // above cannot both pass.
    const glide = sampleCarAt(window, 3.5, 1, "closed");
    expect(glide.index).toBe(3);
    expect(glide.x).toBe(5); // halfway back to sample 0 at (0, 0)
    expect(glide.y).toBe(10);
    expect(glide.speed).toBe(115); // halfway from 130 back to 100
    expect(glide.heading).toBeCloseTo(Math.atan2(-20, -10), 9);
    expect(glide.heading).not.toBeCloseTo(LAST_SEGMENT_HEADING, 6);
  });

  it("is identical to closed mode everywhere except that final step", () => {
    for (const clock of [0, 0.5, 1, 1.75, 2, 2.99]) {
      expect(sampleCarAt(window, clock, 1, "open"), `clock ${clock}`).toEqual(
        sampleCarAt(window, clock, 1, "closed"),
      );
    }
  });

  it("still wraps the clock, so the window loops as a whole", () => {
    // The cut at the end of a window is the TRANSPORT's, not this function's:
    // `clock.ts` wraps at meta.duration exactly as it does for a lap, and the next
    // frame is sample 0 with no motion drawn across the gap. See the file header.
    expect(sampleCarAt(window, 4, 1, "open")).toEqual(
      sampleCarAt(window, 0, 1, "open"),
    );
    expect(sampleCarAt(window, -0.5, 1, "open").index).toBe(3);
  });
});

describe("sampleCarAt — heading", () => {
  it("is the atan2 of the segment leaving the leading sample", () => {
    expect(sampleCarAt(car, 20.05, RATE, "closed").heading).toBeCloseTo(
      Math.atan2(
        samples[201].y - samples[200].y,
        samples[201].x - samples[200].x,
      ),
      9,
    );
  });

  it("is measured in world coordinates, before rotation is applied", () => {
    // meta.rotation is -14 deg; the heading must not have absorbed it.
    expect(replay.meta.rotation).toBe(-14);
    const snap = sampleCarAt(car, 0, RATE, "closed");
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
    expect(sampleCarAt(stalled, 0.5, 1, "closed").heading).toBeCloseTo(
      -Math.PI / 2,
      9,
    );
    // Index 1 -> 2 is zero-length: hold index 0 -> 1 rather than snapping to east.
    expect(sampleCarAt(stalled, 1.5, 1, "closed").heading).toBeCloseTo(
      -Math.PI / 2,
      9,
    );
    expect(sampleCarAt(stalled, 1.5, 1, "closed").heading).not.toBe(0);
  });

  it("falls back to 0 only when there is no previous direction either", () => {
    // Stationary from the very first sample: nothing has been established yet.
    const parked = carFromPoints([
      [7, 7],
      [7, 7],
      [9, 7],
    ]);
    expect(sampleCarAt(parked, 0.5, 1, "closed").heading).toBe(0);
    // Two zero-length segments in a row, mid-array, also bottom out at 0.
    const frozen = carFromPoints([
      [3, 3],
      [3, 3],
      [3, 3],
      [4, 3],
    ]);
    expect(sampleCarAt(frozen, 1.5, 1, "closed").heading).toBe(0);
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

  it("applies meta.loop to EVERY car, not just the first", () => {
    // A window's cars share one grid, so they share its last step. A per-car
    // default would leave car 2 gliding while car 1 held — the exact desync the
    // shared grid exists to prevent.
    const second: Car = { ...car, driver: "LEC", color: "#F91536" };
    const open: Replay = {
      ...replay,
      meta: { ...replay.meta, loop: "open" },
      cars: [car, second],
    };

    const snaps = sampleAt(open, 58.45);
    expect(snaps).toHaveLength(2);
    for (const [i, snap] of snaps.entries()) {
      expect(snap.index, `car ${i}`).toBe(584);
      expect(snap.x, `car ${i}`).toBe(samples[584].x);
      expect(snap.y, `car ${i}`).toBe(samples[584].y);
    }
    // and the closed reading of the same clock is a different place entirely.
    expect(sampleAt(replay, 58.45)[0].x).not.toBe(samples[584].x);
  });

  it("defaults a replay with no meta.loop to closed", () => {
    // The committed fixture predates the field. Parsing it must still mean "a lap",
    // which is what makes the field additive within schemaVersion 1.
    expect(replay.meta.loop).toBe("closed");
  });
});
