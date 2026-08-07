/**
 * TrailPainter tests — the append-only contract, asserted directly.
 *
 * The integration guards in `TrackCanvas.test.tsx` prove the trail is right on a real
 * lap; these prove the mechanism underneath is right for reasons, including the two
 * cases a lap is slow to reach (a backwards jump, and a rebuild landing mid-lap).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMET_BUCKETS,
  SPEED_BUCKETS,
  bucketColor,
  bucketOf,
} from "../engine/color";
import {
  installCanvasEnvironment,
  type DrawCall,
  type RecordingContext,
} from "../test/canvas";
import {
  COMET_BANDS,
  COMET_SECONDS,
  COMET_WIDTH,
  CometPainter,
  TAIL_BANDS,
  TAIL_SECONDS,
  TAIL_WIDTH,
  TRAIL_WIDTH,
  TailPainter,
  TrailPainter,
} from "./trail";

/**
 * The two resolutions, spelled out at every call site.
 *
 * `bucketColor` takes the count because the trail and the comet sample ONE ramp at two
 * resolutions (Slice 9c); an index means nothing without the count that produced it, so
 * these two helpers exist to make a test that mixed them up read wrong rather than pass.
 */
const trailColor = (b: number): string => bucketColor(b, SPEED_BUCKETS);
const cometColor = (b: number): string => bucketColor(b, COMET_BUCKETS);

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
        [trailColor(1), [0, 20]],
        [trailColor(3), [10]],
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
        [trailColor(1), [0]],
        [trailColor(3), [10]],
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
      strokeStyle: trailColor(BUCKETS[2]),
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

/**
 * The focus ratio, pinned as a number rather than left to the eye.
 *
 * Both lengths are eyeball-tuned constants, so neither value is asserted — what is
 * asserted is the RELATIONSHIP the tuning exists to produce. The focused car is
 * marked entirely by subtraction from the others (Slice 9: no selection ring), so
 * how long its history runs against everyone else's is the only signal on the canvas
 * saying which car is focused. At 1.5 s against 2 s that was 1.3× and unreadable;
 * shortening the tail to 0.5 s made it 4×. Anyone re-tuning either constant has to
 * keep the gap wide enough to see.
 */
describe("the focused car reads as focused from length alone", () => {
  it("gives the comet a clear multiple of an unfocused tail", () => {
    expect(TAIL_SECONDS).toBeLessThan(COMET_SECONDS);
    expect(COMET_SECONDS / TAIL_SECONDS).toBeGreaterThanOrEqual(3);
  });

  it("still leaves the tail long enough to fill every fade band", () => {
    // At 10 Hz, 0.5 s is 5 segments across 4 bands. Drop below one segment per band
    // and the fade stops being a fade — bands would render empty from the back.
    expect(TAIL_SECONDS * 10).toBeGreaterThanOrEqual(TAIL_BANDS);
  });
});

/**
 * CometPainter tests — the BOUND, and the thermal ramp it may not distort.
 *
 * The comet exists because a covered-portion trail is defined relative to a lap and an
 * open window is not one. So the two things worth pinning are that its cost does not
 * track window length (the property whose absence caused the defect) and that the
 * colour at the head still reads as speed (the thing the fix may not trade away).
 */
