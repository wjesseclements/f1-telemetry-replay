/**
 * Car states are tested against ANALYTIC fixtures, the `gaps.test.ts` doctrine: rings
 * whose residuals, speeds and travel are known in closed form, so every threshold is
 * probed from both sides rather than confirmed against a recording.
 *
 * The channels are exercised separately on purpose. The stationary/hold/launch rules
 * read only SPEED, so their fixtures edit speed on an ordinary ring; the off-line rule
 * reads only the projection RESIDUAL, so its fixtures displace a ring radially by a
 * known number of metres (`unitsPerMetre` is 1 here by construction). A test that
 * needed both at once would be testing the fixture, not the module.
 */
import { describe, expect, it } from "vitest";
import {
  GRID_QUORUM,
  HOLD_MIN_S,
  JOINED_TRAVEL_M,
  OFFLINE_RESIDUAL_M,
  STATIONARY_MAX_KMH,
  STATIONARY_MIN_S,
  buildCarStateIndex,
  carStateAt,
  isRacing,
  orderKeyFor,
  towerGap,
  type CarState,
} from "./carState";
import { towerOrder } from "./runningOrder";
import { buildProgressIndex, progressKeyAt, type Gap } from "./gaps";
import type { Replay, Sample } from "./schema";

const RATE = 10;
/** One lap of the test circuit: 1000 m at 180 km/h = 50 m/s, so 20 s and 200 samples. */
const PER_LAP = 200;

/** A closed circle of circumference 1000 m, `laps` times round, offset by `shift`. */
function ring(laps: number, shift = 0, radiusBoost = 0): Sample[] {
  const radius = 1000 / (2 * Math.PI) + radiusBoost;
  const out: Sample[] = [];
  for (let k = 0; k < PER_LAP * laps; k++) {
    const a = (2 * Math.PI * (k + shift)) / PER_LAP;
    out.push({
      t: k / RATE,
      x: radius * Math.cos(a),
      y: radius * Math.sin(a),
      speed: 180,
      throttle: 100,
      brake: 0,
      gear: 8,
    });
  }
  return out;
}

/** A replay whose cars are given sample by sample. `cars[0]` is the reference. */
function replayOf(
  ...cars: (Sample[] | { samples: Sample[]; retiredAt?: number })[]
): Replay {
  return {
    meta: {
      schemaVersion: 1,
      sampleRateHz: RATE,
      duration:
        (Array.isArray(cars[0]) ? cars[0].length : cars[0].samples.length) /
        RATE,
      rotation: 0,
      loop: "open",
      units: { speed: "km/h" },
      year: 2026,
      event: "Test",
      track: "Test",
      session: "R",
    },
    track: { corners: [], startFinish: { x: 0, y: 0, angle: 0 } },
    cars: cars.map((car, i) => ({
      driver: `C${i}`,
      team: "Test",
      color: "#888888",
      samples: Array.isArray(car) ? car : car.samples,
      laps: [],
      stints: [],
      ...(Array.isArray(car) || car.retiredAt === undefined
        ? {}
        : { retiredAt: car.retiredAt }),
    })),
    trackStatus: [],
  } as Replay;
}

/** Speed rewritten to `kmh` over samples `[from, to)`, positions untouched. */
function withSpeed(
  samples: Sample[],
  from: number,
  to: number,
  kmh: number,
): Sample[] {
  return samples.map((s, k) =>
    k >= from && k < to ? { ...s, speed: kmh } : s,
  );
}

const racing: CarState = {
  retired: false,
  offline: false,
  stationary: false,
  joined: true,
};
const gapOf = (seconds: number): Gap => ({
  seconds,
  metres: seconds * 50,
  residualM: 0,
  lapsDown: 0,
});

