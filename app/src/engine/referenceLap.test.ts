/**
 * The reference lap's app half (Slice 24): the legacy synthesis that keeps every
 * file without `track.referenceLap` behaving exactly as before, and the schema's
 * acceptance and rejection of a file that carries one.
 *
 * Geometry is closed-form, the `gaps.test.ts` doctrine: a circle of 1000 m at
 * 180 km/h is 5 m per 10 Hz step and 200 samples per lap, in position units of ten
 * per metre — FastF1's scale, so the metre bridge has a real factor to recover.
 * Proof against the SHIPPED gallery files lives in `data/legacyReferenceLap.test.ts`.
 */
import { describe, expect, it } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { MAX_RESIDUAL_M, MIN_LAP_S, buildProgressIndex } from "./gaps";
import { ReplayValidationError, parseReplay } from "./load";
import {
  REFERENCE_LAP_CLOSE_M,
  REFERENCE_LAP_MIN_S,
  START_FINISH_MAX_OFFSET_M,
  legacyReferenceLap,
  metresApart,
  referenceLapEnds,
  withReferenceLap,
  type UnreferencedReplay,
} from "./referenceLap";
import type { Sample } from "./schema";

const RATE = 10;
/** Position units per metre. */
const UNITS = 10;
const PER_LAP = 200;
const RADIUS = (1000 * UNITS) / (2 * Math.PI);

/**
 * `count` samples round a circle from angle `shift` steps, at `kmh`. `perLap` sizes
 * the circle so a step stays 5 m: the default is the 1000 m ring, 50 is a 5 s lap.
 */
function circle(
  count: number,
  shift = 0,
  kmh = 180,
  perLap = PER_LAP,
): Sample[] {
  const radius = (RADIUS * perLap) / PER_LAP;
  const out: Sample[] = [];
  for (let k = 0; k < count; k++) {
    const a = (2 * Math.PI * (k + shift)) / perLap;
    out.push({
      t: k / RATE,
      x: radius * Math.cos(a),
      y: radius * Math.sin(a),
      speed: kmh,
      throttle: 100,
      brake: 0,
      gear: 8,
    });
  }
  return out;
}

/** A car parked at one point for `count` samples. */
function parked(count: number, x = 123, y = 456): Sample[] {
  return circle(count).map((s) => ({ ...s, x, y, speed: 0, throttle: 0 }));
}

interface Options {
  cars: Sample[][];
  loop?: "open" | "closed";
  referenceLap?: unknown;
  startFinish?: { x: number; y: number; angle: number };
}

/** Raw replay JSON, as a file would carry it. */
function replayJson({
  cars,
  loop = "open",
  referenceLap,
  startFinish,
}: Options) {
  return {
    meta: {
      schemaVersion: 1,
      year: 2026,
      event: "Test",
      session: "R",
      track: "Test",
      rotation: 0,
      sampleRateHz: RATE,
      duration: cars[0].length / RATE,
      loop,
      units: { speed: "km/h" },
    },
    track: {
      startFinish: startFinish ?? {
        x: cars[0][0].x,
        y: cars[0][0].y,
        angle: 0,
      },
      corners: [],
      ...(referenceLap === undefined ? {} : { referenceLap }),
    },
    cars: cars.map((samples, i) => ({
      driver: `C${i}`,
      team: "Test",
      color: "#888888",
      samples,
    })),
  };
}

/** What `findLapEnd` measures today, from the engine that uses it. */
const gapsLapSeconds = (json: unknown) =>
  buildProgressIndex(parseReplay(json)).lapSeconds;