describe("CometPainter", () => {
  /** Forty samples on a straight line at x = 0, 10, 20, … */
  const LONG = Float64Array.from(
    Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? (i / 2) * 10 : 0)),
  );
  /** Cycles through three buckets so batching has something to batch. */
  const BUCKETS = Uint8Array.from({ length: 40 }, (_, k) => [1, 4, 7][k % 3]);

  const comet = (length = 12) => new CometPainter(LONG, BUCKETS, length);

  const cometStrokes = (calls: readonly DrawCall[]): DrawCall[] =>
    calls.filter((c) => c.method === "stroke" && c.lineWidth === COMET_WIDTH);

  const points = (calls: readonly DrawCall[]): number[][] =>
    calls
      .filter((c) => c.method === "moveTo" || c.method === "lineTo")
      .map((c) => c.args);

  it("never exceeds one stroke per segment plus the head, however deep in", () => {
    // The whole point: a 7-lap window must cost what a 1-lap window costs.
    //
    // The bound is the SEGMENT COUNT, not `COMET_BANDS × buckets`. Slice 9c raised the
    // comet's resolution to 32 buckets, at which the old bound (128) is satisfied by
    // anything at all — the guard would have survived the slice while measuring
    // nothing. A band only strokes buckets it actually contains, so summed over the
    // bands that is at most one stroke per segment, plus the head.
    for (const index of [0, 1, 12, 25, 39]) {
      recording.calls.length = 0;
      comet().paint(recording.ctx, index, 999, 5);
      const span = Math.min(index, 12);
      expect(cometStrokes(recording.calls).length).toBeLessThanOrEqual(
        span + 1,
      );
    }
  });

  it("costs the same deep into a window as it does early", () => {
    recording.calls.length = 0;
    comet().paint(recording.ctx, 13, 135, 0);
    const early = cometStrokes(recording.calls).length;

    recording.calls.length = 0;
    comet().paint(recording.ctx, 39, 395, 0);
    expect(cometStrokes(recording.calls).length).toBe(early);
  });

  it("strokes only buckets a band actually contains, not all 32", () => {
    // The flag array is what makes the bound one-per-segment rather than one-per-bucket,
    // and it matters more at 32 buckets than it did at nine: this fixture uses three.
    recording.calls.length = 0;
    comet().paint(recording.ctx, 25, 255, 0);
    const used = new Set(
      cometStrokes(recording.calls).map((c) => c.strokeStyle),
    );
    expect(used).toEqual(
      new Set([cometColor(1), cometColor(4), cometColor(7)]),
    );
  });

  /**
   * The other side of the bound: proof the finer key actually reaches the canvas.
   *
   * A tighter bound alone is satisfiable by the change silently not working — a comet
   * still quantised to nine colours passes every assertion above. So this drives a
   * braking sweep across the whole ramp, the case Slice 9c was filed for, and asserts
   * the comet resolves it into MORE distinct colours than the circuit trail could.
   */
  it("resolves a braking sweep past what the trail's nine buckets could", () => {
    // 21 samples ramping 315 → 108 km/h, the hardest 2 s in the endgame file.
    const speeds = Array.from({ length: 21 }, (_, k) => 315 - (207 * k) / 20);
    const fine = Uint8Array.from(speeds, (v) => bucketOf(v, COMET_BUCKETS));
    const coarse = new Set(speeds.map((v) => bucketOf(v, SPEED_BUCKETS)));

    recording.calls.length = 0;
    new CometPainter(LONG, fine, 20).paint(recording.ctx, 20, 205, 0);
    const colors = new Set(
      cometStrokes(recording.calls).map((c) => c.strokeStyle),
    );

    // Measured on the real file: 9 buckets give 8 distinct colours over this sweep,
    // 32 give 19. The bound holds at the same time — this is not more strokes than
    // there are segments, it is the same strokes carrying more of the ramp.
    expect(colors.size).toBeGreaterThan(coarse.size);
    expect(colors.size).toBeGreaterThan(SPEED_BUCKETS);
    expect(cometStrokes(recording.calls).length).toBeLessThanOrEqual(21);
  });

  it("reaches back exactly `length` segments and no further", () => {
    comet(12).paint(recording.ctx, 30, 305, 3);
    const xs = points(recording.calls).map((p) => p[0]);
    expect(Math.min(...xs)).toBe(180); // sample 18
    expect(xs).not.toContain(170);
  });

  it("clamps at the start of the data rather than wrapping", () => {
    // An open window's samples do not continue across the loop point, so a comet that
    // reached back there would draw a chord the car never travelled.
    comet(12).paint(recording.ctx, 3, 35, 1);
    expect(Math.min(...points(recording.calls).map((p) => p[0]))).toBe(0);
  });

  it("ends at the car itself, in the bucket of the sample it is leaving", () => {
    recording.calls.length = 0;
    comet().paint(recording.ctx, 20, 203.5, 4.5);
    const drawn = points(recording.calls);
    expect(drawn[drawn.length - 1]).toEqual([203.5, 4.5]);
    // The head stroke carries sample 20's bucket, exactly as `strokeHead` does.
    const strokes = cometStrokes(recording.calls);
    expect(strokes[strokes.length - 1].strokeStyle).toBe(
      cometColor(BUCKETS[20]),
    );
  });

  it("leaves the NEWEST band fully opaque, so the ramp reads true at the head", () => {
    // The comet's colour is a bucket times an alpha, and the ramp's legibility is the
    // one thing Slice 9b may not trade away. The fade only dims what is behind.
    comet().paint(recording.ctx, 25, 255, 0);
    const alphas = cometStrokes(recording.calls).map((s) => s.globalAlpha);
    expect(Math.max(...alphas)).toBe(1);
    expect(Math.min(...alphas)).toBeLessThan(1);
    expect(alphas).toEqual([...alphas].sort((a, b) => a - b));
    // The fade is still quantised into BANDS, not one alpha per stroke. Worth pinning
    // now that the colour key is fine enough for strokes to run nearly one per segment:
    // stroke count and band count are no longer close, and could be confused.
    expect(new Set(alphas).size).toBeLessThanOrEqual(COMET_BANDS);
  });

  it("leaves the context opaque for whatever is drawn next", () => {
    // Asserts the SEAM, and deliberately does not claim to test the restore line:
    // the newest band is 1.0, so the context is already opaque when the loop ends and
    // deleting that line passes this test. What it does catch is a ramp change that
    // ends below 1 without a restore — which is the failure that would actually show,
    // as translucent corner badges. See the comment at the line itself.
    comet().paint(recording.ctx, 25, 255, 0);
    expect(recording.ctx.globalAlpha).toBe(1);
  });

  it("allocates no Path2D at all, at any index", () => {
    // This is what makes a backwards seek free: there is no retained path to rebuild.
    const before = recording.pathsBuilt();
    const c = comet();
    for (let i = 39; i >= 0; i--) c.paint(recording.ctx, i, i * 10 + 5, 0);
    expect(recording.pathsBuilt()).toBe(before);
  });

  it("draws the same thing whether the index was reached forwards or backwards", () => {
    // A CometPainter has no state, so a seek cannot leave it stale — the property
    // `TrailPainter` needs a rebuild to achieve.
    const forwards = comet();
    for (let i = 0; i <= 25; i++)
      forwards.paint(recording.ctx, i, i * 10 + 5, 0);
    recording.calls.length = 0;
    forwards.paint(recording.ctx, 25, 255, 0);
    const afterForwards = JSON.stringify(recording.calls);

    const backwards = comet();
    backwards.paint(recording.ctx, 39, 395, 0);
    recording.calls.length = 0;
    backwards.paint(recording.ctx, 25, 255, 0);
    expect(JSON.stringify(recording.calls)).toBe(afterForwards);
  });
});
