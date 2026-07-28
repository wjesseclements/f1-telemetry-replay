/**
 * Loader + schema tests.
 *
 * `sample-lap.json` was generated once from the prototype's synthetic telemetry
 * generator (prototype/TelemetryReplay.jsx, `useSyntheticReplay`) ported to a
 * throwaway Node script at 10 Hz — the script is dev material and deliberately not
 * committed (PLAN.md Slice 2). Rejection cases below are structural mutations of that
 * one fixture, so these tests never touch the network and never need a second file.
 *
 * If you ever regenerate it: the prototype's `SCALE = 46` is inconsistent with its own
 * "lap ~4.6km" comment — it yields a 16.7 km circuit whose curvature is so low the car
 * sits pinned at 299-338 km/h with zero corners. The fixture was generated with
 * SCALE = 12.7 (a 4.62 km lap), which is what gives it braking zones, a 157-338 km/h
 * range, gears 4-8 and 9 corners. Geometry is unchanged: scale is uniform.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay, ReplayValidationError } from "./load";
import { GRID_TOLERANCE_S, SCHEMA_VERSION } from "./schema";

/** A mutable deep copy of the fixture, typed loosely so tests can break it on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutations are deliberately invalid; that is the point of these tests
type Mutable = any;
const clone = (): Mutable => structuredClone(sampleLap) as Mutable;

/** Parse and return the error, asserting that parsing did fail. */
function expectRejection(bad: unknown, source?: string): ReplayValidationError {
  let thrown: unknown;
  try {
    parseReplay(bad, source);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected parseReplay to throw").toBeInstanceOf(
    ReplayValidationError,
  );
  return thrown as ReplayValidationError;
}