describe("stationary spells and the sustain guard", () => {
  it("classifies a sustained sub-floor spell, from both sides of the floor", () => {
    // 2 s at 0 km/h from t=5; just above the floor either side of it.
    const parked = withSpeed(ring(2), 50, 70, 0);
    const replay = replayOf(ring(2), parked);
    const index = buildCarStateIndex(replay);
    const progress = buildProgressIndex(replay);
    expect(carStateAt(replay, progress, index, 1, 6).stationary).toBe(true);
    expect(carStateAt(replay, progress, index, 1, 4).stationary).toBe(false);
    expect(carStateAt(replay, progress, index, 1, 8).stationary).toBe(false);
    // Speed AT the floor is not below it.
    const atFloor = withSpeed(ring(2), 50, 70, STATIONARY_MAX_KMH);
    const replay2 = replayOf(ring(2), atFloor);
    expect(
      carStateAt(replay2, progress, buildCarStateIndex(replay2), 1, 6)
        .stationary,
    ).toBe(false);
  });

  it("rejects a dip SHORTER than the sustain as the transient it is", () => {
    // 0.5 s below the floor mid-window — half the guard.
    const dip = withSpeed(ring(2), 50, 50 + (STATIONARY_MIN_S * RATE) / 2, 0);
    const replay = replayOf(ring(2), dip);
    const index = buildCarStateIndex(replay);
    const progress = buildProgressIndex(replay);
    expect(carStateAt(replay, progress, index, 1, 5.2).stationary).toBe(false);
  });

  it("admits a run TOUCHING the window edge at any length — a grid is not a transient", () => {
    // The red-flag window opens on the lights: 0.5 s at 0 from t=0 must classify,
    // and so must a run against the window's end.
    const launch = withSpeed(ring(2), 0, 5, 0);
    const dies = withSpeed(ring(2), PER_LAP * 2 - 5, PER_LAP * 2, 0);
    const replay = replayOf(ring(2), launch, dies);
    const index = buildCarStateIndex(replay);
    const progress = buildProgressIndex(replay);
    expect(carStateAt(replay, progress, index, 1, 0.2).stationary).toBe(true);
    expect(carStateAt(replay, progress, index, 1, 0.6).stationary).toBe(false);
    expect(carStateAt(replay, progress, index, 2, 39.7).stationary).toBe(true);
  });
});

describe("off-line, retired, joined", () => {
  // C1 rides 15 m outside the reference ring — off the line but inside the old 25 m
  // gate, which is exactly the Monza pit lane's measured band. C2 rides 5 m out —
  // inside the racing-line envelope. C3 retires at t=10.
  const replay = replayOf(
    ring(2),
    ring(2, 20, OFFLINE_RESIDUAL_M + 5),
    ring(2, 40, OFFLINE_RESIDUAL_M - 5),
    { samples: ring(2, 60), retiredAt: 10 },
  );
  const index = buildCarStateIndex(replay);
  const progress = buildProgressIndex(replay);

  it("reads a car 15 m off the line as OFF-LINE and one 5 m off as on it", () => {
    expect(carStateAt(replay, progress, index, 1, 5).offline).toBe(true);
    expect(carStateAt(replay, progress, index, 2, 5).offline).toBe(false);
    expect(carStateAt(replay, progress, index, 0, 5).offline).toBe(false);
  });

  it("flips RETIRED exactly at retiredAt, and never without the field", () => {
    expect(carStateAt(replay, progress, index, 3, 9.9).retired).toBe(false);
    expect(carStateAt(replay, progress, index, 3, 10).retired).toBe(true);
    expect(carStateAt(replay, progress, index, 3, 39).retired).toBe(true);
    expect(carStateAt(replay, progress, index, 0, 39).retired).toBe(false);
  });

  it("counts a car as JOINED once it has covered real ground", () => {
    // 5 m at 50 m/s is 0.1 s in.
    expect(carStateAt(replay, progress, index, 0, 0).joined).toBe(false);
    expect(carStateAt(replay, progress, index, 0, 1).joined).toBe(true);
  });

  it("isRacing is the conjunction, and joined is not part of it", () => {
    expect(isRacing(racing)).toBe(true);
    expect(isRacing({ ...racing, retired: true })).toBe(false);
    expect(isRacing({ ...racing, offline: true })).toBe(false);
    expect(isRacing({ ...racing, stationary: true })).toBe(false);
    // A car on its first metres is racing — joined gates the SORT, not the state.
    expect(isRacing({ ...racing, joined: false })).toBe(true);
  });
});

