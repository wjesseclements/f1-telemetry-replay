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

  it("checks every car's grid, not just the first", () => {
    // The v2 shape: cars share ONE grid, so a second driver drifting off it is the
    // same desync as a wrong sample count and has to fail the same way. Car 0 is
    // left untouched so the issue can only have come from car 1.
    const bad = clone();
    const second = structuredClone(bad.cars[0]);
    second.driver = "LEC";
    second.color = "#F91536";
    second.samples[7].t = second.samples[7].t + 0.05;
    bad.cars.push(second);

    const err = expectRejection(bad);
    const gridIssues = err.issues.filter((i) =>
      i.message.includes("uniform 10 Hz grid"),
    );
    expect(gridIssues).toHaveLength(1);
    expect(gridIssues[0].path).toEqual(["cars", 1, "samples", 7, "t"]);
  });
});

describe("parseReplay — track.pitLane (Slice 16)", () => {
  it("defaults an absent field to [] — pre-16 files parse and mean 'no lane'", () => {
    const bare = clone();
    delete bare.track.pitLane;
    expect(parseReplay(bare).track.pitLane).toEqual([]);
  });

  it("accepts driven polylines and preserves their points in order", () => {
    const withLane = clone();
    withLane.track.pitLane = [
      [
        { x: 1.5, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 4.5 },
      ],
    ];
    expect(parseReplay(withLane).track.pitLane).toEqual(withLane.track.pitLane);
  });

  it("rejects a one-point polyline, naming the path — a point is not a lane", () => {
    const bad = clone();
    bad.track.pitLane = [[{ x: 1, y: 2 }]];
    const err = expectRejection(bad);
    expect(err.message).toContain("track.pitLane[0]");
    expect(err.message).toContain("at least 2 points");
  });

  it("rejects a malformed point", () => {
    const bad = clone();
    bad.track.pitLane = [
      [
        { x: 1, y: 2 },
        { x: "3", y: 4 },
      ],
    ];
    const err = expectRejection(bad);
    expect(err.message).toContain("track.pitLane[0][1].x");
  });
});

describe("parseReplay — meta.loop", () => {
  // `loop` tells the engine whether the samples are a CYCLE (a lap) or an open
  // session-time window (v2). It is additive within schemaVersion 1, which only
  // holds if a file written before it existed still loads AND still means "a lap".
  it("defaults a replay without the field to closed", () => {
    expect(sampleLap.meta).not.toHaveProperty("loop");
    expect(parseReplay(sampleLap).meta.loop).toBe("closed");
  });

  it("accepts both modes when the field is present", () => {
    for (const loop of ["closed", "open"] as const) {
      const ok = clone();
      ok.meta.loop = loop;
      expect(parseReplay(ok).meta.loop, loop).toBe(loop);
    }
  });

  it("rejects any other value rather than falling back to a default", () => {
    // A typo must not silently become "closed": a window read as a lap glides every
    // car across the circuit for the final grid step. Fail loudly instead.
    const bad = clone();
    bad.meta.loop = "sideways";

    const err = expectRejection(bad, "sample-lap.json");
    expect(err.message).toContain("meta.loop");
  });

  it("rejects null, which is not the same as absent", () => {
    // `.default()` fills in for `undefined` only. An explicit null is a pipeline
    // emitting a field it could not compute, and that should be visible.
    const bad = clone();
    bad.meta.loop = null;
    expectRejection(bad);
  });
});

