/**
 * Distance-to-pit-lane, probed against segments whose geometry is known in closed
 * form (the `gaps.test.ts` doctrine): interior projections, endpoint clamps, the
 * multi-polyline minimum, and the degenerate shapes the schema cannot reach but a
 * hand-written file can.
 */
import { describe, expect, it } from "vitest";
import { distanceToPitLane } from "./pitLane";
import type { Replay } from "./schema";

type Track = Replay["track"];

function trackWith(pitLane: Track["pitLane"]): Track {
  return { startFinish: { x: 0, y: 0, angle: 0 }, corners: [], pitLane };
}

const HORIZONTAL = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
];

describe("distanceToPitLane", () => {
  it("projects onto a segment's interior", () => {
    expect(distanceToPitLane(trackWith([HORIZONTAL]), 5, 4)).toBeCloseTo(4, 10);
  });

  it("clamps beyond either endpoint to the endpoint distance", () => {
    // 3-4-5 triangles past each end, so a wrong unclamped projection (which
    // would return 4) is distinguishable from the right answer.
    expect(distanceToPitLane(trackWith([HORIZONTAL]), -3, 4)).toBeCloseTo(
      5,
      10,
    );
    expect(distanceToPitLane(trackWith([HORIZONTAL]), 13, 4)).toBeCloseTo(
      5,
      10,
    );
  });

  it("takes the minimum across segments and across polylines", () => {
    const track = trackWith([
      [
        { x: 0, y: 100 },
        { x: 10, y: 100 },
      ],
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: -50 },
      ],
    ]);
    // Nearest is the second polyline's second segment (x=10 descending).
    expect(distanceToPitLane(track, 13, -20)).toBeCloseTo(3, 10);
    // Nearest is the first polyline.
    expect(distanceToPitLane(track, 5, 98)).toBeCloseTo(2, 10);
  });

  it("returns Infinity when the track carries no lane — every 'near?' is false", () => {
    expect(distanceToPitLane(trackWith([]), 0, 0)).toBe(Infinity);
  });

  it("treats a zero-length segment as its point rather than dividing by zero", () => {
    const track = trackWith([
      [
        { x: 3, y: 4 },
        { x: 3, y: 4 },
      ],
    ]);
    expect(distanceToPitLane(track, 0, 0)).toBeCloseTo(5, 10);
  });

  it("a single-point polyline (unreachable via the schema) contributes nothing", () => {
    const track = trackWith([[{ x: 0, y: 0 }] as never]);
    expect(distanceToPitLane(track, 1, 1)).toBe(Infinity);
  });
});
