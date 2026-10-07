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
import {
  gridSpan,
  headingHolds,
  sampleAt,
  sampleCarAt,
  wrapClock,
} from "./interpolate";

const replay: Replay = parseReplay(sampleLap, "sample-lap.json");
const car: Car = replay.cars[0];
/** Built once, as production builds it once per replay (`buildScene`). */
const HOLDS = headingHolds(car);
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
  return {
    driver: "TST",
    team: "Test",
    color: "#3671C6",
    samples: samplesOut,
    laps: [],
    stints: [],
    dropouts: [],
  };
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
    expect(sampleCarAt(short, 3, 1, "closed", headingHolds(short)).index).toBe(
      0,
    );
    expect(sampleCarAt(short, 3, 1, "closed", headingHolds(short)).x).toBe(0);
  });
});

describe("sampleCarAt — O(1) grid lookup", () => {
  it("lands on index floor(clock * sampleRateHz) without scanning", () => {
    expect(sampleCarAt(car, 0, RATE, "closed", HOLDS).index).toBe(0);
    expect(sampleCarAt(car, 20, RATE, "closed", HOLDS).index).toBe(200);
    expect(sampleCarAt(car, 20.05, RATE, "closed", HOLDS).index).toBe(200);
    expect(sampleCarAt(car, 58.4, RATE, "closed", HOLDS).index).toBe(584);
  });

  it("reproduces every raw sample exactly at its own grid point", () => {
    for (let k = 0; k < N; k++) {
      const snap = sampleCarAt(car, k / RATE, RATE, "closed", HOLDS);
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
      (t) => sampleCarAt(car, t, RATE, "closed", HOLDS).x,
    );
    const backward = [58.4, 40, 20.05, 10, 0]
      .map((t) => sampleCarAt(car, t, RATE, "closed", HOLDS).x)
      .reverse();
    expect(backward).toEqual(forward);
  });
});

describe("sampleCarAt — continuous channels interpolate", () => {
  // Samples 200/201 straddle a braking point: 323 -> 313 km/h at (664.6, 815.1)
  // -> (659.5, 808.0). Expected values are the hand-computed midpoints.
  it("lerps x, y and speed halfway through a step", () => {
    const snap = sampleCarAt(car, 20.05, RATE, "closed", HOLDS);
    expect(snap.x).toBeCloseTo(662.05, 6);
    expect(snap.y).toBeCloseTo(811.55, 6);
    expect(snap.speed).toBeCloseTo(318, 6);
  });

  it("lerps throttle rather than carrying it", () => {
    // Sample 199 is on full throttle, 200 is off it entirely.
    expect(samples[199].throttle).toBe(100);
    expect(samples[200].throttle).toBe(0);
    expect(sampleCarAt(car, 19.95, RATE, "closed", HOLDS).throttle).toBeCloseTo(
      50,
      6,
    );
  });

  it("returns speed unrounded — rounding belongs to the HUD", () => {
    // A quarter of the way from 323 km/h to 313 km/h is 320.5.
    const snap = sampleCarAt(car, 20.025, RATE, "closed", HOLDS);
    expect(snap.speed).toBeCloseTo(320.5, 6);
    expect(Number.isInteger(snap.speed)).toBe(false);
  });
});