describe("parseReplay — laps and stints", () => {
  // Additive within schemaVersion 1 like `meta.loop`, but with `.default([])`:
  // an empty array means exactly what absence means — "this replay carries no
  // lap/tyre data" — so `z.infer` keeps the parsed fields required and the
  // engine branches on `length`, never on `undefined`.
  const LAPS = [
    { number: 48, startT: -1.5 },
    { number: 49, startT: 89.2 },
  ];
  const STINTS = [
    { compound: "HARD", fromLap: 48, toLap: 48, ageAtStart: 15 },
    { compound: "SOFT", fromLap: 49, toLap: 49 },
  ];

  it("defaults a replay without the fields to empty arrays", () => {
    expect(sampleLap.cars[0]).not.toHaveProperty("laps");
    expect(sampleLap.cars[0]).not.toHaveProperty("stints");
    const car = parseReplay(sampleLap).cars[0];
    expect(car.laps).toEqual([]);
    expect(car.stints).toEqual([]);
  });

  it("accepts a car carrying laps and stints, negative first startT and unknown age included", () => {
    const ok = clone();
    ok.cars[0].laps = LAPS;
    ok.cars[0].stints = STINTS;

    const car = parseReplay(ok).cars[0];
    expect(car.laps).toEqual(LAPS);
    expect(car.stints[0].ageAtStart).toBe(15);
    expect(
      car.stints[1].ageAtStart,
      "unknown age stays absent",
    ).toBeUndefined();
  });

  it("rejects an unknown compound rather than falling back to a default", () => {
    // The pipeline maps unrecognised compounds to "UNKNOWN"; an arbitrary string
    // reaching the loader is a hand-mangled file, and must fail as loudly as a
    // meta.loop typo does.
    const bad = clone();
    bad.cars[0].laps = LAPS;
    bad.cars[0].stints = [{ compound: "SUPERSOFT", fromLap: 48, toLap: 49 }];

    const err = expectRejection(bad);
    expect(err.message).toContain("compound");
  });

  it("rejects null for either field, which is not the same as absent", () => {
    for (const field of ["laps", "stints"] as const) {
      const bad = clone();
      bad.cars[0][field] = null;
      expectRejection(bad);
    }
  });

  it("rejects laps that do not strictly increase in startT", () => {
    // lapAt is a predecessor search on startT; unsorted boundaries mis-answer it.
    const bad = clone();
    bad.cars[0].laps = [
      { number: 48, startT: 10 },
      { number: 49, startT: 10 },
    ];

    const err = expectRejection(bad);
    expect(err.message).toContain("strictly increasing");
  });

  it("rejects laps that do not strictly increase in number", () => {
    const bad = clone();
    bad.cars[0].laps = [
      { number: 49, startT: 0 },
      { number: 48, startT: 10 },
    ];
    expectRejection(bad);
  });

  it("rejects a stint whose lap range is backwards", () => {
    const bad = clone();
    bad.cars[0].laps = LAPS;
    bad.cars[0].stints = [{ compound: "SOFT", fromLap: 49, toLap: 48 }];

    const err = expectRejection(bad);
    expect(err.message).toContain("backwards");
  });

  it("rejects overlapping stints", () => {
    // Two stints claiming one lap would make stintAt's answer depend on search
    // internals rather than on the data.
    const bad = clone();
    bad.cars[0].laps = LAPS;
    bad.cars[0].stints = [
      { compound: "HARD", fromLap: 48, toLap: 49 },
      { compound: "SOFT", fromLap: 49, toLap: 49 },
    ];

    const err = expectRejection(bad);
    expect(err.message).toContain("non-overlapping");
  });

  it("rejects stints without laps — a stint is located via the lap table", () => {
    const bad = clone();
    bad.cars[0].stints = [{ compound: "SOFT", fromLap: 48, toLap: 49 }];

    const err = expectRejection(bad);
    expect(err.message).toContain("unreachable");
  });
});

