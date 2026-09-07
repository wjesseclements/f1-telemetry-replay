/**
 * tyres.ts tests — stint location via the lap table, and age arithmetic.
 *
 * Built by augmenting the parsed fixture car (clone-and-augment; the committed
 * fixture stays a bare v1 lap). Stint ranges are deliberately unlike each other
 * — different lengths, a coverage gap, one unknown age — so a lookup that only
 * works on tidy back-to-back stints cannot pass by luck.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import {
  carHasTyres,
  compoundLetter,
  stintAt,
  stintForLap,
  tyreAge,
  tyreStateAt,
} from "./tyres";
import type { Car, Lap, Stint } from "./schema";

const fixtureCar = (): Car => parseReplay(sampleLap).cars[0];

function carWith(laps: Lap[], stints: Stint[]): Car {
  return { ...fixtureCar(), laps, stints };
}

/** Three unlike stints with a one-lap hole between the second and third. */
const STINTS: Stint[] = [
  { compound: "MEDIUM", fromLap: 1, toLap: 13, ageAtStart: 2 },
  { compound: "HARD", fromLap: 14, toLap: 39 }, // age unknown, deliberately
  { compound: "SOFT", fromLap: 41, toLap: 52, ageAtStart: 0 }, // lap 40 uncovered
];

const LAPS: Lap[] = [
  { number: 12, startT: -2.1 },
  { number: 13, startT: 15.0 },
  { number: 14, startT: 33.8 },
];

describe("carHasTyres", () => {
  it("is false for a car with no tyre data (every pre-Slice-14 file)", () => {
    expect(carHasTyres(fixtureCar())).toBe(false);
  });

  it("is true when stints are carried", () => {
    expect(carHasTyres(carWith(LAPS, STINTS))).toBe(true);
  });
});

describe("stintForLap", () => {
  const car = carWith(LAPS, STINTS);

  it("answers null when the car has no stints", () => {
    expect(stintForLap(fixtureCar(), 5)).toBeNull();
  });

  it("answers null before the first stint's range", () => {
    expect(stintForLap(carWith(LAPS, STINTS.slice(1)), 13)).toBeNull();
  });

  it("finds the containing stint, boundaries included", () => {
    expect(stintForLap(car, 1)?.compound).toBe("MEDIUM");
    expect(stintForLap(car, 13)?.compound).toBe("MEDIUM");
    expect(stintForLap(car, 14)?.compound).toBe("HARD");
    expect(stintForLap(car, 39)?.compound).toBe("HARD");
    expect(stintForLap(car, 41)?.compound).toBe("SOFT");
    expect(stintForLap(car, 52)?.compound).toBe("SOFT");
  });

  it("answers null in a coverage gap — a real state, not an error", () => {
    expect(stintForLap(car, 40)).toBeNull();
  });

  it("answers null past the last stint's range", () => {
    expect(stintForLap(car, 53)).toBeNull();
  });

  it("handles a single-stint table (a closed v1 file)", () => {
    const one = carWith(
      [{ number: 52, startT: 0 }],
      [{ compound: "SOFT", fromLap: 52, toLap: 52, ageAtStart: 8 }],
    );
    expect(stintForLap(one, 52)?.compound).toBe("SOFT");
    expect(stintForLap(one, 51)).toBeNull();
  });
});

describe("stintAt", () => {
  const car = carWith(LAPS, STINTS);

  it("locates the stint through lapAt: clock → lap → stint", () => {
    expect(stintAt(car, 0)?.compound, "lap 12, first stint").toBe("MEDIUM");
    expect(stintAt(car, 33.8)?.compound, "lap 14 starts the HARD stint").toBe(
      "HARD",
    );
  });

  it("answers null when the lap has no answer", () => {
    expect(stintAt(car, -5), "before the first known lap").toBeNull();
    expect(stintAt(fixtureCar(), 10), "no lap data at all").toBeNull();
  });
});

describe("tyreStateAt", () => {
  const car = carWith(LAPS, STINTS);

  it("bundles compound and age for the HUD's one lookup per car per tick", () => {
    // Clock 0 is inside lap 12 (started at -2.1): MEDIUM, ageAtStart 2 + 11 laps.
    expect(tyreStateAt(car, 0)).toEqual({ compound: "MEDIUM", age: 13 });
  });

  it("carries a null age for a stint whose starting age is unknown", () => {
    expect(tyreStateAt(car, 33.8)).toEqual({ compound: "HARD", age: null });
  });

  it("answers null when the lap or the stint has no answer", () => {
    expect(tyreStateAt(car, -5), "before the first known lap").toBeNull();
    expect(tyreStateAt(fixtureCar(), 10), "no tyre data at all").toBeNull();
    expect(
      tyreStateAt(carWith(LAPS, STINTS.slice(2)), 0),
      "lap outside every stint",
    ).toBeNull();
  });
});

describe("compoundLetter", () => {
  it("uses the broadcast one-letter marks, and ? for UNKNOWN", () => {
    expect(compoundLetter("SOFT")).toBe("S");
    expect(compoundLetter("MEDIUM")).toBe("M");
    expect(compoundLetter("HARD")).toBe("H");
    expect(compoundLetter("INTERMEDIATE")).toBe("I");
    expect(compoundLetter("WET")).toBe("W");
    expect(compoundLetter("UNKNOWN")).toBe("?");
  });
});

describe("tyreAge", () => {
  it("adds laps completed within the stint to the starting age", () => {
    expect(tyreAge(STINTS[0], 1)).toBe(2);
    expect(tyreAge(STINTS[0], 13)).toBe(14);
    expect(tyreAge(STINTS[2], 41), "a genuinely fresh set reads 0").toBe(0);
  });

  it("answers null when the starting age is unknown — never a zero", () => {
    expect(tyreAge(STINTS[1], 20)).toBeNull();
  });
});
