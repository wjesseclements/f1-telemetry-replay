/**
 * Bootstrap tests — the blank-page failure, made impossible.
 *
 * These go through the REAL `parseReplay` with a genuinely mutated fixture rather
 * than a hand-written error string, because the thing worth protecting is the whole
 * chain: schema → `z.prettifyError` → `ReplayValidationError.message` → the screen.
 * A test that fed in `"boom"` would still pass with the schema wired up wrongly.
 */
import { describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { bootstrapReplay } from "./bootstrap";
import { FIXTURE_SOURCE } from "./fixture";

/** A deep clone of the fixture, so a mutation cannot leak into another test. */
const clone = (): typeof sampleLap =>
  JSON.parse(JSON.stringify(sampleLap)) as typeof sampleLap;

describe("bootstrapReplay", () => {
  it("returns the validated fixture by default", () => {
    const result = bootstrapReplay();
    expect(result.error).toBeNull();
    expect(result.replay?.cars).toHaveLength(1);
    expect(result.replay?.meta.event).toBe(sampleLap.meta.event);
  });

  it("returns the validation message instead of throwing", () => {
    const broken = clone();
    // @ts-expect-error deliberately violating the schema
    broken.cars[0].samples[3].speed = "quick";

    const result = bootstrapReplay(broken, FIXTURE_SOURCE);
    expect(result.replay).toBeNull();
    expect(result.error).toContain(FIXTURE_SOURCE);
    // The actionable part: which field, in which sample, of which car.
    expect(result.error).toContain("cars[0].samples[3].speed");
  });

  it("names every offending path, not just the first", () => {
    const broken = clone();
    // @ts-expect-error deliberately violating the schema
    broken.cars[0].samples[3].speed = "quick";
    // @ts-expect-error deliberately violating the schema
    broken.cars[0].samples[9].gear = "third";

    const error = bootstrapReplay(broken, FIXTURE_SOURCE).error ?? "";
    expect(error).toContain("cars[0].samples[3].speed");
    expect(error).toContain("cars[0].samples[9].gear");
    expect(error).toContain("2 schema violations");
  });

  it("reports a missing core field", () => {
    const broken = clone();
    // @ts-expect-error deliberately violating the schema
    delete broken.cars[0].samples[0].x;

    expect(bootstrapReplay(broken, FIXTURE_SOURCE).error).toContain(
      "cars[0].samples[0].x",
    );
  });

  it("survives input that is not a replay at all", () => {
    expect(bootstrapReplay(null, "nothing.json").error).toBeTruthy();
    expect(bootstrapReplay(42, "number.json").error).toBeTruthy();
  });

  it("renders something for a throw that is not an Error", () => {
    // The `String(err)` fallback: a non-Error throw must not surface as "undefined".
    const exploding = {
      get meta(): never {
        throw "kaboom";
      },
    };
    const result = bootstrapReplay(exploding, "odd.json");
    expect(result.replay).toBeNull();
    expect(result.error).toBe("kaboom");
  });
});
