/**
 * interpolate.ts — clock → car state, in O(1).
 *
 * Samples sit on a uniform time grid (the schema enforces it), so the active sample
 * is pure index arithmetic: `index = clock * sampleRateHz`. Nothing on the sampling
 * path scans, searches or remembers a cursor — that is CLAUDE.md architecture rule 3,
 * and it is what lets 20 cars be sampled every frame without the cost growing with
 * lap length. The one per-car pass, `headingHolds`, runs once per replay, before the
 * clock starts.
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
 * How much of a parked car's first motion its held heading is read over, in seconds
 * — see `headingHolds`. Exported for the tests.
 */
export const DEPARTURE_SECONDS = 1;

/**
 * Per sample, the heading a car stationary at that sample shows, in radians (the
 * `atan2` convention of `CarSnapshot.heading`). Build it once per car, per replay,
 * and pass it to `sampleCarAt`, which reads it only on a zero-length step.
 *
 *  - After the car's first move: the direction of the last segment that moved,
 *    ending at or before the sample — the way it arrived.
 *  - Up to its first move: the way it LEAVES — the chord from where it is parked to
 *    where it is `DEPARTURE_SECONDS` after it starts moving.
 *  - A car with no move anywhere in the replay: 0, world-east.
 *
 * WHY A PRECOMPUTED INDEX (Slice 23). The hold used to look back exactly one segment,
 * which covers a stop one grid step long and nothing longer: from the second
 * stationary step on, `atan2(0, 0)` swung the tick to due east. Every real stop is
 * longer than 0.1 s — the restart scenario spent 771 car-seconds that way, its whole
 * grid 63–90° off its line by 1:10, and LEC's red-flag wreck pointed east for two
 * minutes. Walking back to the last move at sample time would cost the length of the
 * stop, per car, per frame (rule 3); this costs one pass at load and one array read
 * after it. It holds the heading itself rather than the index of a segment so that
 * each policy below is decided here, once, and the frame path reads one number.
 *
 * WHY A LEADING STOP LOOKS FORWARD (Slice 23 follow-up, coordinator ruling). A car
 * parked from sample 0 — a grid slot, a pit box, a car stopped when the window opens
 * — has no move behind it, and this used to answer 0: world-east, a fact about the
 * replay's axes and not about the car. The same bug in its other case: the red-flag
 * window opens with all 22 cars parked, LAW for 7.0 s and ALO for 7.3 s, ticks up to
 * 87° off the way they then drove away — ~3.5 s of wall time at the scenario's 2x,
 * and indefinitely on its clock-0 landing frame for a reduced-motion user, who lands
 * paused. A parked car does not reverse: it leaves the way it is facing.
 *
 * WHY OVER A SECOND, NOT THE FIRST SEGMENT (measured — this extends the ruling, which
 * said the first moving segment). A car pulling away from rest makes its shortest,
 * noisiest segments first: position is quantised, and HAM's first "move" in that file
 * is one quantum BACKWARDS, so the literal rule turned his tick round, 175° off — worse
 * than the 85° of the east it replaced — with HUL, LIN and LEC 20–40° off. Over one
 * second of motion every leading stop in the gallery lands within 1° of the car's 2 s
 * departure: long enough that a quantum is noise, short enough that it has not turned
 * yet. Time, not distance, because the engine does not know the position unit (the
 * Slice 6b rule `gaps.ts` keeps). The way a car ARRIVES at a later stop is still read
 * off its last segment, as Slice 23 shipped it: the same noise is measurable there
 * (up to 22° off the car's 2 s arrival in the restart file, 34° in the rain file's
 * pit stops), smaller, and left for its own ruling rather than widened in here.
 *
 * Only segments `k - 1 -> k` count — never the closed lap's wrap segment, in either
 * direction — so one rule serves both loop modes, and nothing reaches round the lap.
 * What is left for 0 is a car with no move anywhere: it has no direction at all, and
 * inventing one would be worse than the axis.
 *
 * @throws {RangeError} if `sampleRateHz` is not a positive finite number — which is
 *         also what `cars.map(headingHolds)` hits on car 0, since `map` passes the
 *         array INDEX as the second argument; it would otherwise run, quietly wrong.
 */