describe("legacyReferenceLap — what a file without the field has always meant", () => {
  it("is the whole closed loop for a lap, wrap step included (the fixture)", () => {
    const replay = parseReplay(sampleLap);
    expect(replay.track.referenceLap).toEqual({
      car: 0,
      fromT: 0,
      toT: replay.meta.duration,
    });
    // Today's buildReference finds the fixture's return at its LAST sample — the
    // same lap, one grid step short of the wrap that closes it.
    const lapSeconds = buildProgressIndex(replay).lapSeconds;
    expect(lapSeconds).toBeCloseTo(replay.meta.duration - 1 / RATE, 9);
  });

  it("is cars[0] to its first return for a window — the span gaps.ts uses", () => {
    const json = replayJson({
      cars: [circle(3 * PER_LAP), circle(3 * PER_LAP, 40)],
    });
    const ref = parseReplay(json).track.referenceLap;
    expect(ref).toEqual({ car: 0, fromT: 0, toT: 20 });
    expect(ref.toT).toBe(gapsLapSeconds(json));
  });

  it("starts at cars[0] wherever that is, which is the defect it preserves", () => {
    // cars[0] begins a quarter-lap round the circle: the legacy span still starts
    // at its sample 0 and runs one lap from THERE. Unchanged on purpose.
    const json = replayJson({
      cars: [circle(2 * PER_LAP, 50), circle(2 * PER_LAP)],
    });
    expect(parseReplay(json).track.referenceLap).toEqual({
      car: 0,
      fromT: 0,
      toT: gapsLapSeconds(json),
    });
  });

  it("is the whole path when cars[0] never returns, which gaps.ts calls no ring", () => {
    const json = replayJson({ cars: [circle(80)] });
    const replay = parseReplay(json);
    expect(replay.track.referenceLap).toEqual({ car: 0, fromT: 0, toT: 7.9 });
    expect(buildProgressIndex(replay).lapUnits).toBe(0);
  });

  it("is the whole path when cars[0] never moved", () => {
    const replay = parseReplay(
      replayJson({ cars: [parked(120), circle(120)] }),
    );
    expect(replay.track.referenceLap).toEqual({ car: 0, fromT: 0, toT: 11.9 });
    expect(buildProgressIndex(replay).degenerate[0]).toBe(true);
  });

  it("measures 'back where it started' with gaps.ts's own radius", () => {
    // The last quarter of the lap runs `wideM` outside the circle, so the car comes
    // back past its start exactly that far wide. Inside MAX_RESIDUAL_M (through the
    // car's own bridge) that is a return; outside it, the car never came back.
    const wideLap = (wideM: number) =>
      circle(PER_LAP + 20).map((s, k) =>
        k <= 150
          ? s
          : {
              ...s,
              x: s.x * (1 + (wideM * UNITS) / RADIUS),
              y: s.y * (1 + (wideM * UNITS) / RADIUS),
            },
      );
    const near = replayJson({ cars: [wideLap(MAX_RESIDUAL_M - 3)] });
    const far = replayJson({ cars: [wideLap(MAX_RESIDUAL_M + 3)] });
    expect(parseReplay(near).track.referenceLap.toT).toBe(20);
    expect(parseReplay(near).track.referenceLap.toT).toBe(gapsLapSeconds(near));
    expect(parseReplay(far).track.referenceLap.toT).toBe(21.9);
    expect(gapsLapSeconds(far)).toBe(0);
  });

  it("shares its constants with gaps.ts rather than restating them", () => {
    expect(START_FINISH_MAX_OFFSET_M).toBe(MAX_RESIDUAL_M);
    expect(REFERENCE_LAP_CLOSE_M).toBe(MAX_RESIDUAL_M);
    expect(REFERENCE_LAP_MIN_S).toBe(MIN_LAP_S);
  });
});

describe("withReferenceLap — the one place the field is settled", () => {
  const base = () =>
    ({
      ...parseReplay(replayJson({ cars: [circle(3 * PER_LAP)] })),
    }) as UnreferencedReplay;

  it("keeps a file's own reference lap", () => {
    const own = { car: 0, fromT: 20, toT: 40 };
    const replay = base();
    replay.track = { ...replay.track, referenceLap: own };
    expect(withReferenceLap(replay).track.referenceLap).toBe(own);
  });

  it("synthesizes the legacy one when the file has none", () => {
    const replay = base();
    const { startFinish, corners, pitLane } = replay.track;
    const settled = withReferenceLap({
      ...replay,
      track: { startFinish, corners, pitLane },
    });
    // Three laps of the ring: cars[0] is back where it started at 20 s.
    expect(settled.track.referenceLap).toEqual({ car: 0, fromT: 0, toT: 20 });
    expect(settled.track.referenceLap).toEqual(legacyReferenceLap(replay));
  });
});

