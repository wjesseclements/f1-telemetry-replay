/**
 * TrailPainter tests — the append-only contract, asserted directly.
 *
 * The integration guards in `TrackCanvas.test.tsx` prove the trail is right on a real
 * lap; these prove the mechanism underneath is right for reasons, including the two
 * cases a lap is slow to reach (a backwards jump, and a rebuild landing mid-lap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPEED_BUCKETS, bucketColor } from "../engine/color";
import {
  installCanvasEnvironment,
  type DrawCall,
  type RecordingContext,
} from "../test/canvas";
import { TRAIL_WIDTH, TrailPainter } from "./trail";

/** Six samples on a straight line at x = 0, 10, 20, …, so segments are identifiable. */
const SCREEN = Float64Array.from([0, 0, 10, 0, 20, 0, 30, 0, 40, 0, 50, 0]);
/** Segment k's bucket. Deliberately revisits bucket 1 so batching is exercised. */
const BUCKETS = Uint8Array.from([1, 3, 1, 5, 3, 5]);

let recording: RecordingContext;

const painter = () => new TrailPainter(SCREEN, BUCKETS);

/** Trail strokes in the recording, newest paint pass last. */
const trailStrokes = (calls: readonly DrawCall[]): DrawCall[] =>
  calls.filter(
    (c) => c.method === "stroke" && c.lineWidth === TRAIL_WIDTH && c.path,
  );

/** Every segment currently held, keyed by the colour it will be stroked in. */
function painted(p: TrailPainter): Map<string, number[]> {
  recording.calls.length = 0;
  p.stroke(recording.ctx);
  const out = new Map<string, number[]>();
  for (const call of trailStrokes(recording.calls)) {
    const xs = call.path!.segments().map((s) => s.from.x);
    if (xs.length > 0) out.set(call.strokeStyle, xs);
  }
  return out;
}

const totalSegments = (p: TrailPainter): number =>
  [...painted(p).values()].reduce((n, xs) => n + xs.length, 0);

beforeEach(() => {
  recording = installCanvasEnvironment(800, 600);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TrailPainter", () => {
  it("starts empty", () => {
    const p = painter();
    expect(p.covered).toBe(0);
    expect(totalSegments(p)).toBe(0);
  });

  it("appends one segment per sample crossed, into that segment's bucket", () => {
    const p = painter();
    p.syncTo(3);

    expect(p.covered).toBe(3);
    // Segments 0,1,2 → buckets 1,3,1. Bucket 1 batches two of them in one path.
    expect(painted(p)).toEqual(
      new Map([
        [bucketColor(1), [0, 20]],
        [bucketColor(3), [10]],
      ]),
    );
  });

  it("strokes every bucket, so the batch count never grows with lap length", () => {
    const p = painter();
    p.syncTo(5);
    recording.calls.length = 0;
    p.stroke(recording.ctx);
    expect(trailStrokes(recording.calls)).toHaveLength(SPEED_BUCKETS);
  });

  it("allocates nothing when advancing — that is the whole point", () => {
    const p = painter();
    const built = recording.pathsBuilt();
    for (let i = 0; i <= 5; i++) p.syncTo(i);
    // Includes the many syncTo calls that cross no sample at all.
    for (let i = 0; i < 50; i++) p.syncTo(5);
    expect(recording.pathsBuilt()).toBe(built);
    expect(totalSegments(p)).toBe(5);
  });

  it("is idempotent when the clock has not crossed a sample", () => {
    const p = painter();
    p.syncTo(2);
    const before = painted(p);
    p.syncTo(2);
    expect(painted(p)).toEqual(before);
  });

  it("rebuilds on a backwards jump, because a Path2D cannot be un-drawn", () => {
    const p = painter();
    p.syncTo(5);
    const built = recording.pathsBuilt();

    p.syncTo(2);

    expect(recording.pathsBuilt()).toBe(built + SPEED_BUCKETS);
    expect(p.covered).toBe(2);
    // Refilled forward to exactly the new position — segments 0 and 1 only.
    expect(painted(p)).toEqual(
      new Map([
        [bucketColor(1), [0]],
        [bucketColor(3), [10]],
      ]),
    );
  });

  it("resets to empty when the clock wraps to the start of the lap", () => {
    const p = painter();
    p.syncTo(5);
    p.syncTo(0);
    expect(p.covered).toBe(0);
    expect(totalSegments(p)).toBe(0);
  });

  it("draws the head segment from the last sample to the car, in its bucket", () => {
    const p = painter();
    p.syncTo(2);
    recording.calls.length = 0;
    p.strokeHead(recording.ctx, 2, 24, 7);

    const [beginPath, moveTo, lineTo, stroke] = recording.calls;
    expect(beginPath.method).toBe("beginPath");
    expect(moveTo).toMatchObject({ method: "moveTo", args: [20, 0] });
    expect(lineTo).toMatchObject({ method: "lineTo", args: [24, 7] });
    // Bucket of the segment LEAVING sample 2, not the one arriving at it.
    expect(stroke).toMatchObject({
      method: "stroke",
      strokeStyle: bucketColor(BUCKETS[2]),
      lineWidth: TRAIL_WIDTH,
    });
  });

  it("keeps the head segment out of the retained paths", () => {
    // Appending it would smear a fan of stale stubs across the trail, one per frame.
    const p = painter();
    p.syncTo(2);
    for (let i = 0; i < 20; i++) p.strokeHead(recording.ctx, 2, 20 + i, i);
    expect(totalSegments(p)).toBe(2);
  });
});
