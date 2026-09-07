/**
 * laps.ts tests — predecessor search over lap boundaries, and the lap counter.
 *
 * Lap tables here are built by augmenting the parsed fixture car (the house
 * clone-and-augment pattern; the committed fixture itself stays a bare v1 lap).
 * Boundaries are deliberately UNEVEN (17.3 s, then 21.9 s, then 16.4 s laps) so
 * an off-by-one in the search cannot hide behind a regular spacing — the
 * fixture-asymmetry lesson applied at the test, since it cannot yet be applied
 * at the fixture.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import { lapAt, leaderLap } from "./laps";
import type { Car, Lap, Replay } from "./schema";

const fixtureCar = (): Car => parseReplay(sampleLap).cars[0];

/** The fixture car carrying the given lap table. */
function carWithLaps(laps: Lap[]): Car {
  return { ...fixtureCar(), laps };
}

/**
 * Uneven boundaries, negative first start: lap 23 was in progress when the
 * window opened (the reference driver's window, another car's lap — see
 * `LapSchema`).
 */
const UNEVEN: Lap[] = [
  { number: 23, startT: -3.2 },
  { number: 24, startT: 14.1 },
  { number: 25, startT: 36.0 },
  { number: 26, startT: 52.4 },
];

describe("lapAt", () => {
  it("answers null for a car with no lap data (every pre-Slice-14 file)", () => {
    expect(lapAt(fixtureCar(), 10)).toBeNull();
  });

  it("answers null for a non-finite clock rather than mis-searching", () => {
    for (const clock of [NaN, Infinity, -Infinity]) {
      expect(lapAt(carWithLaps(UNEVEN), clock), `clock ${clock}`).toBeNull();
    }
  });

  it("answers null before the first known lap start", () => {
    const car = carWithLaps([
      { number: 5, startT: 8.0 },
      { number: 6, startT: 25.5 },
    ]);
    expect(lapAt(car, 7.999)).toBeNull();
  });

  it("covers clock 0 with a lap that started before the window", () => {
    expect(lapAt(carWithLaps(UNEVEN), 0)).toBe(23);
  });

  it("answers the lap whose interval contains the clock, at uneven spacing", () => {
    const car = carWithLaps(UNEVEN);
    expect(lapAt(car, -3.2), "first boundary exactly").toBe(23);
    expect(lapAt(car, 14.099), "just before lap 24").toBe(23);
    expect(lapAt(car, 14.1), "boundary belongs to the new lap").toBe(24);
    expect(lapAt(car, 35.999)).toBe(24);
    expect(lapAt(car, 36.0)).toBe(25);
    expect(lapAt(car, 52.4)).toBe(26);
  });

  it("HOLDS the last lap after the last known start — a retired car stays on the lap it stopped on", () => {
    const car = carWithLaps(UNEVEN);
    // No lap-end times are carried; drifting to null here would blank a dot and
    // a chip that were true a moment earlier. Decided in the module header.
    expect(lapAt(car, 52.5)).toBe(26);
    expect(lapAt(car, 10_000)).toBe(26);
  });

  it("handles the degenerate one-lap table (a closed v1 file)", () => {
    const car = carWithLaps([{ number: 52, startT: 0 }]);
    expect(lapAt(car, 0)).toBe(52);
    expect(lapAt(car, 58.4), "same lap on every wrap").toBe(52);
    expect(lapAt(car, -0.001)).toBeNull();
  });

  it("handles the two-lap table, where the search loop never runs", () => {
    const car = carWithLaps([
      { number: 1, startT: 0 },
      { number: 2, startT: 20 },
    ]);
    expect(lapAt(car, 19.999)).toBe(1);
    expect(lapAt(car, 20)).toBe(2);
  });
});

describe("leaderLap", () => {
  /** A replay whose cars carry the given lap tables (empty = no data). */
  function replayWithLaps(tables: Lap[][]): Replay {
    const replay = parseReplay(sampleLap);
    return { ...replay, cars: tables.map((laps) => carWithLaps(laps)) };
  }

  it("answers null when no car carries lap data, hiding the indicator", () => {
    expect(leaderLap(replayWithLaps([[], []]), 10)).toBeNull();
  });

  it("answers the highest lap across cars, ignoring cars with no answer", () => {
    const replay = replayWithLaps([
      [{ number: 48, startT: 0 }],
      UNEVEN, // lap 24 at clock 20
      [], // no data at all
      [{ number: 50, startT: 30.0 }], // not started yet at clock 20
    ]);
    expect(leaderLap(replay, 20)).toBe(48);
    expect(leaderLap(replay, 31), "late starter takes the lead").toBe(50);
  });

  it("shows the shared number on a tie without picking a car", () => {
    const replay = replayWithLaps([
      [{ number: 30, startT: 0 }],
      [{ number: 30, startT: 1.5 }],
    ]);
    expect(leaderLap(replay, 5)).toBe(30);
  });
});
