/**
 * interpolate.ts — clock → car state, in O(1).
 *
 * Samples sit on a uniform time grid (the schema enforces it), so the active sample
 * is pure index arithmetic: `index = clock * sampleRateHz`. Nothing here scans,
 * searches or remembers a cursor — that is CLAUDE.md architecture rule 3, and it is
 * what lets 20 cars be sampled every frame without the cost growing with lap length.
 *
 * Channels are resampled by type (rule 6): continuous channels are linearly
 * interpolated, discrete ones carry the leading sample's value forward.
 *
 * CLOSED AND OPEN REPLAYS
 * -----------------------
 * This file used to state, as a standing fact, that "a replay is a closed lap" —
 * the segment leaving the last sample ran back to sample 0. That is true of a lap
 * and false of a v2 race excerpt, which is a shared session-time WINDOW: several
 * cars over one stretch of a race, ending wherever the window ends. Twenty cars
 * cannot simultaneously return to their starting positions, so the window has no
 * cyclic step to interpolate across. `meta.loop` (see `schema.ts`) says which kind
 * of replay this is, because it is a fact about the data and nothing else can know
 * it; the alternative was a heuristic in here guessing the author's intent from the
 * size of the closing chord.
 *
 *  - `"closed"`: `j = (i + 1) % n`. The car keeps moving across the lap boundary.
 *  - `"open"`:   the last sample is HELD for the final grid step — position, speed
 *    and heading all stay put — instead of gliding back to where the window began.
 *
 * THE LOOP POINT IS A HARD CUT, AND THAT IS THE INTENDED BEHAVIOUR
 * ---------------------------------------------------------------
 * An open replay still LOOPS: the transport wraps its clock at `meta.duration`
 * exactly as before (`clock.ts` is untouched), so when the window ends every car
 * jumps back to its window-start position in a single frame and the trail painters
 * reset. That is video-loop semantics and it is deliberate — the cut is one frame
 * with no motion drawn across it.
 *
 * It is worth naming because it is easy to mistake for the bug it replaces. Without
 * the hold, the final grid step interpolates every car from where the window ends
 * to where it began: at 60fps and a 10 Hz grid that is SIX FRAMES of cars visibly
 * flying across the circuit, heading ticks aimed at the infield and thermal trails
 * streaking after them. A cut reads as a loop; a glide reads as a physics failure.
 * If you see motion at the loop point, open mode is not in effect.
 */
import type { Car, LoopMode, Replay } from "./schema";

/** A car's state at one instant. Positions are WORLD coordinates, pre-rotation. */
export interface CarSnapshot {
  /** Index of the leading sample — the segment start. Slice 4b's trail stops here. */
  index: number;
  /** The clock this snapshot is for, wrapped into the car's grid. Seconds. */
  t: number;
  x: number;
  y: number;
  /** Radians, `atan2` convention — the same one `track.startFinish.angle` uses. */
  heading: number;
  /** km/h, unrounded: rounding is the HUD's business, not the engine's. */
  speed: number;
  /** Percent, 0–100. */
  throttle: number;
  brake: 0 | 1;
  gear: number;
  /** Raw DRS code, or `undefined` when the replay carries no DRS channel. */
  drs: number | undefined;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/**
 * Fold a clock into `[0, span)`.
 *
 * Handles a clock past the end (playback looping) and a negative clock (seeking
 * backwards past zero), so callers never special-case either.
 *
 * A clock already in range is returned untouched. That is not just an optimisation:
 * `((c % span) + span) % span` adds and subtracts `span` from an in-range value and
 * loses low-order bits doing it — at 58.5 s it turns 0.3 into 0.29999999999999716,
 * which floors to index 2 instead of 3 and serves a stale gear for the whole step.
 *
 * @throws {RangeError} if `span` is not a positive, finite number.
 */
export function wrapClock(clock: number, span: number): number {
  if (!(span > 0) || !Number.isFinite(span)) {
    throw new RangeError(`wrapClock needs a positive finite span, got ${span}`);
  }
  if (clock >= 0 && clock < span) return clock;
  return ((clock % span) + span) % span;
}

/**
 * The length of a car's sample grid, in seconds.
 *
 * This — not `meta.duration` — is what indexing wraps on: it is derived from the
 * array actually being indexed, so the two can never drift apart. `meta.duration`
 * remains the transport's loop length (the scrubber's range). The schema's
 * uniform-grid refinement keeps them in agreement for conforming data.
 */
export function gridSpan(car: Car, sampleRateHz: number): number {
  return car.samples.length / sampleRateHz;
}

/**
 * Heading of the segment leaving sample `i`, in radians.
 *
 * A zero-length segment (a stationary car — red flag, pit box) has no direction of
 * its own, so we hold the previous segment's direction rather than let `atan2(0, 0)`
 * snap the marker to due east. The fallback deliberately does not wrap to the end of
 * the lap: at `i === 0` there is no established direction of travel yet, and 0 is the
 * honest answer.
 */
function headingAt(car: Car, i: number, j: number): number {
  const samples = car.samples;
  const dx = samples[j].x - samples[i].x;
  const dy = samples[j].y - samples[i].y;
  if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx);

