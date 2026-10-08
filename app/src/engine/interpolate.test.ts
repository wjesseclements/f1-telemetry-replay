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
  DEPARTURE_SECONDS,
  gridSpan,
  headingHolds,
  sampleAt,
  sampleCarAt,
  wrapClock,
} from "./interpolate";

const replay: Replay = parseReplay(sampleLap, "sample-lap.json");
const car: Car = replay.cars[0];
const samples = car.samples;
const RATE = replay.meta.sampleRateHz; // 10
/** Built once, as production builds it once per replay (`buildScene`). */
const HOLDS = headingHolds(car, RATE);
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
    expect(
      sampleCarAt(short, 3, 1, "closed", headingHolds(short, 1)).index,
    ).toBe(0);
    expect(sampleCarAt(short, 3, 1, "closed", headingHolds(short, 1)).x).toBe(
      0,
    );
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
      sampleCarAt(noDrs, 0.5, 1, "closed", headingHolds(noDrs, 1)).drs,
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
  const WINDOW_HOLDS = headingHolds(window, 1);

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
    const holds = headingHolds(stalled, 1);
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
    // a grid hold, a pit box, a red-flag park. Northward, six identical samples
    // (five zero-length segments), then away east.
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
    const holds = headingHolds(stopped, 1);
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
    const holds = headingHolds(wreck, 1);
    for (const clock of [2.5, 3.5, 4.5, 5.5]) {
      expect(
        sampleCarAt(wreck, clock, 1, "open", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it("points a car parked from the first sample the way it leaves", () => {
    // Slice 23 follow-up, coordinator ruling. These two cars used to be pinned at 0 —
    // world-east, "nothing established yet" — which is the stopped-car bug in its
    // other case: the red-flag window opens with every car parked, LAW for 7.0 s and
    // ALO for 7.3 s, and their ticks pointed along the replay's x-axis (up to 87° off
    // the way they drove away) for ~3.5 s of wall time at the scenario's 2x, then
    // snapped round when they moved. A car on a grid slot or in a pit box does not
    // reverse: it leaves the way it is facing. On this 1 Hz grid a second of motion is
    // one segment, so "the way it leaves" is simply the first move.
    // (The old points left along +x, where that IS 0 — an assertion that could not
    // tell the ruling from the bug. These leave north and south.)
    const parked = carFromPoints([
      [7, 7],
      [7, 7],
      [7, 2],
    ]);
    expect(
      sampleCarAt(parked, 0.5, 1, "closed", headingHolds(parked, 1)).heading,
    ).toBeCloseTo(-Math.PI / 2, 9);
    // However long that first stop lasts — this was the case the one-step look-back
    // was pinned on, two zero-length segments from sample 0 — and with no snap when
    // the car does move: the held heading IS the one it drives off with.
    const frozen = carFromPoints([
      [3, 3],
      [3, 3],
      [3, 3],
      [3, 7],
    ]);
    const holds = headingHolds(frozen, 1);
    for (const clock of [0.5, 1.5, 2.5]) {
      expect(
        sampleCarAt(frozen, clock, 1, "closed", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it("reads the way it leaves over a second of motion, not off its first quantum", () => {
    // HAM at the red-flag window's start, measured: parked, then one position quantum
    // BACKWARDS, then away up the grid. The ruling as written — the first moving
    // segment — turned his tick round, 175° off, worse than the east it replaced.
    // Read over DEPARTURE_SECONDS of motion instead (here 10 samples at 10 Hz); the
    // path bends gently so that span, and no other, gives this exact angle.
    const RATE_HZ = 10;
    // carFromPoints' `t` is not read here: the grid rate is the argument.
    const ham = carFromPoints([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, -0.1],
      [0, 0.4],
      [0, 1.8],
      [0.1, 3.2],
      [0.2, 5],
      [0.4, 7],
      [0.6, 9],
      [0.9, 11],
      [1.2, 13],
      [1.6, 15],
      [2, 17],
      [2.5, 19],
    ]);
    const first = 2; // segment 2 -> 3, the quantum
    const to = ham.samples[first + DEPARTURE_SECONDS * RATE_HZ];
    const holds = headingHolds(ham, RATE_HZ);
    for (const k of [0, 1]) {
      const heading = sampleCarAt(
        ham,
        (k + 0.5) / RATE_HZ,
        RATE_HZ,
        "open",
        holds,
      ).heading;
      expect(heading, `sample ${k}`).toBeCloseTo(Math.atan2(to.y, to.x), 9);
      // …and nowhere near the quantum's own direction, due -y.
      expect(Math.abs(heading - -Math.PI / 2)).toBeGreaterThan(3);
    }
  });

  it("falls back to the first move when the car is back where it parked a second later", () => {
    // Degenerate, and only reachable by hand: a zero-length chord has no direction
    // either, so the first move — which has one by definition — answers instead.
    // At 2 Hz a second is two samples: 1 -> 3 is (0, 0) -> (0, 0).
    const shuttle = carFromPoints([
      [0, 0],
      [0, 0],
      [0, 5],
      [0, 0],
      [3, 0],
    ]);
    expect(
      sampleCarAt(shuttle, 0.25, 2, "open", headingHolds(shuttle, 2)).heading,
    ).toBeCloseTo(Math.PI / 2, 9);
  });

  it("is 0 — world-east — only for a car that never moves at all", () => {
    // The one case the ruling leaves as it was, pinned: no move anywhere in the
    // replay means no direction exists, behind OR ahead, and any other answer would
    // be invented. 0 is the world x-axis, drawn rotated by `meta.rotation` like every
    // heading (`toScreenHeading`). No car in the five gallery files is like this
    // (measured, Slice 23 follow-up); a car whose feed never started could be.
    const still = carFromPoints([
      [4, 4],
      [4, 4],
      [4, 4],
    ]);
    const holds = headingHolds(still, 1);
    for (const clock of [0.5, 1.5, 2.5]) {
      expect(sampleCarAt(still, clock, 1, "closed", holds).heading).toBe(0);
      expect(sampleCarAt(still, clock, 1, "open", holds).heading).toBe(0);
    }
  });

  it("holds the LAST move after a restart — the look-forward is the leading stop's alone", () => {
    // Parked from sample 0, away south (+y), then west (-x), then parked again. The
    // leading stop takes the way it leaves; the later stop holds the way it arrived,
    // not the first move — "never moved yet" is a fact about the past, not a mode.
    const restarted = carFromPoints([
      [3, 3],
      [3, 3],
      [3, 8],
      [0, 8],
      [0, 8],
    ]);
    const holds = headingHolds(restarted, 1);
    for (const clock of [0.5, 1.5]) {
      expect(
        sampleCarAt(restarted, clock, 1, "open", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(Math.PI / 2, 9);
    }
    for (const clock of [2.5, 3.5, 4.5]) {
      expect(
        sampleCarAt(restarted, clock, 1, "open", holds).heading,
        `clock ${clock}`,
      ).toBeCloseTo(Math.PI, 9);
    }
  });
});

describe("headingHolds — the heading a stopped car shows", () => {
  it("is the last segment that moved, at every sample after the first move", () => {
    // Segments: 0->1 moves +y, 1->2 and 2->3 do not, 3->4 moves -x, 4->5 does not.
    // Sample 0 takes the departure (1 Hz: the first segment) — harmless, as it is
    // only read on a zero-length step and 0->1 is not one.
    const moving = carFromPoints([
      [0, 0],
      [0, 1],
      [0, 1],
      [0, 1],
      [-2, 1],
      [-2, 1],
    ]);
    const Q = Math.PI / 2;
    expect([...headingHolds(moving, 1)]).toEqual([
      Q,
      Q,
      Q,
      Q,
      Math.PI,
      Math.PI,
    ]);
  });

  it("backfills a leading stop with the departure", () => {
    // Segments 0->1 and 1->2 do not move, 2->3 does (+y), 3->4 does not, 4->5 does
    // (+x). Everything up to the first move reads the departure; after it, the last
    // segment that moved.
    const parked = carFromPoints([
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 6],
      [5, 6],
      [9, 6],
    ]);
    const Q = Math.PI / 2;
    expect([...headingHolds(parked, 1)]).toEqual([Q, Q, Q, Q, Q, 0]);
  });

  it("is 0 throughout for a car that never moves", () => {
    const still = carFromPoints([
      [4, 4],
      [4, 4],
      [4, 4],
    ]);
    expect([...headingHolds(still, 1)]).toEqual([0, 0, 0]);
  });

  it("never looks across a closed lap's wrap segment", () => {
    // A closed lap parked at sample 0 takes the way it leaves like any other car —
    // not the wrap segment last -> first, which is the only move "behind" sample 0.
    // Here the two point opposite ways (+y away, -y back round the wrap), so the
    // assertion can see which was used. On real data they agree: a lap's closing
    // chord lies along the line, and a flying lap does not stop on it. One rule —
    // only `k - 1 -> k` segments — then serves both loop modes.
    const lap = carFromPoints([
      [0, 0],
      [0, 0],
      [0, 5],
    ]);
    const Q = Math.PI / 2;
    expect([...headingHolds(lap, 1)]).toEqual([Q, Q, Q]);
    expect(
      sampleCarAt(lap, 0.5, 1, "closed", headingHolds(lap, 1)).heading,
    ).toBeCloseTo(Q, 9);
  });

  it("agrees with the fixture's own segments wherever its car moves", () => {
    // The fixture never stops, so every entry is simply the previous segment's
    // direction, bit for bit — and sample 0 the departure, a second's chord.
    for (let k = 1; k < N; k++) {
      expect(HOLDS[k], `k=${k}`).toBe(
        Math.atan2(
          samples[k].y - samples[k - 1].y,
          samples[k].x - samples[k - 1].x,
        ),
      );
    }
    const to = samples[DEPARTURE_SECONDS * RATE];
    expect(HOLDS[0]).toBe(Math.atan2(to.y - samples[0].y, to.x - samples[0].x));
  });

  it("is rejected when it was built for some other car", () => {
    // A stale index from a previous replay is the mistake this signature invites;
    // the length is the part of it O(1) can see.
    const other = carFromPoints([
      [0, 0],
      [1, 0],
    ]);
    expect(() =>
      sampleCarAt(car, 1, RATE, "closed", headingHolds(other, RATE)),
    ).toThrow(/heading holds cover 2 samples, VER has 585/);
    expect(() => sampleAt(replay, 1, [])).toThrow(RangeError);
    expect(() => sampleAt(replay, 1, [HOLDS, HOLDS])).toThrow(
      /heading holds cover 2 cars, the replay has 1/,
    );
  });

  it("refuses a rate it cannot read a second of motion at — map's index included", () => {
    // `cars.map(headingHolds)` type-checks: map hands its callback (car, INDEX), and
    // the index is a number. Car 0's index is 0, so the guard makes that mistake
    // loud on the first car rather than quietly reading car k's departure over k
    // samples.
    expect(() => replay.cars.map(headingHolds)).toThrow(
      /positive finite sampleRateHz, got 0/,
    );
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => headingHolds(car, bad), `rate ${bad}`).toThrow(RangeError);
    }
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

    const snaps = sampleAt(
      multi,
      20.05,
      multi.cars.map((c) => headingHolds(c, RATE)),
    );
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

    const snaps = sampleAt(
      open,
      58.45,
      open.cars.map((c) => headingHolds(c, RATE)),
    );
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
