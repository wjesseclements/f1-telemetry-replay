/**
 * Gaps are tested against ANALYTIC paths, not against a recorded lap.
 *
 * A straight line at a constant speed and a circle traversed a whole number of times
 * both have gaps that can be written down in closed form, so these tests assert exact
 * values rather than "close to what it printed last time". The real-data check lives
 * in the slice's verification notes, where it belongs — a test that reads a lap off
 * disk can only ever confirm that nothing changed.
 */
import { describe, expect, it } from "vitest";
import { MAX_RESIDUAL_M, buildPathIndex, gapTo } from "./gaps";
import type { Car, Sample } from "./schema";

const RATE = 10;

/** A car whose path and speed channel are given point by point. */
function carOf(points: readonly [number, number][], speedKmh: number[]): Car {
  const samples: Sample[] = points.map(([x, y], k) => ({
    t: k / RATE,
    x,
    y,
    speed: speedKmh[k],
    throttle: 100,
    brake: 0,
    gear: 8,
  }));
  return { driver: "REF", team: "Test", color: "#888888", samples };
}

/**
 * A straight run east at a constant 360 km/h — 100 m/s, so at 10 Hz each step is 10 m
 * and one position unit is exactly one metre. Chosen so that expected metres can be
 * read off by inspection.
 */
function straight(steps = 100, scale = 1): Car {
  const points: [number, number][] = [];
  for (let k = 0; k < steps; k++) points.push([k * 10 * scale, 0]);
  return carOf(
    points,
    Array.from({ length: steps }, () => 360),
  );
}

/**
 * A closed circle of circumference 1000 m at 180 km/h — one lap every 20 s, 200
 * samples per lap. `laps` of it makes a path that passes every point repeatedly,
 * which is the case a session-time window presents and the reason `lapPeriod` exists.
 */