describe("sampleCarAt — discrete channels forward-fill", () => {
  it("holds gear for the whole step and changes in one jump", () => {
    expect(samples[9].gear).toBe(5);
    expect(samples[10].gear).toBe(6);
    expect(sampleCarAt(car, 0.9, RATE, "closed", HOLDS).gear).toBe(5);
    expect(sampleCarAt(car, 0.95, RATE, "closed", HOLDS).gear).toBe(5); // never 5.5
    expect(sampleCarAt(car, 0.99, RATE, "closed", HOLDS).gear).toBe(5);
    expect(sampleCarAt(car, 1.0, RATE, "closed", HOLDS).gear).toBe(6);
  });

  it("holds brake across a step where it flips", () => {
    expect(samples[101].brake).toBe(0);
    expect(samples[102].brake).toBe(1);
    expect(sampleCarAt(car, 10.15, RATE, "closed", HOLDS).brake).toBe(0);
    expect(sampleCarAt(car, 10.2, RATE, "closed", HOLDS).brake).toBe(1);
  });

  it("holds the raw DRS code across a step where it changes", () => {
    expect(samples[12].drs).toBe(0);
    expect(samples[13].drs).toBe(12);
    expect(sampleCarAt(car, 1.25, RATE, "closed", HOLDS).drs).toBe(0); // never 6
    expect(sampleCarAt(car, 1.3, RATE, "closed", HOLDS).drs).toBe(12);
  });

  it("reports drs as undefined when the replay carries no DRS channel", () => {
    const noDrs = carFromPoints([
      [0, 0],
      [1, 0],
    ]);
    expect(
      sampleCarAt(noDrs, 0.5, 1, "closed", headingHolds(noDrs)).drs,
    ).toBeUndefined();
  });
});

