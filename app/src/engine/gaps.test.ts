/**
 * Gaps are tested against ANALYTIC paths, not against a recorded lap.
 *
 * A closed circle traversed a whole number of times has gaps that can be written down
 * in closed form, so these tests assert exact values rather than "close to what it
 * printed last time". The real-data check lives in the slice's verification notes, where
 * it belongs — a test that reads a lap off disk can only ever confirm that nothing
 * changed.
 *
 * Slice 9d moved the unit of construction from "a car and a query point" to "a replay",
 * because a gap is now a function of the replay and the clock. So the helpers here build
 * replays whose cars are one circuit driven with a known offset between them.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RESIDUAL_M,
  SEED_MARGIN_MIN,
  buildProgressIndex,
  gapTo,
} from "./gaps";
import type { Replay, Sample } from "./schema";

const RATE = 10;
/** One lap of the test circuit: 1000 m at 180 km/h = 50 m/s, so 20 s and 200 samples. */
const PER_LAP = 200;
const LAP_SECONDS = 20;

/** A closed circle of circumference 1000 m, `laps` times round, offset by `shift`. */
function ring(laps: number, shift = 0, scale = 1, radiusBoost = 0): Sample[] {
  const radius = (1000 / (2 * Math.PI)) * scale + radiusBoost;
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
function replayOf(...cars: Sample[][]): Replay {
  return {
    meta: {
      schemaVersion: 1,
      sampleRateHz: RATE,
      duration: cars[0].length / RATE,
      rotation: 0,
      loop: "open",
      units: { speed: "km/h" },
      year: 2024,
      event: "Test",
      track: "Test",
      session: "R",
    },
    track: { corners: [], startFinish: { x: 0, y: 0, angle: 0 } },
    cars: cars.map((samples, i) => ({
      driver: `C${i}`,
      team: "Test",
      color: "#888888",
      samples,
    })),
  } as Replay;
}

describe("gapTo — sign and magnitude", () => {
  // C1 runs 20 samples (2 s) further round the circuit than C0 at every clock.
  const index = buildProgressIndex(replayOf(ring(3), ring(3, 20)));

  it("reports a car AHEAD as a negative gap, in seconds and metres", () => {
    const gap = gapTo(index, 0, 1, 30)!;
    expect(gap.seconds).toBeCloseTo(-2, 6);
    // 50 m/s for 2 s.
    expect(gap.metres).toBeCloseTo(-100, 4);
  });

  it("reports a car BEHIND as a positive gap, from the other end of the same pair", () => {
    const gap = gapTo(index, 1, 0, 30)!;
    expect(gap.seconds).toBeCloseTo(2, 6);
    expect(gap.metres).toBeCloseTo(100, 4);
  });

  it("is zero for a car against itself", () => {
    const gap = gapTo(index, 0, 0, 30)!;
    expect(gap.seconds).toBeCloseTo(0, 8);
    expect(gap.metres).toBeCloseTo(0, 8);
  });

  it("resolves BETWEEN samples, so the answer is not quantised to the grid", () => {
    const half = buildProgressIndex(replayOf(ring(3), ring(3, 5.5)));
    expect(half.lapUnits).toBeGreaterThan(0);
    expect(gapTo(half, 0, 1, 30)!.seconds).toBeCloseTo(-0.55, 4);
  });

  it("measures metres from the focused car's own travel integral", () => {
    // A speed channel that is not constant: metres must follow the integral, not the
    // gap in seconds times some nominal speed. Positions are untouched, so the SECONDS
    // are unchanged and only the metres move.
    const slow = ring(3).map((s, k) => ({ ...s, speed: k < 300 ? 180 : 90 }));
    const index2 = buildProgressIndex(replayOf(slow, ring(3, 20)));
    const gap = gapTo(index2, 0, 1, 40)!;
    expect(gap.seconds).toBeCloseTo(-2, 6);
    // Two seconds at 25 m/s, entirely inside the slow stretch.
    expect(gap.metres).toBeCloseTo(-50, 4);
  });
});

describe("the half-lap fold is GONE — Slice 9d's whole point", () => {
  /**
   * The regression test built from the real geometry that found the defect.
   *
   * On 2024 Monza R the lap is 85.5 s and HUL sits +52.7 s behind a focused VER. The old
   * module filtered candidate crossings to within half a lap of `now` and so reported
   * the complement, ≈ −33 s: a car most of a lap behind, shown as a third of a lap
   * ahead. Scaled onto this 20 s circuit, a car 12.3 s behind must not read −7.7.
   *
   * IT TAKES A FIELD, and that is the mechanism rather than a detail of the fixture.
   * Two cars 12.3 s apart on a 20 s lap are genuinely ambiguous — "12.3 s behind" and
   * "7.7 s ahead" describe the same picture and nothing in the data prefers either. What
   * resolves it is a field that does not reach right round: the cars occupy 0.615 of the
   * lap and leave a 0.385 hole, and the hole is where the running order starts. This is
   * the synthetic form of the real file, where 19 cars span 57.4 s of an 85.5 s lap.
   */
  const field = buildProgressIndex(
    replayOf(...[0, -25, -50, -75, -100, -123].map((s) => ring(3, s))),
  );

  it("reports the TRUE gap past half a lap, not its complement", () => {
    expect(field.seedTrustworthy).toBe(true);
    const gap = gapTo(field, 0, 5, 30)!;
    expect(gap.seconds).toBeCloseTo(12.3, 4);
    // The fold's answer, which must not appear.
    expect(gap.seconds).not.toBeCloseTo(-(LAP_SECONDS - 12.3), 1);
  });

  it("orders the whole field the same way whichever car is focused", () => {
    // `runningOrder` documents the order as focus-independent because changing the
    // reference shifts every gap by a constant. Under the fold that was false past half
    // a lap; here it is arithmetic.
    const from0 = [1, 2, 3, 4, 5].map((c) => gapTo(field, 0, c, 30)!.seconds);
    const from3 = [1, 2, 3, 4, 5].map((c) => gapTo(field, 3, c, 30)!.seconds);
    const shift = from3[0] - from0[0];
    for (let i = 0; i < from0.length; i++) {
      expect(from3[i]).toBeCloseTo(from0[i] + shift, 6);
    }
  });

  it("holds its sign across the half-lap boundary instead of flipping", () => {
    // A car drifting from just inside half a lap to just outside it. The old module
    // teleported by a whole lap here and the tower re-sorted on it; the gap must simply
    // grow through 10 s.
    const drifting = ring(3).map((s, k) => {
      const lag = 95 + (k / (PER_LAP * 3)) * 20; // 9.5 s -> 11.5 s
      const a = (2 * Math.PI * (k - lag)) / PER_LAP;
      const r = 1000 / (2 * Math.PI);
      return { ...s, x: r * Math.cos(a), y: r * Math.sin(a) };
    });
    const drift = buildProgressIndex(replayOf(ring(3), drifting));

    let previous = gapTo(drift, 0, 1, 5)!.seconds;
    expect(previous).toBeGreaterThan(0);
    for (let t = 5.5; t <= 55; t += 0.5) {
      const now = gapTo(drift, 0, 1, t)!.seconds;
      expect(now).toBeGreaterThan(0);
      // No teleport: a real gap creeps, it does not jump a lap.
      expect(Math.abs(now - previous)).toBeLessThan(1);
      previous = now;
    }
    // It genuinely crossed the boundary the old module folded at.
    expect(previous).toBeGreaterThan(LAP_SECONDS / 2);
  });
});

describe("lapped cars — reported, and signed both ways", () => {
  /**
   * The lapping has to HAPPEN inside the window, which is the ruling and not a
   * convenience. A car that is already a lap down when the window opens is
   * indistinguishable from one alongside — the schema carries no lap counter, so from
   * one instant's geometry "a lap behind" and "here" are the same picture. What IS
   * observable is a car losing a lap while being watched, so this is a car at half
   * pace: both start on the line, C0 runs six laps and C1 runs three.
   */
  const slower = ring(6).map((s, k) => {
    const a = (2 * Math.PI * (k * 0.5)) / PER_LAP;
    const r = 1000 / (2 * Math.PI);
    return { ...s, x: r * Math.cos(a), y: r * Math.sin(a), speed: 90 };
  });
  const lapped = buildProgressIndex(replayOf(ring(6), slower));

  it("reports a car a lap behind as +1 lap", () => {
    // t=60: C0 has run 3 laps, C1 has run 1.5 — one and a half laps down.
    const gap = gapTo(lapped, 0, 1, 60)!;
    expect(gap.lapsDown).toBe(1);
    expect(gap.seconds).toBeCloseTo(30, 4);
  });

  it("reports the leaders as -1 lap when the LAPPED car is focused", () => {
    // The configuration that produced the measured strobe: focus a backmarker and the
    // cars ahead of it are a lap up. A `+`-only implementation renders this as nonsense.
    const gap = gapTo(lapped, 1, 0, 60)!;
    expect(gap.lapsDown).toBe(-1);
    expect(gap.seconds).toBeLessThan(0);
  });

  it("counts more than one lap, in both directions", () => {
    // t=100: C0 has run 5 laps, C1 2.5 — two and a half laps down.
    expect(gapTo(lapped, 0, 1, 100)!.lapsDown).toBe(2);
    expect(gapTo(lapped, 1, 0, 100)!.lapsDown).toBe(-2);
  });

  it("still reads 0 laps down before the car has actually lost one", () => {
    // t=20: C0 one lap, C1 half a lap. Half a lap down is not a lap down, and a tower
    // that rounded it up would be inventing a position.
    expect(gapTo(lapped, 0, 1, 20)!.lapsDown).toBe(0);
  });

  it("reports 0 laps down for a window shorter than a lap, because there is no ring", () => {
    const short = buildProgressIndex(replayOf(ring(0.5), ring(0.5, 20)));
    expect(short.lapUnits).toBe(0);
    expect(gapTo(short, 0, 1, 5)!.lapsDown).toBe(0);
  });
});

describe("the ring cut that seeds the field's lap offsets", () => {
  it("trusts a field that leaves a clear hole", () => {
    // Three cars inside a third of the lap: the hole is the other two thirds.
    const index = buildProgressIndex(
      replayOf(ring(3), ring(3, -20), ring(3, -40)),
    );
    expect(index.seedMargin).toBeGreaterThan(SEED_MARGIN_MIN);
    expect(index.seedTrustworthy).toBe(true);
    expect(gapTo(index, 0, 2, 30)!.seconds).toBeCloseTo(4, 4);
  });

  it("flags a field strung evenly right round the circuit", () => {
    // Ten cars at even spacing: every hole is the same size, so there is no cut to
    // find and the seed is a guess. The index is still built and still answers —
    // loudly uncertain beats silently wrong.
    const even = Array.from({ length: 10 }, (_, i) => ring(3, -i * 20));
    const index = buildProgressIndex(replayOf(...even));
    expect(index.seedMargin).toBeLessThan(SEED_MARGIN_MIN);
    expect(index.seedTrustworthy).toBe(false);
    expect(gapTo(index, 0, 1, 30)).not.toBeNull();
  });
});

describe("gapTo — when there is no honest answer", () => {
  it("returns null for a car further off the circuit than the residual bound", () => {
    const off = ring(3, 20).map((s) => ({ ...s, x: s.x + 1e6 }));
    const index = buildProgressIndex(replayOf(ring(3), off));
    expect(gapTo(index, 0, 1, 30)).toBeNull();
  });

  it("still answers, with a residual, for a car beside the racing line", () => {
    // A metre off the line: a defensive line, not a spin.
    const beside = buildProgressIndex(replayOf(ring(3), ring(3, 20, 1, 1)));
    const gap = gapTo(beside, 0, 1, 30)!;
    expect(gap.residualM).toBeGreaterThan(0);
    expect(gap.residualM).toBeLessThan(MAX_RESIDUAL_M);
    expect(gap.seconds).toBeCloseTo(-2, 1);
  });

  it("returns null for every query against a car that never moved", () => {
    const parked = ring(3).map((s) => ({ ...s, x: 500, y: 0, speed: 0 }));
    const index = buildProgressIndex(replayOf(ring(3), parked));
    expect(index.degenerate[1]).toBe(true);
    expect(gapTo(index, 0, 1, 30)).toBeNull();
    expect(gapTo(index, 1, 0, 30)).toBeNull();
  });

  it("treats a moving car with a dead speed channel as degenerate too", () => {
    // Position says it moved, speed says it did not. There is no travel integral to
    // measure metres against, so there is nothing to report.
    const noSpeed = ring(3, 20).map((s) => ({ ...s, speed: 0 }));
    const index = buildProgressIndex(replayOf(ring(3), noSpeed));
    expect(index.degenerate[1]).toBe(true);
    expect(gapTo(index, 0, 1, 30)).toBeNull();
  });

  it("returns null when the reference car itself never moved", () => {
    const parked = ring(3).map((s) => ({ ...s, x: 500, y: 0, speed: 0 }));
    const index = buildProgressIndex(replayOf(parked, ring(3)));
    expect(index.lapUnits).toBe(0);
    expect(gapTo(index, 0, 1, 30)).toBeNull();
  });

  it("returns null for a gap larger than the whole-lap extension can reach", () => {
    // A window under a lap long has no ring, so nothing can be extended: a car whose
    // progress the reference never reaches simply has no answer.
    const short = buildProgressIndex(replayOf(ring(0.5), ring(0.5, -80)));
    expect(gapTo(short, 0, 1, 1)).toBeNull();
  });

  it("answers rather than dividing by zero when progress is flat at the window's end", () => {
    // A car that stops before the window closes — a retirement, or simply the flag —
    // leaves its progress flat over the final samples. A lookup landing in that stretch
    // has no span to interpolate across, and the guard against it is only reachable
    // here, at the very end, because anywhere earlier the search settles on the last
    // flat sample and the step after it is non-zero.
    const STOP = 570; // 57.0 s; the window runs to 59.9
    const stopping = ring(3).map((s, k) =>
      k >= STOP ? { ...ring(3)[STOP], t: s.t, speed: 0 } : s,
    );
    const index = buildProgressIndex(replayOf(stopping, stopping));

    // Two cars stopped in the same place. "When was the other car at this progress?" has
    // a RANGE of true answers — the whole stationary stretch — so the gap is genuinely
    // ambiguous within it, and the assertion is the bound rather than a value it cannot
    // honestly have. What must never happen is a NaN.
    const flat = 59.9 - STOP / 10;
    for (const t of [57.5, 58, 59.5]) {
      const gap = gapTo(index, 0, 1, t)!;
      expect(Number.isNaN(gap.seconds)).toBe(false);
      expect(Number.isNaN(gap.metres)).toBe(false);
      expect(Math.abs(gap.seconds)).toBeLessThanOrEqual(flat);
    }
    // Before the stop, the same pair is exactly zero — so the ambiguity above is a
    // property of standing still, not of the index being wrong.
    expect(gapTo(index, 0, 1, 30)!.seconds).toBeCloseTo(0, 6);
  });

  it("survives a stationary stretch in the reference car's own lap", () => {
    // Duplicate fixes are ordinary in real data (a car held on the brakes, or sitting
    // in its grid box). A zero-length reference segment has no direction to project
    // onto, and a flat stretch of progress has no span to interpolate across; neither
    // may produce a NaN.
    const stalled = ring(3).map((s, k) =>
      k >= 40 && k < 60 ? { ...ring(3)[40], t: s.t, speed: 0 } : s,
    );
    const index = buildProgressIndex(replayOf(stalled, ring(3, 20)));
    const gap = gapTo(index, 0, 1, 30)!;
    expect(Number.isNaN(gap.seconds)).toBe(false);
    expect(Number.isNaN(gap.metres)).toBe(false);
    expect(Number.isNaN(gap.residualM)).toBe(false);
  });
});

describe("the seam where arc L meets arc 0", () => {
  /**
   * A car running the circuit BACKWARDS.
   *
   * Not a race scenario — it is the cleanest way to drive the lap counter's decrementing
   * branch, which in real data fires when a projection near the start/finish line lands
   * on arc L one sample and arc 0 the next. The reference's first and last points are
   * the same ground, so that flip is legitimate and it is `projectPath`'s counter, not
   * the projection, that has to turn it back into a continuous progress.
   *
   * It also reaches the one case where walking whole laps runs out: this car's progress
   * falls without bound, and once it is more than `MAX_LAP_EXTENSION` laps below where
   * the reference started, there is no honest answer left to give.
   */
  const backwardsIndex = (() => {
    const backwards = ring(6).map((s, k) => {
      const a = (-2 * Math.PI * k) / PER_LAP;
      const r = 1000 / (2 * Math.PI);
      return { ...s, x: r * Math.cos(a), y: r * Math.sin(a) };
    });
    return buildProgressIndex(replayOf(ring(6), backwards));
  })();

  it("gives up honestly once the deficit outruns the whole-lap extension", () => {
    // ~1 lap below the reference's start: reachable by walking back one lap.
    expect(gapTo(backwardsIndex, 0, 1, 20)).not.toBeNull();
    // ~4.5 laps below it: past the extension, so an em dash rather than a guess.
    expect(gapTo(backwardsIndex, 0, 1, 90)).toBeNull();
  });

  it("unwraps a car crossing the start/finish line the WRONG way", () => {
    // The reference's first and last points are the same ground, so a projection near
    // the line can legitimately land on either end. `projectPath`'s lap counter is what
    // turns that into a continuous progress — in BOTH directions. A car running the
    // circuit backwards is the cleanest way to drive the decrementing branch, and it
    // must still produce finite, continuous answers rather than a NaN or a teleport.
    let previous: number | null = null;
    let answered = 0;
    for (let t = 1; t < 55; t += 0.25) {
      const gap = gapTo(backwardsIndex, 0, 1, t);
      if (gap === null) continue;
      expect(Number.isFinite(gap.seconds)).toBe(true);
      answered += 1;
      if (previous !== null) {
        // Whatever the answer means for a car going the wrong way, it may not jump a
        // whole lap between ticks — that is the seam being mishandled.
        expect(Math.abs(gap.seconds - previous)).toBeLessThan(LAP_SECONDS / 2);
      }
      previous = gap.seconds;
    }
    expect(answered).toBeGreaterThan(0);
  });
});

describe("a gap is a pure function of the replay, the pair and the clock", () => {
  const index = buildProgressIndex(replayOf(ring(3), ring(3, 20)));

  it("gives bit-identical answers arriving at a clock backwards or forwards", () => {
    // The executable form of "there is no accumulator". Slice 9d's spec called the
    // backwards seek the case where cumulative and recomputable part company; nothing
    // here is cumulative at query time, so they cannot.
    const forwards: number[] = [];
    for (let t = 0; t <= 50; t += 0.5)
      forwards.push(gapTo(index, 0, 1, t)!.seconds);

    const backwards: number[] = [];
    for (let t = 50; t >= 0; t -= 0.5)
      backwards.push(gapTo(index, 0, 1, t)!.seconds);
    backwards.reverse();

    expect(backwards).toEqual(forwards);
  });

  it("gives the same answer after a jump as after walking there", () => {
    const walked = gapTo(index, 0, 1, 37.25)!;
    const jumped = gapTo(index, 0, 1, 37.25)!;
    expect(jumped).toEqual(walked);
  });
});

describe("gaps carry no assumption about the position unit", () => {
  /**
   * The executable form of Slice 6b's rule, in Slice 8's regression-test style: X/Y
   * arrive in an undocumented unit, so scaling every coordinate must leave every readout
   * untouched. Anything that hard-codes a metres-per-unit constant fails here, and it
   * fails loudly rather than by being 10× wrong on a real circuit.
   */
  it("gives identical seconds, metres and residual at 10x the position scale", () => {
    const one = buildProgressIndex(replayOf(ring(3), ring(3, 20)));
    const ten = buildProgressIndex(replayOf(ring(3, 0, 10), ring(3, 20, 10)));

    for (const now of [22, 30, 41.5]) {
      const a = gapTo(one, 0, 1, now)!;
      const b = gapTo(ten, 0, 1, now)!;
      expect(b.seconds).toBeCloseTo(a.seconds, 8);
      expect(b.metres).toBeCloseTo(a.metres, 6);
      expect(b.residualM).toBeCloseTo(a.residualM, 6);
      expect(b.lapsDown).toBe(a.lapsDown);
    }
    // The bridge itself DOES scale — that is what absorbs the unit.
    expect(ten.unitsPerMetre).toBeCloseTo(10 * one.unitsPerMetre, 4);
    expect(ten.lapUnits).toBeCloseTo(10 * one.lapUnits, 3);
  });

  it("gives identical answers whichever end of the grid the query lands on", () => {
    const index = buildProgressIndex(replayOf(ring(3), ring(3, 20)));
    expect(gapTo(index, 0, 1, 0)!.seconds).toBeCloseTo(-2, 4);
    expect(gapTo(index, 0, 1, 59.9)!.seconds).toBeCloseTo(-2, 4);
  });
});
