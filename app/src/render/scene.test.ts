/**
 * buildScene's track ribbon (Slice 24, consumer half): the ribbon is the REFERENCE
 * LAP, `track.referenceLap`, and nothing else.
 *
 * Until Slice 24 it was `cars[0]`'s whole path — one lap on a lap file, but on a race
 * window every lap the first driver drove, grid slot and formation lap included,
 * stroked on top of each other. These pin which samples the ribbon now holds; the
 * drawcall md5 (`docs/perf/drawcall-capture.mjs`) pins that a lap file draws exactly
 * what it always drew, and `TrackCanvas.test.tsx` that the ribbon is stroked closed.
 */
import { describe, expect, it } from "vitest";
import { loadFixtureReplay } from "../data/fixture";
import { parseReplay } from "../engine/load";
import type { Sample } from "../engine/schema";
import { buildScene } from "./scene";

const RATE = 10;
const PER_LAP = 200;
/** A 1000 m circle in tenths of a metre, FastF1's scale: 5 m per step at 180 km/h. */
const RADIUS = 10_000 / (2 * Math.PI);

function circle(count: number, shift = 0): Sample[] {
  return Array.from({ length: count }, (_, k) => {
    const a = (2 * Math.PI * (k + shift)) / PER_LAP;
    return {
      t: k / RATE,
      x: RADIUS * Math.cos(a),
      y: RADIUS * Math.sin(a),
      speed: 180,
      throttle: 100,
      brake: 0,
      gear: 8,
    };
  });
}

/** An open race window of `cars`, carrying `referenceLap` when given. */
function windowOf(
  cars: Sample[][],
  referenceLap?: { car: number; fromT: number; toT: number },
) {
  const lineCar = cars[referenceLap?.car ?? 0];
  const line = lineCar[Math.round((referenceLap?.fromT ?? 0) * RATE)];
  return parseReplay({
    meta: {
      schemaVersion: 1,
      year: 2026,
      event: "Test",
      session: "R",
      track: "Test",
      rotation: 0,
      sampleRateHz: RATE,
      duration: cars[0].length / RATE,
      loop: "open",
      units: { speed: "km/h" },
    },
    track: {
      startFinish: { x: line.x, y: line.y, angle: Math.PI / 2 },
      corners: [],
      ...(referenceLap === undefined ? {} : { referenceLap }),
    },
    cars: cars.map((samples, i) => ({
      driver: `C${i}`,
      team: "Test",
      color: "#888888",
      samples,
    })),
  });
}

describe("buildScene's ribbon is the reference lap (Slice 24)", () => {
  it("traces every sample of a lap file, wrap left to closePath — the path it always drew", () => {
    // `{0, 0, duration}`: sample n is the wrap back to sample 0, which the painter's
    // closePath draws. So the ribbon is exactly cars[0]'s samples, no copy of the first.
    const replay = loadFixtureReplay();
    const scene = buildScene(replay);
    expect(replay.track.referenceLap.toT).toBe(replay.meta.duration);
    expect(scene.ribbon).toEqual(scene.carPaths[0]);
  });

  it("traces the NAMED car's lap, from its fromT to its toT", () => {
    const cars = [circle(3 * PER_LAP, 7), circle(3 * PER_LAP)];
    const scene = buildScene(windowOf(cars, { car: 1, fromT: 20, toT: 40 }));
    expect(scene.ribbon).toHaveLength(PER_LAP + 1);
    expect(scene.ribbon).toEqual(scene.carPaths[1].slice(200, 401));
  });

  it("is ONE lap of a window without the field, not every lap cars[0] drove", () => {
    // The legacy reference is cars[0] to its first return: 20 s of a 60 s window.
    const scene = buildScene(windowOf([circle(3 * PER_LAP)]));
    expect(scene.ribbon).toEqual(scene.carPaths[0].slice(0, PER_LAP + 1));
  });

  it("ends on the last sample when an open window's lap runs to meta.duration", () => {
    // toT = duration is sample n, which an open window HOLDS: no copied point.
    const cars = [circle(3 * PER_LAP)];
    const scene = buildScene(windowOf(cars, { car: 0, fromT: 40, toT: 60 }));
    expect(scene.ribbon).toEqual(scene.carPaths[0].slice(400));
  });
});