describe("referenceLapEnds and metresApart", () => {
  const LAP = { car: 0, fromT: 20, toT: 40 };
  /** Metres from `track.startFinish` to the lap's start — the schema's line check. */
  const lineOffset = (cars: Sample[][], dx: number) => {
    const replay = parseReplay(
      replayJson({
        cars,
        startFinish: { x: cars[0][200].x + dx, y: cars[0][200].y, angle: 0 },
      }),
    );
    const ends = referenceLapEnds(replay, LAP)!;
    return metresApart(
      replay.track.startFinish,
      ends.start,
      ends.unitsPerMetre,
    );
  };

  it("converts through the car's own metre bridge, not a constant", () => {
    const cars = [circle(3 * PER_LAP)];
    const offset = lineOffset(cars, 12 * UNITS);
    // The chord of a 5 m arc step is a hair under 5 m, so the bridge reads a hair
    // under 10 units/m and the answer a hair over 12 m.
    expect(offset).toBeCloseTo(12, 2);
    // Scale every coordinate by ten: identical metres (the gaps.ts unit pin).
    const scaled = cars.map((c) =>
      c.map((s) => ({ ...s, x: s.x * 10, y: s.y * 10 })),
    );
    expect(lineOffset(scaled, 120 * UNITS)).toBeCloseTo(offset, 9);
  });

  it("reads both ends off the reference car, so one lap of the ring closes", () => {
    const cars = [circle(3 * PER_LAP)];
    const replay = parseReplay(replayJson({ cars }));
    const ends = referenceLapEnds(replay, LAP)!;
    expect(ends.start).toEqual({ x: cars[0][200].x, y: cars[0][200].y });
    expect(ends.end).toEqual({ x: cars[0][400].x, y: cars[0][400].y });
    expect(metresApart(ends.start, ends.end, ends.unitsPerMetre)).toBeCloseTo(
      0,
      9,
    );
  });

  it("is null when the car covers no ground over the span", () => {
    const replay = parseReplay(
      replayJson({ cars: [circle(300), parked(300)] }),
    );
    expect(referenceLapEnds(replay, { car: 1, fromT: 0, toT: 20 })).toBeNull();
  });

  it("reads a closed lap's toT = duration as the WRAP back to sample 0", () => {
    // Sample n does not exist; at `duration` the engine has looped back to the
    // first sample, so a closed file's whole-lap `{0, 0, duration}` closes exactly.
    const samples = circle(PER_LAP);
    const replay = parseReplay(replayJson({ cars: [samples], loop: "closed" }));
    const ends = referenceLapEnds(replay, {
      car: 0,
      fromT: 0,
      toT: replay.meta.duration,
    })!;
    expect(ends.end).toEqual({ x: samples[0].x, y: samples[0].y });
    expect(metresApart(ends.start, ends.end, ends.unitsPerMetre)).toBe(0);
  });

  it("reads an open window's toT = duration as the HELD last sample", () => {
    const samples = circle(PER_LAP);
    const replay = parseReplay(replayJson({ cars: [samples] }));
    const ends = referenceLapEnds(replay, {
      car: 0,
      fromT: 0,
      toT: replay.meta.duration,
    })!;
    const last = samples[PER_LAP - 1];
    expect(ends.end).toEqual({ x: last.x, y: last.y });
    // One 5 m step short of the start: the last fix before the line.
    expect(metresApart(ends.start, ends.end, ends.unitsPerMetre)).toBeCloseTo(
      5,
      1,
    );
  });
});