describe("parseReplay — acceptance", () => {
  it("accepts the committed fixture and returns typed data", () => {
    const replay = parseReplay(sampleLap, "sample-lap.json");

    expect(replay.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(replay.meta.sampleRateHz).toBe(10);
    expect(replay.meta.units.speed).toBe("km/h");
    expect(replay.cars).toHaveLength(1);
    expect(replay.cars[0].driver).toBe("VER");
    expect(replay.cars[0].samples.length).toBeGreaterThan(100);
  });

  it("keeps the fixture on a uniform time grid matching sampleRateHz", () => {
    const { meta, cars } = parseReplay(sampleLap);
    const { samples } = cars[0];

    expect(samples).toHaveLength(Math.round(meta.duration * meta.sampleRateHz));
    // O(1) lookup (rule 3) is only valid if index == t * sampleRateHz holds exactly.
    for (const i of [0, 1, 42, samples.length - 1]) {
      expect(samples[i].t).toBeCloseTo(i / meta.sampleRateHz, 6);
    }
  });

  it("accepts a replay with no drs channel at all (2026+ data)", () => {
    const bad = clone();
    for (const s of bad.cars[0].samples) delete s.drs;

    const replay = parseReplay(bad);
    expect(replay.cars[0].samples.every((s) => s.drs === undefined)).toBe(true);
  });

  it("strips unknown keys instead of rejecting them (additive pipeline changes)", () => {
    const extra = clone();
    extra.cars[0].samples[0].rpm = 11500;

    const replay = parseReplay(extra);
    expect(replay.cars[0].samples[0]).not.toHaveProperty("rpm");
  });
});

describe("parseReplay — rejection", () => {
  it("rejects a missing core kinematics field, naming the sample path", () => {
    const bad = clone();
    delete bad.cars[0].samples[3].speed;

    const err = expectRejection(bad, "sample-lap.json");
    expect(err.message).toContain("Invalid replay data in sample-lap.json");
    expect(err.message).toContain("cars[0].samples[3].speed");
    expect(err.issues[0].path).toEqual(["cars", 0, "samples", 3, "speed"]);
  });

  it("rejects a wrong-typed field", () => {
    const bad = clone();
    bad.cars[0].samples[5].gear = "7";

    const err = expectRejection(bad);
    expect(err.message).toContain("cars[0].samples[5].gear");
    expect(err.message).toMatch(/expected number/i);
  });

  it("rejects an empty cars array", () => {
    const bad = clone();
    bad.cars = [];

    const err = expectRejection(bad);
    expect(err.message).toContain("replay.cars must contain at least one car");
  });

  it("rejects a non-km/h speed unit", () => {
    const bad = clone();
    bad.meta.units.speed = "mph";

    const err = expectRejection(bad);
    expect(err.message).toContain("calibrated in km/h");
    expect(err.issues[0].path).toEqual(["meta", "units", "speed"]);
  });

  it("rejects a schemaVersion the app was not built for", () => {
    const bad = clone();
    bad.meta.schemaVersion = 2;

    const err = expectRejection(bad);
    expect(err.message).toContain("schemaVersion must be 1");
    expect(err.issues[0].path).toEqual(["meta", "schemaVersion"]);
  });

  it("rejects non-monotonic sample times", () => {
    const bad = clone();
    const s = bad.cars[0].samples;
    [s[10].t, s[11].t] = [s[11].t, s[10].t];

    const err = expectRejection(bad);
    expect(err.message).toContain("strictly increasing in t");
    expect(err.issues[0].path).toEqual(["cars", 0, "samples", 11, "t"]);
  });

  it("rejects duplicate sample times", () => {
    const bad = clone();
    bad.cars[0].samples[11].t = bad.cars[0].samples[10].t;

    const err = expectRejection(bad);
    expect(err.message).toContain("strictly increasing in t");
  });

  it("rejects a partially present drs channel", () => {
    const bad = clone();
    delete bad.cars[0].samples[7].drs;

    const err = expectRejection(bad);
    expect(err.message).toContain(
      "drs must be present on every sample or none",
    );
    expect(err.message).toContain(`${bad.cars[0].samples.length - 1} of`);
  });

  it("rejects a car with fewer than two samples", () => {
    const bad = clone();
    bad.cars[0].samples = [bad.cars[0].samples[0]];

    const err = expectRejection(bad);
    expect(err.message).toContain("at least 2 samples");
  });

  it("rejects an out-of-range throttle rather than absorbing dirty upstream data", () => {
    const bad = clone();
    bad.cars[0].samples[2].throttle = 104;

    const err = expectRejection(bad);
    expect(err.message).toContain("cars[0].samples[2].throttle");
  });

  it("rejects a malformed car color", () => {
    const bad = clone();
    bad.cars[0].color = "3671C6";

    const err = expectRejection(bad);
    expect(err.message).toContain("color must be a hex color");
  });

  it("rejects non-object input", () => {
    expect(() => parseReplay(null)).toThrow(ReplayValidationError);
    expect(() => parseReplay("{}")).toThrow(ReplayValidationError);
  });

  it("reports every violation at once, not just the first", () => {
    const bad = clone();
    delete bad.meta.duration;
    bad.cars[0].color = "nope";

    const err = expectRejection(bad);
    expect(err.issues.length).toBeGreaterThanOrEqual(2);
    expect(err.message).toContain("2 schema violations");
  });

  it("omits the source clause when no source is given", () => {
    const bad = clone();
    bad.meta.sampleRateHz = -10;

    const err = expectRejection(bad);
    expect(err.message).toMatch(/^Invalid replay data: /);
    expect(err.source).toBeUndefined();
  });
});

describe("parseReplay — uniform-grid guard", () => {
  // interpolate.ts looks samples up with `index = t * sampleRateHz` and never reads
  // `t` again (architecture rule 3). Strictly-increasing `t` is not enough to make
  // that safe — it admits arbitrary spacing — so the grid itself is part of the
  // contract, and a pipeline emitting irregular timestamps must fail here rather than
  // draw the car in the wrong place.
  it("accepts the fixture, which sits exactly on its 10 Hz grid", () => {
    const { meta, cars } = parseReplay(sampleLap);
    for (const [k, s] of cars[0].samples.entries()) {
      expect(Math.abs(s.t - k / meta.sampleRateHz)).toBeLessThanOrEqual(
        GRID_TOLERANCE_S,
      );
    }
  });

  it("rejects a sample nudged off the grid, naming the index", () => {
    const bad = clone();
    bad.cars[0].samples[300].t = bad.cars[0].samples[300].t + 0.05;

    const err = expectRejection(bad, "sample-lap.json");
    expect(err.message).toContain("uniform 10 Hz grid");
    expect(err.message).toContain("cars[0].samples[300].t");
    expect(err.issues[0].path).toEqual(["cars", 0, "samples", 300, "t"]);
  });

  it("tolerates the pipeline's 3-decimal rounding of t", () => {
    const ok = clone();
    // +1 ms: real rounding drift, not irregular sampling.
    ok.cars[0].samples[4].t = ok.cars[0].samples[4].t + 0.001;
    expect(() => parseReplay(ok)).not.toThrow();

    const bad = clone();
    bad.cars[0].samples[4].t = bad.cars[0].samples[4].t + 0.003;
    expect(() => parseReplay(bad)).toThrow(ReplayValidationError);
  });

  it("reports one grid violation per car, not one per sample", () => {
    const bad = clone();
    // Shift the whole tail of the lap: hundreds of samples are now off-grid.
    for (let k = 100; k < bad.cars[0].samples.length; k++) {
      bad.cars[0].samples[k].t = bad.cars[0].samples[k].t + 0.5;
    }

    const err = expectRejection(bad);
    const gridIssues = err.issues.filter((i) =>
      i.message.includes("uniform 10 Hz grid"),
    );
    expect(gridIssues).toHaveLength(1);
    expect(gridIssues[0].path).toEqual(["cars", 0, "samples", 100, "t"]);
  });
});
