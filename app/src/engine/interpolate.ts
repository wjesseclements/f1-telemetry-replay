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
 */
import type { Car, Replay } from "./schema";

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
 * The lap is a closed loop, so the segment leaving the last sample wraps back to the
 * first — the car keeps moving across the lap boundary instead of freezing for the
 * final grid step.
 */
export function sampleCarAt(
  car: Car,
  clock: number,
  sampleRateHz: number,
): CarSnapshot {
  const samples = car.samples;
  const n = samples.length;
  const t = wrapClock(clock, gridSpan(car, sampleRateHz));

  const idx = t * sampleRateHz;
  // `min` is a float guard only: t < span already implies floor(idx) <= n - 1,
  // except where floating-point rounding lands idx exactly on n.
  const i = Math.min(Math.floor(idx), n - 1);
  const j = (i + 1) % n;
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
 */
export function sampleAt(replay: Replay, clock: number): CarSnapshot[] {
  const { sampleRateHz } = replay.meta;
  return replay.cars.map((car) => sampleCarAt(car, clock, sampleRateHz));
}