describe("schema: an explicit track.referenceLap", () => {
  const cars = () => [
    circle(3 * PER_LAP),
    circle(3 * PER_LAP, 40),
    parked(3 * PER_LAP),
  ];
  const lineAt = (k: number, dxM = 0) => {
    const s = circle(3 * PER_LAP)[k];
    return { x: s.x + dxM * UNITS, y: s.y, angle: Math.PI / 2 };
  };
  const parseWith = (referenceLap: unknown, startFinish = lineAt(200)) =>
    parseReplay(
      replayJson({ cars: cars(), referenceLap, startFinish }),
      "test.json",
    );

  it("survives parsing — the field is in the schema, not stripped", () => {
    const own = { car: 0, fromT: 20, toT: 40 };
    expect(parseWith(own).track.referenceLap).toEqual(own);
  });

  it("may name any car, and may end exactly at meta.duration", () => {
    // cars[1]'s last lap, ending in the holding step: sample 600 does not exist,
    // and the held sample 599 is one 5 m step short of where the lap began.
    const shifted = circle(3 * PER_LAP, 40);
    expect(
      parseWith(
        { car: 1, fromT: 40, toT: 60 },
        { ...lineAt(200), x: shifted[400].x, y: shifted[400].y },
      ).track.referenceLap.car,
    ).toBe(1);
    const closed = parseReplay(
      replayJson({
        cars: [circle(PER_LAP)],
        loop: "closed",
        referenceLap: { car: 0, fromT: 0, toT: 20 },
      }),
    );
    expect(closed.track.referenceLap.toT).toBe(closed.meta.duration);
  });

  it("allows the schema's 2 ms grid tolerance and a line just inside the bound", () => {
    expect(() =>
      parseWith({ car: 0, fromT: 20.001, toT: 39.999 }),
    ).not.toThrow();
    expect(() =>
      parseWith(
        { car: 0, fromT: 20, toT: 40 },
        lineAt(200, START_FINISH_MAX_OFFSET_M - 1),
      ),
    ).not.toThrow();
    // A lap exactly at the 5 s floor: a ring of 50 steps, which closes.
    const short = circle(3 * 50, 0, 180, 50);
    expect(() =>
      parseReplay(
        replayJson({
          cars: [short],
          referenceLap: { car: 0, fromT: 5, toT: 10 },
          startFinish: { x: short[50].x, y: short[50].y, angle: 0 },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a lap that closes within 25 m and rejects one that does not", () => {
    // Past the lap's end by 4 steps (20 m of arc) and by 6 (30 m).
    expect(() => parseWith({ car: 0, fromT: 20, toT: 40.4 })).not.toThrow();
    const over = () => parseWith({ car: 0, fromT: 20, toT: 40.6 });
    expect(over).toThrow(ReplayValidationError);
    expect(over).toThrow(/does not close: .* 30\.0 m apart/);
  });

  it("rejects a span that is not one lap, naming both positions", () => {
    // Half the ring: the car ends a diameter (318.3 m) from where it started.
    const half = () => parseWith({ car: 0, fromT: 20, toT: 30 });
    const s = circle(3 * PER_LAP);
    const at = (k: number) => `(${s[k].x.toFixed(1)}, ${s[k].y.toFixed(1)})`;
    expect(half).toThrow(ReplayValidationError);
    expect(half).toThrow(
      `track.referenceLap does not close: cars[0] (C0) is at ${at(200)} at fromT=20 and at ${at(300)} at toT=30, 318.3 m apart`,
    );
    expect(half).toThrow(`must lie within ${REFERENCE_LAP_CLOSE_M} m`);
  });

  it.each([
    [
      "a car that does not exist",
      { car: 3, fromT: 20, toT: 40 },
      "the replay has 3 car(s)",
    ],
    ["a fractional car", { car: 0.5, fromT: 20, toT: 40 }, "car"],
    ["a negative fromT", { car: 0, fromT: -0.1, toT: 40 }, "fromT"],
    [
      "fromT off the grid",
      { car: 0, fromT: 20.05, toT: 40 },
      "fromT=20.05 is not on the 10 Hz sample grid",
    ],
    [
      "toT off the grid",
      { car: 0, fromT: 20, toT: 39.95 },
      "toT=39.95 is not on the 10 Hz sample grid",
    ],
    [
      "a span that runs backwards",
      { car: 0, fromT: 40, toT: 20 },
      "must run forwards",
    ],
    ["an empty span", { car: 0, fromT: 20, toT: 20 }, "must run forwards"],
    [
      "a span past the window",
      { car: 0, fromT: 20, toT: 60.1 },
      "but meta.duration is 60",
    ],
    [
      "a span shorter than any lap",
      { car: 0, fromT: 20, toT: 24.9 },
      "spans 4.9 s; one lap of a circuit spans at least 5 s",
    ],
    [
      "a car that never moves",
      { car: 2, fromT: 20, toT: 40 },
      "cars[2] (C2) covers no ground",
    ],
  ])("rejects %s, loudly", (_name, referenceLap, message) => {
    expect(() => parseWith(referenceLap)).toThrow(ReplayValidationError);
    expect(() => parseWith(referenceLap)).toThrow(message);
    expect(() => parseWith(referenceLap)).toThrow("referenceLap");
  });

  it("rejects a start/finish line that is not where the reference lap starts", () => {
    // The red-flag asset's defect in miniature: a line far from the lap's start.
    const far = () =>
      parseWith(
        { car: 0, fromT: 20, toT: 40 },
        lineAt(200, START_FINISH_MAX_OFFSET_M + 5),
      );
    expect(far).toThrow(ReplayValidationError);
    expect(far).toThrow(
      /track\.startFinish is 30\.\d m from cars\[0\] \(C0\) at fromT=20/,
    );
    expect(far).toThrow("must lie within 25 m");
  });
});
