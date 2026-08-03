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
import {
  TAIL_BANDS,
  TAIL_WIDTH,
  TRAIL_WIDTH,
  TailPainter,
  TrailPainter,
} from "./trail";

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

/**
 * TailPainter tests — the BOUND is the contract.
 *
 * A tail is redrawn every frame, which would be alarming if its cost tracked window
 * length. These assert that it does not: a fixed number of strokes, over a fixed
 * number of segments, however deep into a three-lap window the clock has reached.
 */
describe("TailPainter", () => {
  /** Twenty samples on a straight line at x = 0, 10, 20, … */
  const LONG = Float64Array.from(
    Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? (i / 2) * 10 : 0)),
  );
  const TEAM = "#ff8000";

  const tail = (length = 6) => new TailPainter(LONG, length);

  /** Every stroke a tail made, in order. */
  const tailStrokes = (calls: readonly DrawCall[]): DrawCall[] =>
    calls.filter((c) => c.method === "stroke" && c.lineWidth === TAIL_WIDTH);

  /** Every point the tail put on the canvas, in order. */
  const points = (calls: readonly DrawCall[]): number[][] =>
    calls
      .filter((c) => c.method === "moveTo" || c.method === "lineTo")
      .map((c) => c.args);

  it("never strokes more than once per band, whatever the sample index", () => {
    // The whole reason the fade is quantised: stroke count must not track length.
    // A tail shorter than the band count draws FEWER strokes, never more — empty
    // bands are skipped rather than stroked as degenerate points.
    for (const index of [0, 1, 6, 12, 19]) {
      recording.calls.length = 0;
      tail().stroke(recording.ctx, index, 999, 5, TEAM);
      expect(tailStrokes(recording.calls).length).toBeLessThanOrEqual(
        TAIL_BANDS,
      );
    }
  });

  it("uses every band once the tail is at full length", () => {
    tail(6).stroke(recording.ctx, 12, 125, 0, TEAM);
    expect(tailStrokes(recording.calls).length).toBe(TAIL_BANDS);
  });

  it("reaches back exactly `length` segments and no further", () => {
    tail(6).stroke(recording.ctx, 15, 155, 3, TEAM);
    const xs = points(recording.calls).map((p) => p[0]);
    // Sample 9 is the oldest point in a six-segment tail ending at sample 15.
    expect(Math.min(...xs)).toBe(90);
    expect(xs).not.toContain(80);
  });

  it("clamps at the start of the data instead of wrapping round the end", () => {
    // The trail resets at the line; a tail reaching backwards across the loop point
    // would be the one thing on the canvas claiming the replay is continuous there.
    tail(6).stroke(recording.ctx, 2, 25, 1, TEAM);
    const xs = points(recording.calls).map((p) => p[0]);
    expect(Math.min(...xs)).toBe(0);
  });

  it("ends at the car itself, not at the last whole sample", () => {
    tail().stroke(recording.ctx, 12, 123.5, 4.5, TEAM);
    const drawn = points(recording.calls);
    expect(drawn[drawn.length - 1]).toEqual([123.5, 4.5]);
  });

  it("draws the car's own colour", () => {
    tail().stroke(recording.ctx, 12, 125, 0, TEAM);
    for (const s of tailStrokes(recording.calls)) {
      expect(s.strokeStyle).toBe(TEAM);
    }
  });

  it("fades from faint at the back to strong at the head", () => {
    tail().stroke(recording.ctx, 12, 125, 0, TEAM);
    const alphas = tailStrokes(recording.calls).map((s) => s.globalAlpha);
    const last = alphas[alphas.length - 1];
    expect(alphas).toEqual([...alphas].sort((a, b) => a - b));
    expect(alphas[0]).toBeLessThan(last);
    expect(last).toBeLessThan(1);
  });

  it("restores full opacity, so the chrome drawn after it is not translucent", () => {
    tail().stroke(recording.ctx, 12, 125, 0, TEAM);
    expect(recording.ctx.globalAlpha).toBe(1);
  });

  it("allocates no Path2D at all — it paints straight onto the context", () => {
    const before = recording.pathsBuilt();
    const t = tail();
    for (let i = 6; i < 19; i++)
      t.stroke(recording.ctx, i, i * 10 + 5, 0, TEAM);
    expect(recording.pathsBuilt()).toBe(before);
  });

  it("still draws the head when the car has not left the first sample", () => {
    // At the start of a replay there is no tail yet, but the car is already off the
    // sample and the stub between the two is the only thing worth drawing.
    tail().stroke(recording.ctx, 0, 3, 1, TEAM);
    expect(tailStrokes(recording.calls).length).toBe(1);
    const drawn = points(recording.calls);
    expect(drawn[drawn.length - 1]).toEqual([3, 1]);
  });
});