describe("sampleCarAt — boundaries and wrap", () => {
  it("treats the end of the span as the start again", () => {
    const start = sampleCarAt(car, 0, RATE, "closed", HOLDS);
    const wrapped = sampleCarAt(car, SPAN, RATE, "closed", HOLDS);
    expect(wrapped).toEqual(start);
  });

  it("wraps a clock past the end and a clock before zero", () => {
    expect(sampleCarAt(car, SPAN + 20.05, RATE, "closed", HOLDS).x).toBeCloseTo(
      662.05,
      6,
    );
    expect(sampleCarAt(car, -0.1, RATE, "closed", HOLDS).index).toBe(584);
    expect(sampleCarAt(car, -0.1, RATE, "closed", HOLDS).x).toBeCloseTo(
      samples[584].x,
      6,
    );
  });

  it("keeps moving across the final step instead of freezing on the last sample", () => {
    // The lap is closed: sample 584 -> sample 0 is a real segment, not a dead end.
    const snap = sampleCarAt(car, 58.45, RATE, "closed", HOLDS);
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
    laps: [],
    stints: [],
    dropouts: [],
  };
  /** Heading of the last real segment, (10,10) -> (10,20): due south-in-world. */
  const LAST_SEGMENT_HEADING = Math.PI / 2;
  const WINDOW_HOLDS = headingHolds(window);

  it("holds position and speed through the final step", () => {
    const held = sampleCarAt(window, 3.5, 1, "open", WINDOW_HOLDS);
    expect(held.index).toBe(3);
    expect(held.x).toBe(10);
    expect(held.y).toBe(20);
    expect(held.speed).toBe(130);
  });

  it("holds the previous direction of travel, not the chord back to the start", () => {
    const held = sampleCarAt(window, 3.5, 1, "open", WINDOW_HOLDS);
    // A held last sample is a zero-length step, and a zero-length step holds the
    // car's last direction of travel — here the segment just before it.
    expect(held.heading).toBeCloseTo(LAST_SEGMENT_HEADING, 9);
  });

  it("glides across that same step in closed mode — the modes really differ", () => {
    // The negative half of the pair: if `loop` were ignored, this test and the two
    // above cannot both pass.
    const glide = sampleCarAt(window, 3.5, 1, "closed", WINDOW_HOLDS);
    expect(glide.index).toBe(3);
    expect(glide.x).toBe(5); // halfway back to sample 0 at (0, 0)
    expect(glide.y).toBe(10);
    expect(glide.speed).toBe(115); // halfway from 130 back to 100
    expect(glide.heading).toBeCloseTo(Math.atan2(-20, -10), 9);
    expect(glide.heading).not.toBeCloseTo(LAST_SEGMENT_HEADING, 6);
  });

  it("is identical to closed mode everywhere except that final step", () => {
    for (const clock of [0, 0.5, 1, 1.75, 2, 2.99]) {
      expect(
        sampleCarAt(window, clock, 1, "open", WINDOW_HOLDS),
        `clock ${clock}`,
      ).toEqual(sampleCarAt(window, clock, 1, "closed", WINDOW_HOLDS));
    }
  });

  it("still wraps the clock, so the window loops as a whole", () => {
    // The cut at the end of a window is the TRANSPORT's, not this function's:
    // `clock.ts` wraps at meta.duration exactly as it does for a lap, and the next
    // frame is sample 0 with no motion drawn across the gap. See the file header.
    expect(sampleCarAt(window, 4, 1, "open", WINDOW_HOLDS)).toEqual(
      sampleCarAt(window, 0, 1, "open", WINDOW_HOLDS),
    );
    expect(sampleCarAt(window, -0.5, 1, "open", WINDOW_HOLDS).index).toBe(3);
  });
});

describe("sampleCarAt — heading", () => {
  it("is the atan2 of the segment leaving the leading sample", () => {
    expect(sampleCarAt(car, 20.05, RATE, "closed", HOLDS).heading).toBeCloseTo(
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
    const snap = sampleCarAt(car, 0, RATE, "closed", HOLDS);
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
    const holds = headingHolds(stalled);
    expect(sampleCarAt(stalled, 0.5, 1, "closed", holds).heading).toBeCloseTo(
      -Math.PI / 2,
      9,
    );
    // Index 1 -> 2 is zero-length: hold index 0 -> 1 rather than snapping to east.
    expect(sampleCarAt(stalled, 1.5, 1, "closed", holds).heading).toBeCloseTo(
      -Math.PI / 2,
      9,
    );
    expect(sampleCarAt(stalled, 1.5, 1, "closed", holds).heading).not.toBe(0);
  });

  it("holds the direction of travel for a stop of ANY length, not one step", () => {
    // Slice 23: the hold used to look back exactly one segment, so it covered a stop
    // one grid step long and nothing longer — from the second stationary step on,
    // atan2(0, 0) pointed the tick due east. Every real stop is longer than 0.1 s:
    // a grid hold, a pit box, a red-flag park. Northward, five identical samples,
    // then away east.
    const stopped = carFromPoints([
      [0, 20],
      [0, 10],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [5, 0],
    ]);
    const holds = headingHolds(stopped);
    // Samples 2..7 are one position: segments 2->3 .. 6->7 have no length.
    for (const clock of [2.5, 3, 3.5, 4.5, 5.5, 6.5]) {
      expect(
        sampleCarAt(stopped, clock, 1, "closed", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(-Math.PI / 2, 9);
    }
    // …and the stop ends where the car really turns: 7 -> 8 is due east.
    expect(sampleCarAt(stopped, 7.5, 1, "closed", holds).heading).toBe(0);
  });

  it("holds it through an open window's held last step after a long park", () => {
    // LEC's wreck in the red-flag scenario: parked for the final two minutes of an
    // open window, so the stop runs straight into the held last sample. Travelling
    // +y (pi/2), then four identical samples to the end of the window.
    const wreck = carFromPoints([
      [0, 0],
      [10, 0],
      [10, 10],
      [10, 10],
      [10, 10],
      [10, 10],
    ]);
    const holds = headingHolds(wreck);
    for (const clock of [2.5, 3.5, 4.5, 5.5]) {
      expect(
        sampleCarAt(wreck, clock, 1, "open", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it("falls back to 0 only when there is no previous direction either", () => {
    // Stationary from the very first sample: nothing has been established yet.
    const parked = carFromPoints([
      [7, 7],
      [7, 7],
      [9, 7],
    ]);
    expect(
      sampleCarAt(parked, 0.5, 1, "closed", headingHolds(parked)).heading,
    ).toBe(0);
    // However long that first stop lasts: two zero-length segments from sample 0
    // still have no direction to hold. (This is the case the one-step look-back
    // was pinned on — it never saw a car that moved BEFORE stopping.)
    const frozen = carFromPoints([
      [3, 3],
      [3, 3],
      [3, 3],
      [4, 3],
    ]);
    expect(
      sampleCarAt(frozen, 1.5, 1, "closed", headingHolds(frozen)).heading,
    ).toBe(0);
  });

  it("starts holding at the first move, even after starting stationary", () => {
    // Parked from sample 0 (0, world-east), away south (+y), then parked again: the
    // second stop holds +y — "never moved" is a fact about the past, not a mode.
    const restarted = carFromPoints([
      [3, 3],
      [3, 3],
      [3, 8],
      [3, 8],
      [3, 8],
    ]);
    const holds = headingHolds(restarted);
    expect(sampleCarAt(restarted, 0.5, 1, "open", holds).heading).toBe(0);
    for (const clock of [2.5, 3.5, 4.5]) {
      expect(
        sampleCarAt(restarted, clock, 1, "open", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(Math.PI / 2, 9);
    }
  });
});

describe("headingHolds — where a stopped car's heading comes from", () => {
  it("names the last segment that moved, ending at or before each sample", () => {
    // Segments: 0->1 moves, 1->2 and 2->3 do not, 3->4 moves, 4->5 does not.
    const moving = carFromPoints([
      [0, 0],
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 2],
      [1, 2],
    ]);
    expect([...headingHolds(moving)]).toEqual([-1, 0, 0, 0, 3, 3]);
  });

  it("is -1 throughout for a car that never moves", () => {
    const still = carFromPoints([
      [4, 4],
      [4, 4],
      [4, 4],
    ]);
    expect([...headingHolds(still)]).toEqual([-1, -1, -1]);
  });

  it("never looks across a closed lap's wrap segment", () => {
    // The last -> first segment moves, but sample 0 still has nothing to hold.
    const lap = carFromPoints([
      [0, 0],
      [0, 0],
      [5, 0],
    ]);
    expect(headingHolds(lap)[0]).toBe(-1);
    expect(sampleCarAt(lap, 0.5, 1, "closed", headingHolds(lap)).heading).toBe(
      0,
    );
  });

  it("agrees with the fixture's own segments wherever its car moves", () => {
    // The fixture never stops, so every entry is simply the previous segment.
    for (let k = 1; k < N; k++) expect(HOLDS[k], `k=${k}`).toBe(k - 1);
    expect(HOLDS[0]).toBe(-1);
  });

  it("is rejected when it was built for some other car", () => {
    // A stale index from a previous replay is the mistake this signature invites;
    // the length is the part of it O(1) can see.
    const other = carFromPoints([
      [0, 0],
      [1, 0],
    ]);
    expect(() =>
      sampleCarAt(car, 1, RATE, "closed", headingHolds(other)),
    ).toThrow(/heading holds cover 2 samples, VER has 585/);
    expect(() => sampleAt(replay, 1, [])).toThrow(RangeError);
    expect(() => sampleAt(replay, 1, [HOLDS, HOLDS])).toThrow(
      /heading holds cover 2 cars, the replay has 1/,
    );
  });
});

describe("sampleAt — every car, no count branching", () => {
  it("returns one snapshot per car for a single-car replay", () => {
    const snaps = sampleAt(replay, 20.05, [HOLDS]);
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

    const snaps = sampleAt(multi, 20.05, multi.cars.map(headingHolds));
    expect(snaps).toHaveLength(2);
    expect(snaps[0].x).toBeCloseTo(662.05, 6);
    expect(snaps[1].x).toBeCloseTo(1662.05, 6);
    // Same instant for both — that is the whole point of the shared grid.
    expect(snaps[1].t).toBe(snaps[0].t);
  });

  it("uses meta.sampleRateHz for the lookup", () => {
    const snaps = sampleAt(replay, 20, [HOLDS]);
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

    const snaps = sampleAt(open, 58.45, open.cars.map(headingHolds));
    expect(snaps).toHaveLength(2);
    for (const [i, snap] of snaps.entries()) {
      expect(snap.index, `car ${i}`).toBe(584);
      expect(snap.x, `car ${i}`).toBe(samples[584].x);
      expect(snap.y, `car ${i}`).toBe(samples[584].y);
    }
    // and the closed reading of the same clock is a different place entirely.
    expect(sampleAt(replay, 58.45, [HOLDS])[0].x).not.toBe(samples[584].x);
  });

  it("defaults a replay with no meta.loop to closed", () => {
    // The committed fixture predates the field. Parsing it must still mean "a lap",
    // which is what makes the field additive within schemaVersion 1.
    expect(replay.meta.loop).toBe("closed");
  });
});