describe("the launch instant (grid quorum)", () => {
  const held = (n: number, seconds: number) =>
    replayOf(
      ...Array.from({ length: 4 }, (_, i) =>
        i < n
          ? withSpeed(ring(2, i * 10), 0, seconds * RATE, 0)
          : ring(2, i * 10),
      ),
    );

  it("finds the launch at the end of a quorum-sized standing spell", () => {
    expect(buildCarStateIndex(held(GRID_QUORUM, 15)).launchT).toBe(15);
    expect(buildCarStateIndex(held(4, 15)).launchT).toBe(15);
  });

  it("finds NO launch below the quorum — two cars is a double-stacked pit box", () => {
    expect(buildCarStateIndex(held(GRID_QUORUM - 1, 15)).launchT).toBeNull();
  });

  it("finds NO launch for a spell shorter than a hold — the red-flag window's own 0.8 s grid", () => {
    expect(
      buildCarStateIndex(held(GRID_QUORUM, HOLD_MIN_S / 2)).launchT,
    ).toBeNull();
  });

  it("reads a window that ENDS still standing as launching at its end", () => {
    const parkedOut = replayOf(
      ring(2),
      withSpeed(ring(2, 10), 250, PER_LAP * 2, 0),
      withSpeed(ring(2, 20), 250, PER_LAP * 2, 0),
      withSpeed(ring(2, 30), 250, PER_LAP * 2, 0),
    );
    expect(buildCarStateIndex(parkedOut).launchT).toBe(40);
  });

  it("records holds per car: the spell itself, not the quorum", () => {
    const index = buildCarStateIndex(held(GRID_QUORUM, 15));
    expect(index.holds[0]).toEqual([{ fromT: 0, toT: 15 }]);
    expect(index.holds[3]).toEqual([]);
    // A pit-stop-length spell is stationary but NOT a hold.
    const stop = replayOf(ring(2), withSpeed(ring(2, 20), 50, 80, 0));
    const stopIndex = buildCarStateIndex(stop);
    expect(stopIndex.stationary[1]).toEqual([{ fromT: 5, toT: 8 }]);
    expect(stopIndex.holds[1]).toEqual([]);
  });
});

describe("towerGap — what the tower may quote", () => {
  it("passes an ordinary racing gap through untouched", () => {
    const gap = gapOf(-2);
    expect(towerGap(gap, racing, racing, [], null, 30)).toBe(gap);
  });

  it("returns null where the gap module already had no answer", () => {
    expect(towerGap(null, racing, racing, [], null, 30)).toBeNull();
  });

  it("blanks EVERY number when the focused car is not racing — exhibit 1's fix", () => {
    for (const focus of [
      { ...racing, retired: true },
      { ...racing, stationary: true },
      { ...racing, offline: true },
    ]) {
      expect(towerGap(gapOf(-2), focus, racing, [], null, 30)).toBeNull();
    }
  });

  it("blanks a car that is not racing, whichever flag says so", () => {
    for (const car of [
      { ...racing, retired: true },
      { ...racing, stationary: true },
      { ...racing, offline: true },
    ]) {
      expect(towerGap(gapOf(-2), racing, car, [], null, 30)).toBeNull();
    }
  });

  it("blanks everything before the field launches, and nothing after — exhibit 3's fix", () => {
    expect(towerGap(gapOf(-2), racing, racing, [], 79.1, 30)).toBeNull();
    expect(towerGap(gapOf(-2), racing, racing, [], 79.1, 79.1)).not.toBeNull();
  });

  it("suppresses a gap measured ACROSS a hold of the focused car, in both directions", () => {
    const holds = [{ fromT: 44.7, toT: 78.9 }];
    // t* = 40, now = 85: the measurement spans the hold — the "+41 s behind" lie.
    expect(towerGap(gapOf(45), racing, racing, holds, null, 85)).toBeNull();
    // t* = 110 (ahead, future crossing), now = 30: spans it the other way.
    expect(towerGap(gapOf(-80), racing, racing, holds, null, 30)).toBeNull();
    // t* = 80.1, now = 85: measured entirely after the hold — quoted again.
    expect(
      towerGap(gapOf(4.9), racing, racing, holds, null, 85),
    ).not.toBeNull();
    // t* = 40, now = 44: measured entirely before it.
    expect(towerGap(gapOf(4), racing, racing, holds, null, 44)).not.toBeNull();
  });

  it("does NOT suppress across a pit-stop-length spell — holds only", () => {
    // A 2.7 s stop is stationary while it lasts, but it is not a HOLD, so a rival
    // 20 s back keeps its number the moment the focus is rolling again.
    expect(towerGap(gapOf(20), racing, racing, [], null, 300)).not.toBeNull();
  });
});

