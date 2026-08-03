/**
 * Format tests — the exact strings the HUD and the scrubber's `aria-valuetext` show.
 *
 * Asserted as literals rather than recomputed from the implementation, so a padding or
 * rounding change fails here instead of quietly altering what a screen reader announces.
 */
import { describe, expect, it } from "vitest";
import {
  NO_VALUE,
  formatGapMetres,
  formatGapSeconds,
  formatGear,
  formatLapTime,
  formatSpeed,
  pedalFraction,
} from "./format";

describe("formatLapTime", () => {
  it("writes m:ss.mmm", () => {
    expect(formatLapTime(0)).toBe("0:00.000");
    expect(formatLapTime(12.4)).toBe("0:12.400");
    expect(formatLapTime(62.5)).toBe("1:02.500");
    expect(formatLapTime(58.5)).toBe("0:58.500");
  });

  it("pads seconds and milliseconds but not minutes", () => {
    expect(formatLapTime(3.007)).toBe("0:03.007");
    expect(formatLapTime(600)).toBe("10:00.000");
  });

  it("truncates rather than rounds, so the clock never reads ahead of itself", () => {
    // 12.9999 s is still 12.999, not 13.000 — a HUD that rounded up would show a lap
    // time the car has not reached.
    expect(formatLapTime(12.9999)).toBe("0:12.999");
    expect(formatLapTime(59.9999)).toBe("0:59.999");
  });

  it("clamps nonsense to zero instead of rendering NaN", () => {
    expect(formatLapTime(-1)).toBe("0:00.000");
    expect(formatLapTime(NaN)).toBe("0:00.000");
    expect(formatLapTime(Infinity)).toBe("0:00.000");
  });
});

describe("formatSpeed", () => {
  it("rounds to whole km/h", () => {
    expect(formatSpeed(199.4)).toBe(199);
    expect(formatSpeed(199.5)).toBe(200);
    expect(formatSpeed(0)).toBe(0);
  });

  it("never goes negative or NaN", () => {
    expect(formatSpeed(-3)).toBe(0);
    expect(formatSpeed(NaN)).toBe(0);
  });
});

describe("formatGear", () => {
  it("shows N for neutral and the number otherwise", () => {
    expect(formatGear(0)).toBe("N");
    for (let g = 1; g <= 8; g++) expect(formatGear(g)).toBe(String(g));
  });
});

describe("pedalFraction", () => {
  it("maps 0-100 percent onto 0-1", () => {
    expect(pedalFraction(0)).toBe(0);
    expect(pedalFraction(50)).toBe(0.5);
    expect(pedalFraction(100)).toBe(1);
  });

  it("clamps out-of-range input rather than overflowing a bar", () => {
    expect(pedalFraction(120)).toBe(1);
    expect(pedalFraction(-10)).toBe(0);
    expect(pedalFraction(NaN)).toBe(0);
  });
});

describe("formatGapSeconds", () => {
  it("marks a car behind with + and a car ahead with -", () => {
    expect(formatGapSeconds(0.912)).toBe("+0.912");
    expect(formatGapSeconds(-9.3)).toBe("-9.300");
  });

  it("keeps three decimals, which is the resolution the projection has", () => {
    expect(formatGapSeconds(0.7227)).toBe("+0.723");
    expect(formatGapSeconds(0)).toBe("+0.000");
  });

  it("renders an unknown gap as an em dash, never as zero", () => {
    // A zero would read as "alongside", which is the one thing it does not mean.
    expect(formatGapSeconds(null)).toBe(NO_VALUE);
    expect(formatGapSeconds(NaN)).toBe(NO_VALUE);
    expect(formatGapSeconds(Infinity)).toBe(NO_VALUE);
  });
});

describe("formatGapMetres", () => {
  it("rounds to whole metres and drops the sign the seconds already carry", () => {
    expect(formatGapMetres(79.14)).toBe("79 m");
    expect(formatGapMetres(-782.4)).toBe("782 m");
  });

  it("renders an unknown gap as an em dash", () => {
    expect(formatGapMetres(null)).toBe(NO_VALUE);
    expect(formatGapMetres(NaN)).toBe(NO_VALUE);
  });
});