function circuit(laps: number, scale = 1): Car {
  const perLap = 200;
  const radius = (1000 / (2 * Math.PI)) * scale;
  const points: [number, number][] = [];
  for (let k = 0; k < perLap * laps; k++) {
    const a = (2 * Math.PI * k) / perLap;
    points.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return carOf(
    points,
    Array.from({ length: perLap * laps }, () => 180),
  );
}

describe("gapTo — sign and magnitude", () => {
  const index = buildPathIndex(straight(), RATE);

  it("reports a car BEHIND as a positive gap, in seconds and metres", () => {
    // The focused car is at x=500 at t=5; it was at x=300 at t=3.
    const gap = gapTo(index, 300, 0, 5);
    expect(gap).not.toBeNull();
    expect(gap!.seconds).toBeCloseTo(2, 10);
    // 100 m/s for 2 s.
    expect(gap!.metres).toBeCloseTo(200, 8);
  });

  it("reports a car AHEAD as a negative gap", () => {
    const gap = gapTo(index, 700, 0, 5);
    expect(gap!.seconds).toBeCloseTo(-2, 10);
    expect(gap!.metres).toBeCloseTo(-200, 8);
  });

  it("is zero for a car exactly where the focused car is", () => {
    const gap = gapTo(index, 500, 0, 5);
    expect(gap!.seconds).toBeCloseTo(0, 10);
    expect(gap!.metres).toBeCloseTo(0, 8);
  });

  it("resolves BETWEEN samples, so the answer is not quantised to the grid", () => {
    // x=355 is 55 % of the way along the step leaving sample 35.
    const gap = gapTo(index, 355, 0, 5);
    expect(gap!.seconds).toBeCloseTo(5 - 3.55, 10);
  });

  it("measures metres from the focused car's own travel integral", () => {
    // A speed channel that is not constant: metres must follow the integral, not the
    // gap in seconds times some nominal speed.
    const speeds = Array.from({ length: 100 }, (_, k) => (k < 50 ? 360 : 180));
    const points: [number, number][] = [];
    for (let k = 0; k < 100; k++) points.push([k * 10, 0]);
    const slowing = buildPathIndex(carOf(points, speeds), RATE);

    // Between t=4 (sample 40) and t=6 (sample 60): nine steps at 100 m/s = 90 m, one
    // step across the discontinuity that the trapezoid averages to 75 m/s = 7.5 m,
    // then ten steps at 50 m/s = 50 m. 147.5, not the 150 a step change would give —
    // the integral is the pipeline's own (Slice 6b), so the 2.5 m is where the two
    // definitions of "when the speed changed" differ, and it belongs to the integral.
    const gap = gapTo(slowing, 400, 0, 6);
    expect(gap!.seconds).toBeCloseTo(2, 10);
    expect(gap!.metres).toBeCloseTo(147.5, 6);
  });
});

describe("gapTo — a window that passes the same ground repeatedly", () => {
  const index = buildPathIndex(circuit(3), RATE);

  it("measures the lap period from the path itself", () => {
    // Just UNDER a lap, systematically: the return is timed from where the path first
    // comes back within the same-spot bound, which at 50 m/s is 25 m — half a second
    // — early. It is used only as a half-width, and erring narrow is the safe way to
    // be wrong, so the assertion is "one lap, definitely not two" rather than 20.000.
    expect(index.lapPeriod).toBeGreaterThan(19);
    expect(index.lapPeriod).toBeLessThan(20.01);
  });

  it("picks the NEAREST crossing, not the first one in the data", () => {
    // Sample 300 is t=30 on lap 2; the same point was passed at t=10 and t=50.
    const at = index.xs[300];
    const gap = gapTo(index, at, index.ys[300], 32);
    expect(gap!.seconds).toBeCloseTo(2, 6);
  });

  it("picks the nearest crossing when that one is AHEAD", () => {
    const gap = gapTo(index, index.xs[300], index.ys[300], 28);
    expect(gap!.seconds).toBeCloseTo(-2, 6);
  });

  it("returns null past half a lap, rather than reporting the next lap's pass", () => {
    // At t=59.9 (the last sample) a car 2 s up the road sits where the focused car
    // will be at 61.9 — beyond the data. Its previous pass, at 41.9, is 18 s away:
    // more than half a lap, so it is not the same question.
    const gap = gapTo(index, index.xs[419], index.ys[419], 59.9);
    expect(gap).toBeNull();
  });
});

describe("the lap period is the SOONEST return, not the nearest point", () => {
  /**
   * The regression test for a defect real data found and synthetic data had hidden.
   *
   * A perfect circle passes every point at exactly zero distance on every lap, so
   * "the closest other point on the path" is a tie and the answer depends on which
   * candidate the grid happened to yield first. Real laps are not ties: they vary by
   * a metre or two, and on 2024 Monza R the two-laps-later pass was closer than the
   * one-lap-later pass often enough that NOR's lap period came back as 167 s. That
   * doubled `gapTo`'s search window, and LEC — a second behind — was reported at
   * −82.80 s, the next lap's crossing, on roughly half the samples.
   *
   * So this circuit is deliberately not a tie: lap 1 runs five metres wide, which
   * makes lap 2 the SPATIALLY nearest return from lap 0 while lap 1 is still the
   * soonest.
   */
  function wideMiddleLap(): Car {
    const perLap = 200;
    const points: [number, number][] = [];
    for (let k = 0; k < perLap * 3; k++) {
      const lap = Math.floor(k / perLap);
      const radius = 1000 / (2 * Math.PI) + (lap === 1 ? 5 : 0);
      const a = (2 * Math.PI * (k % perLap)) / perLap;
      points.push([radius * Math.cos(a), radius * Math.sin(a)]);
    }
    return carOf(
      points,
      Array.from({ length: perLap * 3 }, () => 180),
    );
  }

  const index = buildPathIndex(wideMiddleLap(), RATE);

  it("measures one lap, not two, when a later lap runs closer to the line", () => {
    // Slightly UNDER a lap, always: the earliest point of the next pass that is
    // within the residual bound is reached a little before the same angle, and a
    // narrow window is the safe direction to be wrong in. What matters is that it is
    // one lap and not the two the nearest-point rule returned.
    expect(index.lapPeriod).toBeGreaterThan(19);
    expect(index.lapPeriod).toBeLessThan(20.01);
  });

  it("therefore answers with this lap's crossing, not the next one", () => {
    // Sample 300 is on lap 1 at t=30. A car sitting there at t=32 is 2 s behind —
    // not 18 s ahead of the lap-2 pass, which is what an over-wide window reports.
    const gap = gapTo(index, index.xs[300], index.ys[300], 32);
    expect(gap!.seconds).toBeCloseTo(2, 1);
  });
});

describe("gapTo — when there is no honest answer", () => {
  it("returns null for a point further off the path than the residual bound", () => {
    const index = buildPathIndex(straight(), RATE);
    expect(gapTo(index, 300, MAX_RESIDUAL_M + 1, 5)).toBeNull();
  });

  it("still answers, with a residual, for a point beside the path", () => {
    const index = buildPathIndex(straight(), RATE);
    const gap = gapTo(index, 300, MAX_RESIDUAL_M - 5, 5);
    expect(gap!.residualM).toBeCloseTo(MAX_RESIDUAL_M - 5, 6);
    expect(gap!.seconds).toBeCloseTo(2, 6);
  });

  it("returns null for every query against a car that never moved", () => {
    const parked = carOf(
      Array.from({ length: 40 }, () => [10, 10] as [number, number]),
      Array.from({ length: 40 }, () => 0),
    );
    const index = buildPathIndex(parked, RATE);
    expect(index.degenerate).toBe(true);
    expect(index.lapPeriod).toBe(Infinity);
    expect(gapTo(index, 10, 10, 2)).toBeNull();
  });

  it("treats a moving car with a dead speed channel as degenerate too", () => {
    // Position says it moved, speed says it did not. There is no travel integral to
    // measure metres against, so there is nothing to report.
    const points: [number, number][] = [];
    for (let k = 0; k < 40; k++) points.push([k * 10, 0]);
    const index = buildPathIndex(
      carOf(
        points,
        Array.from({ length: 40 }, () => 0),
      ),
      RATE,
    );
    expect(index.degenerate).toBe(true);
    expect(gapTo(index, 100, 0, 2)).toBeNull();
  });

  it("reports Infinity for a path that never revisits itself", () => {
    expect(buildPathIndex(straight(), RATE).lapPeriod).toBe(Infinity);
  });

  it("survives a stationary stretch inside a moving path", () => {
    // Duplicate fixes are ordinary in real data (a car held on the brakes). The
    // zero-length segment has no direction to project onto and must not produce NaN.
    const points: [number, number][] = [];
    for (let k = 0; k < 60; k++) points.push([k < 30 ? k * 10 : 290, 0]);
    const speeds = Array.from({ length: 60 }, (_, k) => (k < 30 ? 360 : 0));
    const index = buildPathIndex(carOf(points, speeds), RATE);
    const gap = gapTo(index, 100, 0, 2);
    expect(gap!.seconds).toBeCloseTo(1, 6);
    expect(Number.isNaN(gap!.metres)).toBe(false);
  });
});

describe("gaps carry no assumption about the position unit", () => {
  /**
   * The executable form of Slice 6b's rule, in Slice 8's regression-test style: X/Y
   * arrive in an undocumented unit, so scaling every coordinate must leave both
   * readouts untouched. Anything that hard-codes a metres-per-unit constant fails
   * here, and it fails loudly rather than by being 10× wrong on a real circuit.
   */
  it("gives identical seconds, metres and residual at 10x the position scale", () => {
    const one = buildPathIndex(circuit(3), RATE);
    const ten = buildPathIndex(circuit(3, 10), RATE);

    for (const now of [22, 30, 41.5]) {
      const a = gapTo(one, one.xs[300], one.ys[300], now)!;
      const b = gapTo(ten, ten.xs[300], ten.ys[300], now)!;
      expect(b.seconds).toBeCloseTo(a.seconds, 10);
      expect(b.metres).toBeCloseTo(a.metres, 8);
      expect(b.residualM).toBeCloseTo(a.residualM, 8);
    }
    expect(ten.lapPeriod).toBeCloseTo(one.lapPeriod, 10);
    // The bridge itself DOES scale — that is what absorbs the unit.
    expect(ten.unitsPerMetre).toBeCloseTo(10 * one.unitsPerMetre, 6);
  });

  it("gives identical answers whichever end of the grid the query lands on", () => {
    const index = buildPathIndex(straight(), RATE);
    // The last sample: the travel lookup has to clamp rather than read past the end.
    const last = gapTo(index, 990, 0, 9.9);
    expect(last!.seconds).toBeCloseTo(0, 10);
    expect(gapTo(index, 0, 0, 0)!.seconds).toBeCloseTo(0, 10);
  });
});
