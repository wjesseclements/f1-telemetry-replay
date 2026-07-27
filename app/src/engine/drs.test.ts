import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import { DRS_OPEN_CODES, carHasDrs, isDrsOpen } from "./drs";
import type { Car } from "./schema";

describe("isDrsOpen", () => {
  it("treats 10, 12 and 14 as open", () => {
    expect(DRS_OPEN_CODES).toEqual([10, 12, 14]);
    for (const code of [10, 12, 14]) {
      expect(isDrsOpen(code), `code ${code}`).toBe(true);
    }
  });

  it("treats every other observed code as closed", () => {
    for (const code of [0, 1, 2, 3, 8, 9, 11, 13, 15]) {
      expect(isDrsOpen(code), `code ${code}`).toBe(false);
    }
  });

  it("treats an absent channel as closed rather than throwing", () => {
    expect(isDrsOpen(undefined)).toBe(false);
  });
});

describe("carHasDrs", () => {
  const car = (): Car => parseReplay(sampleLap).cars[0];

  it("is true for a pre-2026 car carrying the channel", () => {
    const c = car();
    expect(c.samples[0].drs).toBeDefined();
    expect(carHasDrs(c)).toBe(true);
  });

  it("is false when the channel is absent (2026+ data)", () => {
    const c = car();
    const stripped: Car = {
      ...c,
      samples: c.samples.map((s) => {
        const withoutDrs = { ...s };
        delete withoutDrs.drs;
        return withoutDrs;
      }),
    };

    expect(carHasDrs(stripped)).toBe(false);
  });

  it("decodes the fixture's DRS zones into open and closed stretches", () => {
    const c = car();
    const open = c.samples.filter((s) => isDrsOpen(s.drs)).length;

    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(c.samples.length);
  });
});
