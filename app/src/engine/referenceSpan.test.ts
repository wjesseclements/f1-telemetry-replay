/**
 * The reference lap as samples (Slice 24, consumer half): seconds to indices, and the
 * one index that does not exist. Three consumers read the span through this module —
 * the schema's closure check, the gap reference circuit and the track ribbon — so its
 * rule is pinned once, here, and each consumer's own tests pin what it does with it.
 */
import { describe, expect, it } from "vitest";
import { referenceSpan, spanSample } from "./referenceSpan";
import type { Sample } from "./schema";

const samples: Sample[] = [0, 1, 2, 3].map((k) => ({
  t: k / 10,
  x: 10 * k,
  y: -k,
  speed: 100,
  throttle: 50,
  brake: 0,
  gear: 4,
}));

describe("referenceSpan", () => {
  it("is the lap in sample indices of the named car", () => {
    expect(referenceSpan(10, { car: 2, fromT: 20, toT: 40.5 })).toEqual({
      car: 2,
      from: 200,
      to: 405,
    });
  });

  it("snaps a bound inside the schema's grid tolerance onto its sample", () => {
    // 2 ms either side of the grid — what GRID_TOLERANCE_S admits — and the float
    // noise of seconds that are not exact in binary (58.4 * 10 is 583.9999…).
    expect(referenceSpan(10, { car: 0, fromT: 20.002, toT: 58.4 })).toEqual({
      car: 0,
      from: 200,
      to: 584,
    });
  });
});

describe("spanSample", () => {
  it("is the sample itself anywhere inside the array", () => {
    expect(spanSample(samples, 0, "closed")).toBe(samples[0]);
    expect(spanSample(samples, 3, "open")).toBe(samples[3]);
  });

  it("wraps a closed lap past its last sample back to its first", () => {
    // Sample n is `toT = duration` on a closed file's `{0, 0, duration}`: the engine
    // has looped, so the lap's closing chord ends where it began.
    expect(spanSample(samples, 4, "closed")).toBe(samples[0]);
  });

  it("holds an open window's last sample past its end", () => {
    // An open window does not loop; at `duration` the engine holds the last fix.
    expect(spanSample(samples, 4, "open")).toBe(samples[3]);
  });
});