export function headingHolds(car: Car, sampleRateHz: number): Float64Array {
  if (!(sampleRateHz > 0) || !Number.isFinite(sampleRateHz)) {
    throw new RangeError(
      `headingHolds needs a positive finite sampleRateHz, got ${sampleRateHz}`,
    );
  }
  const samples = car.samples;
  const n = samples.length;
  // Zero-filled: every entry a never-moving car will ever have.
  const held = new Float64Array(n);
  let first = -1;
  for (let k = 1; k < n; k++) {
    const a = samples[k - 1];
    const b = samples[k];
    if (a.x !== b.x || a.y !== b.y) {
      held[k] = Math.atan2(b.y - a.y, b.x - a.x);
      if (first < 0) first = k - 1;
    } else {
      held[k] = held[k - 1];
    }
  }
  if (first >= 0) {
    // Every sample up to the first move — read only where a leading stop leaves
    // them stationary — takes the departure chord.
    const span = Math.max(1, Math.round(DEPARTURE_SECONDS * sampleRateHz));
    const from = samples[first];
    const to = samples[Math.min(first + span, n - 1)];
    const departure =
      to.x !== from.x || to.y !== from.y
        ? Math.atan2(to.y - from.y, to.x - from.x)
        : // Back where it was parked a second later: the first move is all there is.
          held[first + 1];
    held.fill(departure, 0, first + 1);
  }
  return held;
}

/**
 * Heading of the segment leaving sample `i`, in radians.
 *
 * A zero-length segment (a stationary car — red flag, pit box, grid, or an open
 * window's held last step) has no direction of its own, so we hold the way the car
 * arrived — or, parked from the start, the way it leaves — rather than let
 * `atan2(0, 0)` snap the marker to due east. See `headingHolds` for where that comes
 * from and why it is precomputed.
 */
function headingAt(
  car: Car,
  holds: Float64Array,
  i: number,
  j: number,
): number {
  const samples = car.samples;
  const dx = samples[j].x - samples[i].x;
  const dy = samples[j].y - samples[i].y;
  return dx !== 0 || dy !== 0 ? Math.atan2(dy, dx) : holds[i];
}

/**
 * Sample one car at `clock`. O(1): two sample reads (plus one array read on a stop),
 * no scanning.
 *
 * @param loop `"closed"` — a lap: the segment leaving the last sample wraps back to
 *             the first, so the car keeps moving across the lap boundary instead of
 *             freezing for the final grid step. `"open"` — a session-time window:
 *             the last sample is held for that step, because there is nowhere for
 *             the car to be travelling to. Required, with no default, so that every
 *             call site states which kind of replay it means. See the file header.
 *
 * @param holds `headingHolds(car, sampleRateHz)`, built once per replay — never per
 *              call, which would put an O(samples) pass back on the frame path.
 *              Required for the same reason `loop` is: a caller without it has a
 *              stopped car pointing east, and nothing would say so.
 *
 * `clock` is wrapped in BOTH modes. An open replay still loops as a whole — the cut
 * at the window's end is the transport's, not this function's — so there is exactly
 * one definition of "past the end comes round to the start".
 *
 * @throws {RangeError} if `holds` was not built from a car of this length — the one
 *         sign of an index from some other replay that O(1) can see.
 */
export function sampleCarAt(
  car: Car,
  clock: number,
  sampleRateHz: number,
  loop: LoopMode,
  holds: Float64Array,
): CarSnapshot {
  const samples = car.samples;
  const n = samples.length;
  if (holds.length !== n) {
    throw new RangeError(
      `heading holds cover ${holds.length} samples, ${car.driver} has ${n}`,
    );
  }
  const t = wrapClock(clock, gridSpan(car, sampleRateHz));

  const idx = t * sampleRateHz;
  // `min` is a float guard only: t < span already implies floor(idx) <= n - 1,
  // except where floating-point rounding lands idx exactly on n.
  const i = Math.min(Math.floor(idx), n - 1);
  // Open: hold the last sample. `lerp(a, a, f)` is `a` for every channel, and a
  // held step is a zero-length segment, which `headingAt` answers from `holds` —
  // so the marker keeps pointing the way it was travelling rather than snapping
  // east, however long the car had been parked when the window ended.
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
    heading: headingAt(car, holds, i, j),
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
 *
 * @param holds `headingHolds` for every car, in `replay.cars` order — built once per
 *              replay with the rest of its static scene (`render/scene.ts`).
 * @throws {RangeError} if `holds` does not have exactly one entry per car.
 */
export function sampleAt(
  replay: Replay,
  clock: number,
  holds: readonly Float64Array[],
): CarSnapshot[] {
  const { sampleRateHz, loop } = replay.meta;
  if (holds.length !== replay.cars.length) {
    throw new RangeError(
      `heading holds cover ${holds.length} cars, the replay has ${replay.cars.length}`,
    );
  }
  return replay.cars.map((car, c) =>
    sampleCarAt(car, clock, sampleRateHz, loop, holds[c]),
  );
}