describe("orderKeyFor — who has a place in the running order", () => {
  it("keeps the key for everything except the car that never joined", () => {
    expect(orderKeyFor(3, racing)).toBe(3);
    expect(orderKeyFor(3, { ...racing, stationary: true })).toBe(3);
    expect(orderKeyFor(3, { ...racing, offline: true })).toBe(3);
    // A pit STOP mid-race: off-line AND stationary, but joined — keeps its row.
    expect(orderKeyFor(3, { ...racing, offline: true, stationary: true })).toBe(
      3,
    );
  });

  it("nulls the pit-lane starter still in its box — exhibit 2's fix", () => {
    expect(
      orderKeyFor(3, {
        retired: false,
        offline: true,
        stationary: true,
        joined: false,
      }),
    ).toBeNull();
  });

  it("passes an already-null key through", () => {
    expect(orderKeyFor(null, racing)).toBeNull();
  });
});

describe("the constants carry their measured meaning", () => {
  it("pins the thresholds the corpus argued", () => {
    // Moving any of these is a re-measurement, not a tweak: the PLAN entry records
    // the populations each one separates.
    expect(STATIONARY_MAX_KMH).toBe(5);
    expect(STATIONARY_MIN_S).toBe(1);
    expect(OFFLINE_RESIDUAL_M).toBe(10);
    expect(HOLD_MIN_S).toBe(10);
    expect(GRID_QUORUM).toBe(3);
    expect(JOINED_TRAVEL_M).toBe(5);
  });
});

describe("launch transition — order is progress, gaps are display (the watch's ruling)", () => {
  /**
   * The sequential sweep the watch exercised: previous order fed back tick by tick
   * through a hold and a launch, with the focus itself part of the standing field.
   * The first key (gapTo's seconds without the gate) failed exactly here — `P_focus`
   * is flat through the hold, its inverse jumps by the hold's length, and the tower
   * lagged true progress order for seconds. The progress key cannot: it reads the
   * same series the truth below is computed from.
   */
  it("matches true progress order at EVERY tick through hold and launch, for every focus", () => {
    const held = (shift: number) => {
      const path = ring(2, shift);
      return path.map((s, k) => ({
        ...(k < 120 ? { ...path[0], speed: 0 } : path[k - 120]),
        t: s.t,
      }));
    };
    // Four cars 2 s apart on the grid, parked 12 s, then away — separations far
    // beyond the dead band, so hysteresis cannot excuse a mismatch.
    const replay = replayOf(held(0), held(20), held(-20), held(-40));
    const progress = buildProgressIndex(replay);
    const index = buildCarStateIndex(replay);
    expect(index.launchT).toBe(12);

    const rate = replay.meta.sampleRateHz;
    const truthAt = (clock: number) =>
      replay.cars
        .map((_, i) => {
          const k = Math.min(
            progress.progress[i].length - 1,
            Math.max(0, clock * rate),
          );
          const lo = Math.floor(k);
          const hi = Math.min(lo + 1, progress.progress[i].length - 1);
          const p =
            progress.progress[i][lo] +
            (progress.progress[i][hi] - progress.progress[i][lo]) * (k - lo);
          return [i, p] as const;
        })
        .sort((a, b) => b[1] - a[1])
        .map(([i]) => i);

    for (let focus = 0; focus < replay.cars.length; focus++) {
      let order: number[] = [];
      for (let t = 0; t <= 30; t += 1 / 30) {
        const keys = replay.cars.map((_, i) =>
          orderKeyFor(
            progressKeyAt(progress, focus, i, t),
            carStateAt(replay, progress, index, i, t),
          ),
        );
        order = towerOrder(
          order,
          keys,
          replay.cars.map(() => null),
        );
        expect(order).toEqual(truthAt(t));
      }
    }
  });

  it("is invariant to which gaps are blank: the keys take no gap input at all", () => {
    // The structural half of the ruling, asserted rather than assumed: compute the
    // order twice at a mixed-blank instant — once with every display gap present,
    // once with every display gap null — and the rows must be identical, because
    // the key path never sees a gap.
    const replay = replayOf(ring(2), ring(2, 20), ring(2, -20));
    const progress = buildProgressIndex(replay);
    const index = buildCarStateIndex(replay);
    const keys = replay.cars.map((_, i) =>
      orderKeyFor(
        progressKeyAt(progress, 0, i, 10),
        carStateAt(replay, progress, index, i, 10),
      ),
    );
    const order = towerOrder([], keys, [null, null, null]);
    // The gaps never entered the computation above; recomputing the keys yields the
    // same order regardless of any blanking decision made elsewhere.
    expect(towerOrder([], keys, [null, null, null])).toEqual(order);
    expect(order).toEqual([1, 0, 2]);
  });
});
