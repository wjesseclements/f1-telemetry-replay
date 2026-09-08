import { describe, expect, it } from "vitest";
import type { StatusInterval } from "./schema";
import { statusAt, statusSegments } from "./trackStatus";

/**
 * The red-flag scenario's real shape: green, then yellow, then the Safety Car,
 * then red to the end of the window. Deliberately asymmetric spans.
 */
const INTERVALS: StatusInterval[] = [
  { status: "green", fromT: 0, toT: 182.2 },
  { status: "yellow", fromT: 182.2, toT: 198.7 },
  { status: "sc", fromT: 198.7, toT: 252.1 },
  { status: "red", fromT: 252.1, toT: 294.8 },
];

describe("statusAt", () => {
  it("answers the interval the clock is inside", () => {
    expect(statusAt(INTERVALS, 0)).toBe("green");
    expect(statusAt(INTERVALS, 100)).toBe("green");
    expect(statusAt(INTERVALS, 190)).toBe("yellow");
    expect(statusAt(INTERVALS, 200)).toBe("sc");
    expect(statusAt(INTERVALS, 260)).toBe("red");
  });

  it("gives the EARLIER interval the shared boundary instant", () => {
    // Closed intervals, first match wins: at a transition either answer is
    // defensible for one tick, and first-match makes the choice deterministic.
    expect(statusAt(INTERVALS, 182.2)).toBe("green");
    expect(statusAt(INTERVALS, 252.1)).toBe("sc");
  });

  it("still answers at exactly the final toT, where an open window's clock parks", () => {
    expect(statusAt(INTERVALS, 294.8)).toBe("red");
  });

  it("answers null outside the covered range", () => {
    expect(statusAt(INTERVALS, 294.9)).toBeNull();
    expect(statusAt(INTERVALS, -1)).toBeNull();
  });

  it("answers null for a gap between intervals — absence is not green", () => {
    const gappy: StatusInterval[] = [
      { status: "green", fromT: 0, toT: 10 },
      { status: "red", fromT: 20, toT: 30 },
    ];
    expect(statusAt(gappy, 15)).toBeNull();
  });

  it("answers null for a replay with no status data", () => {
    expect(statusAt([], 10)).toBeNull();
  });

  it("passes unknown through as a status, not an error", () => {
    expect(statusAt([{ status: "unknown", fromT: 0, toT: 5 }], 2)).toBe(
      "unknown",
    );
  });
});

describe("statusSegments", () => {
  it("converts intervals to duration-fractions", () => {
    const segments = statusSegments(
      [
        { status: "green", fromT: 0, toT: 25 },
        { status: "red", fromT: 25, toT: 100 },
      ],
      100,
    );
    expect(segments).toEqual([
      { status: "green", from: 0, to: 0.25 },
      { status: "red", from: 0.25, to: 1 },
    ]);
  });

  it("clamps an interval that runs past the duration", () => {
    // The schema pins intervals inside the replay, but this function keeps its
    // own "fractions in [0, 1]" promise rather than delegating it.
    const segments = statusSegments(
      [{ status: "yellow", fromT: 50, toT: 120 }],
      100,
    );
    expect(segments).toEqual([{ status: "yellow", from: 0.5, to: 1 }]);
  });

  it("drops a segment clamped to zero width", () => {
    expect(
      statusSegments([{ status: "red", fromT: 100, toT: 120 }], 100),
    ).toEqual([]);
  });

  it("answers nothing for an empty list or a degenerate duration", () => {
    expect(statusSegments([], 100)).toEqual([]);
    expect(statusSegments(INTERVALS, 0)).toEqual([]);
    expect(statusSegments(INTERVALS, -5)).toEqual([]);
    expect(statusSegments(INTERVALS, Number.NaN)).toEqual([]);
  });
});