  if (i === 0) return 0;
  const px = samples[i].x - samples[i - 1].x;
  const py = samples[i].y - samples[i - 1].y;
  if (px !== 0 || py !== 0) return Math.atan2(py, px);
  return 0;
}

/**
 * Sample one car at `clock`. O(1): two array reads, no scanning.
 *
 * @param loop `"closed"` — a lap: the segment leaving the last sample wraps back to
 *             the first, so the car keeps moving across the lap boundary instead of
 *             freezing for the final grid step. `"open"` — a session-time window:
 *             the last sample is held for that step, because there is nowhere for
 *             the car to be travelling to. Required, with no default, so that every
 *             call site states which kind of replay it means. See the file header.
 *
 * `clock` is wrapped in BOTH modes. An open replay still loops as a whole — the cut
 * at the window's end is the transport's, not this function's — so there is exactly
 * one definition of "past the end comes round to the start".
 */
export function sampleCarAt(
  car: Car,
  clock: number,
  sampleRateHz: number,
  loop: LoopMode,
): CarSnapshot {
  const samples = car.samples;
  const n = samples.length;
  const t = wrapClock(clock, gridSpan(car, sampleRateHz));

  const idx = t * sampleRateHz;
  // `min` is a float guard only: t < span already implies floor(idx) <= n - 1,
  // except where floating-point rounding lands idx exactly on n.
  const i = Math.min(Math.floor(idx), n - 1);
  // Open: hold the last sample. `lerp(a, a, f)` is `a` for every channel, and
  // `headingAt` already falls back to the previous segment on a zero-length step
  // (written in Slice 3 for a stationary car), so the marker keeps pointing the way
  // it was travelling rather than snapping east.
  const j = loop === "open" ? Math.min(i + 1, n - 1) : (i + 1) % n;
  const f = idx - i;

  const a = samples[i];
  const b = samples[j];

  return {
    index: i,
    t,
    // Continuous channels interpolate (rule 6).
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    speed: lerp(a.speed, b.speed, f),
    throttle: lerp(a.throttle, b.throttle, f),
    heading: headingAt(car, i, j),
    // Discrete channels forward-fill: they carry the leading sample's value for the
    // whole step and change in a single jump (rule 6).
    brake: a.brake,
    gear: a.gear,
    drs: a.drs,
  };
}

/**
 * Sample every car in the replay at `clock`.
 *
 * Always returns an array, one snapshot per car in `replay.cars` order — v1's single
 * car is just a length-1 array, and nothing downstream branches on the count
 * (rule 2). This is what the render loop calls once per frame.
 *
 * `meta.loop` applies to the replay, so every car gets the same mode: in a v2 window
 * the cars share one grid and therefore share its last step.
 */
export function sampleAt(replay: Replay, clock: number): CarSnapshot[] {
  const { sampleRateHz, loop } = replay.meta;
  return replay.cars.map((car) => sampleCarAt(car, clock, sampleRateHz, loop));
}