describe("parseReplay — span agreement", () => {
  // Three spans have to stay interchangeable: meta.duration (what the transport
  // wraps on), samples.length / sampleRateHz (what interpolate.ts wraps on), and
  // every OTHER car's span (what v2 needs for all drivers to show the same instant).
  // Left unchecked, a mismatch is not a crash — it is a slow desync between the car
  // and the scrubber that grows a little every lap. Locking them together here makes
  // it a load-time failure instead.
  const spanIssues = (err: ReplayValidationError) =>
    err.issues.filter((i) =>
      i.message.includes("must cover the replay's duration"),
    );

  it("accepts the fixture, whose car spans exactly meta.duration", () => {
    const { meta, cars } = parseReplay(sampleLap);
    expect(cars[0].samples.length / meta.sampleRateHz).toBe(meta.duration);
  });

  it("rejects a car whose samples were truncated, naming the car index", () => {
    const bad = clone();
    bad.cars[0].samples.length -= 5; // 580 samples = 58.0s against a 58.5s duration

    const err = expectRejection(bad, "sample-lap.json");
    expect(spanIssues(err)).toHaveLength(1);
    expect(err.issues[0].path).toEqual(["cars", 0, "samples"]);
    expect(err.message).toContain("spans 58s");
    expect(err.message).toContain("meta.duration is 58.5s");
  });

  it("tolerates the pipeline being one grid step short, but not two", () => {
    const oneShort = clone();
    oneShort.cars[0].samples.length -= 1; // floor(duration * rate) rounding
    expect(() => parseReplay(oneShort)).not.toThrow();

    const twoShort = clone();
    twoShort.cars[0].samples.length -= 2;
    expect(() => parseReplay(twoShort)).toThrow(ReplayValidationError);
  });

  it("rejects a duration that disagrees with the samples it describes", () => {
    const bad = clone();
    bad.meta.duration = 120;

    const err = expectRejection(bad);
    expect(spanIssues(err)).toHaveLength(1);
  });

  it("rejects multi-car desync — drivers carrying different sample counts", () => {
    // The v2 failure this exists to prevent: cars on different-length grids cannot
    // all be showing the same instant, and Slice 9 must never see such a replay.
    const bad = clone();
    const second = structuredClone(bad.cars[0]);
    second.driver = "LEC";
    second.samples.length -= 30;
    bad.cars.push(second);

    const err = expectRejection(bad);
    const issues = spanIssues(err);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(["cars", 1, "samples"]);
    expect(err.message).toContain("car LEC spans");
  });

  it("accepts a multi-car replay where every car shares the grid", () => {
    const ok = clone();
    const second = structuredClone(ok.cars[0]);
    second.driver = "LEC";
    second.color = "#F91536";
    ok.cars.push(second);

    const replay = parseReplay(ok);
    expect(replay.cars).toHaveLength(2);
    expect(replay.cars[1].samples).toHaveLength(replay.cars[0].samples.length);
  });
});

describe("parseReplay — trackStatus", () => {
  // Additive within schemaVersion 1 with `.default([])`, per the laps/stints
  // doctrine: absence and emptiness both mean "this replay carries no status
  // data", and the engine branches on `length`, never `undefined`.
  const INTERVALS = [
    { status: "green", fromT: 0, toT: 30 },
    { status: "yellow", fromT: 30, toT: 40 },
    { status: "red", fromT: 40, toT: 58.5 },
  ];

  it("defaults a replay without the field to an empty array", () => {
    expect(sampleLap).not.toHaveProperty("trackStatus");
    expect(parseReplay(sampleLap).trackStatus).toEqual([]);
  });

  it("accepts ordered intervals, every enum member included", () => {
    const ok = clone();
    ok.trackStatus = [
      { status: "green", fromT: 0, toT: 10 },
      { status: "yellow", fromT: 10, toT: 20 },
      { status: "sc", fromT: 20, toT: 30 },
      { status: "vsc", fromT: 30, toT: 40 },
      { status: "red", fromT: 40, toT: 50 },
      { status: "unknown", fromT: 50, toT: 58.5 },
    ];
    expect(parseReplay(ok).trackStatus).toHaveLength(6);
  });

  it("accepts a gap between intervals — a gap means no answer, not an error", () => {
    const ok = clone();
    ok.trackStatus = [
      { status: "green", fromT: 0, toT: 10 },
      { status: "red", fromT: 20, toT: 30 },
    ];
    expect(parseReplay(ok).trackStatus).toHaveLength(2);
  });

  it("rejects an arbitrary status string rather than falling back to a default", () => {
    // The pipeline maps unrecognised codes to "unknown"; an arbitrary string
    // reaching the loader is a hand-mangled file, and must fail as loudly as a
    // compound typo does.
    const bad = clone();
    bad.trackStatus = [{ status: "CODE60", fromT: 0, toT: 10 }];
    const err = expectRejection(bad);
    expect(err.message).toContain("status");
  });

  it("rejects null, which is not the same as absent", () => {
    const bad = clone();
    bad.trackStatus = null;
    expectRejection(bad);
  });

  it("rejects an interval that does not run forwards", () => {
    const bad = clone();
    bad.trackStatus = [{ status: "green", fromT: 10, toT: 10 }];
    const err = expectRejection(bad);
    expect(err.message).toContain("run forwards");
  });

  it("rejects an interval past the replay's duration — pipeline clips before emitting", () => {
    const bad = clone();
    bad.trackStatus = [{ status: "green", fromT: 0, toT: 60 }];
    const err = expectRejection(bad);
    expect(err.message).toContain("meta.duration");
  });

  it("rejects overlapping or unsorted intervals — the tick's scan trusts the order", () => {
    const bad = clone();
    bad.trackStatus = [
      { status: "green", fromT: 0, toT: 30 },
      { status: "yellow", fromT: 29, toT: 40 },
    ];
    const err = expectRejection(bad);
    expect(err.message).toContain("non-overlapping");
  });

  it("reports one interval violation, not one per interval", () => {
    const bad = clone();
    bad.trackStatus = [
      { status: "green", fromT: 10, toT: 5 },
      { status: "red", fromT: 4, toT: 2 },
    ];
    const err = expectRejection(bad);
    const statusIssues = err.issues.filter(
      (issue) => issue.path[0] === "trackStatus",
    );
    expect(statusIssues).toHaveLength(1);
  });

  it("accepts the full red-flag arc against the fixture's duration", () => {
    const ok = clone();
    ok.trackStatus = INTERVALS;
    expect(parseReplay(ok).trackStatus).toEqual(INTERVALS);
  });
});

describe("parseReplay — retiredAt (Slice 9l)", () => {
  it("defaults to absent — never retired is the unmarked state", () => {
    expect(sampleLap.cars[0]).not.toHaveProperty("retiredAt");
    expect(parseReplay(sampleLap).cars[0].retiredAt).toBeUndefined();
  });

  it("accepts a retirement inside the window, zero included", () => {
    const ok = clone();
    ok.cars[0].retiredAt = 30.5;
    expect(parseReplay(ok).cars[0].retiredAt).toBe(30.5);
    // 0 is a real value — retired at the window's first instant — which is
    // exactly why absence is spelled `.optional()` and never defaulted to it.
    ok.cars[0].retiredAt = 0;
    expect(parseReplay(ok).cars[0].retiredAt).toBe(0);
  });

  it("rejects a negative retirement and a null one", () => {
    const bad = clone();
    bad.cars[0].retiredAt = -1;
    expectRejection(bad);
    bad.cars[0].retiredAt = null;
    expectRejection(bad);
  });

  it("rejects a retirement past the window's end, naming the car", () => {
    const bad = clone();
    bad.cars[0].retiredAt = 60; // fixture duration is 58.5
    const err = expectRejection(bad);
    expect(err.message).toContain("retires at 60");
    expect(err.message).toContain("meta.duration");
  });
});

describe("parseReplay — dropouts (Slice 9m)", () => {
  it("defaults to an empty array — a feed that never dropped is the unmarked state", () => {
    expect(sampleLap.cars[0]).not.toHaveProperty("dropouts");
    expect(parseReplay(sampleLap).cars[0].dropouts).toEqual([]);
  });

  it("accepts ordered, non-overlapping, in-window intervals", () => {
    const ok = clone();
    ok.cars[0].dropouts = [
      { fromT: 5, toT: 11 },
      { fromT: 20, toT: 26 },
    ];
    expect(parseReplay(ok).cars[0].dropouts).toHaveLength(2);
  });

  it("rejects a backwards interval", () => {
    const bad = clone();
    bad.cars[0].dropouts = [{ fromT: 10, toT: 10 }];
    const err = expectRejection(bad);
    expect(err.message).toContain("must run forwards");
  });

  it("rejects overlapping or unordered intervals", () => {
    const bad = clone();
    bad.cars[0].dropouts = [
      { fromT: 5, toT: 12 },
      { fromT: 10, toT: 20 },
    ];
    const err = expectRejection(bad);
    expect(err.message).toContain("ordered and non-overlapping");
  });

  it("rejects a dropout past the window's end, naming the car", () => {
    const bad = clone();
    bad.cars[0].dropouts = [{ fromT: 50, toT: 60 }]; // fixture duration is 58.5
    const err = expectRejection(bad);
    expect(err.message).toContain("dropout ending at 60");
    expect(err.message).toContain("meta.duration");
  });
});
