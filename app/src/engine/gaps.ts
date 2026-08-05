/**
 * gaps.ts — how far another car is from the focused car, in seconds and metres.
 *
 * WHAT A GAP IS HERE
 * ------------------
 * The broadcast definition: the interval between two cars crossing one point on the
 * circuit. For a car `C` and the focused car `F` at clock `now`,
 *
 *     seconds = now − t*                          ( > 0  ⇒  C is BEHIND F )
 *     metres  = travel_F(now) − travel_F(t*)      travel_F = ∫ speed_F dt / 3.6
 *
 * where `t*` is when `F` was at `C`'s current point. That much is unchanged since
 * Slice 9. What changed is how `t*` is found, and it is the whole of Slice 9d.
 *
 * ONE SHARED CIRCUIT, AND CUMULATIVE PROGRESS ALONG IT
 * ----------------------------------------------------
 * A circuit is a loop, so `F` passes every point once a lap and there are several
 * candidate `t*`. Slice 9 picked the one nearest `now` — "the shorter way round" — and
 * that is wrong for a full field, because a 19-car field spans most of a lap: measured
 * on 2024 Monza R (VER laps 20-22) the field covers **57.4 s of an 85.5 s lap**, so most
 * of the grid sits past ±half a lap and the shorter way round is the OTHER way round.
 * HUL, genuinely **+52.7 s behind**, was reported at **≈ −33 s** — its true gap's
 * complement about one lap (85.5 − 52.7 = 32.8).
 *
 * So the ambiguity is removed instead of folded:
 *
 *  1. **The reference geometry is ONE LAP of `cars[0]`**, not the whole window. On one
 *     lap an arc-position is in `[0, L)` and is unambiguous. (Measured the hard way:
 *     against the full three-lap path the nearest-segment search hops between laps and
 *     a car's "laps completed" over a three-lap window came back as **18.1**.)
 *     `buildScene` already takes the track ribbon from `cars[0]` on the same grounds —
 *     every car in a replay drives the same circuit, so one lap is the track.
 *  2. **Every car's arc-position is unwrapped into cumulative progress `P`**, once, at
 *     load: a lap counter ticks whenever the arc jumps back by more than `L/2`.
 *  3. **The field's lap offsets are seeded at `t = 0` by cutting the ring at its largest
 *     empty arc.** A field that does not wrap all the way round leaves a hole, and the
 *     hole is where the running order starts. Measured on the real file the hole is
 *     **0.30–0.39 lap** against a second-largest inter-car gap of **0.09–0.13** — a ~3×
 *     margin. See `seedMargin`.
 *  4. `t*` is then `P_F⁻¹(P_C(now))` — one answer, no candidates to choose between.
 *
 * SUPERSEDED CONVENTIONS, RECORDED RATHER THAN DELETED
 * ----------------------------------------------------
 *  - **"The reported gap is always the shorter way round — the standard convention."**
 *    Gone. It is standard for two cars within half a lap of each other and meaningless
 *    for a field that spans more than that. The gap is now the true cumulative one and
 *    may exceed half a lap, a whole lap, or several.
 *  - **"Cars share a clock but NOT a distance axis."** Superseded, and the distinction
 *    matters. That was true of each car's OWN travel integral, which has no common
 *    origin — VER covered 17408 m to LEC's 18190 m over the same window, from different
 *    starting points. Projecting every car onto ONE shared circuit **constructs** the
 *    common origin the old rule said did not exist. Slice 8's finding still holds where
 *    it was made (no cross-car SCALE term reaches the answer); what is gone is the
 *    conclusion that positions cannot be compared at all.
 *  - **"Lapped cars are NOT distinguished … this module never claims +1 lap."** Gone,
 *    and replaced by `Gap.lapsDown`. Cumulative progress is exactly the machinery that
 *    was missing. See the ruling under `seedMargin`.
 *
 * WHY METRES STILL DO NOT NEED A POSITION UNIT
 * --------------------------------------------
 * Unchanged from Slice 9 and still load-bearing. FastF1's X/Y are in an undocumented
 * 1/10 m and this module refuses to know that (Slice 6b's rule). Metres come from the
 * SPEED channel, whose unit the schema pins on both sides of the contract, integrated
 * over the gap. Position units appear in exactly one place — the residual bound — and
 * are converted through a ratio measured from the reference car's own data
 * (`unitsPerMetre`), never through a constant. Pinned by a test that scales every
 * coordinate by ten and expects bit-identical answers.
 *
 * THERE IS NO CROSS-FRAME STATE, WHICH IS THE ANSWER TO SEEKING
 * ------------------------------------------------------------
 * `P` is precomputed for every car across the whole window at load, so a query at any
 * clock is an O(1) interpolation into a `Float64Array`. A gap is a pure function of
 * `(replay, focus, car, clock)`. A backwards seek, a scrub, a window wrap, a focus
 * change and a replay swap therefore need no lifecycle at all — there is no accumulator
 * to drift or resynchronise, and arriving at a clock backwards gives bit-identical
 * answers to arriving at it forwards (pinned by test).
 *
 * `P` also does not depend on which car is focused, so changing focus is free; Slice 9
 * rebuilt a per-focus index at a measured 1.38 ms per change.
 *
 * ACCURACY, AND WHERE IT RUNS OUT
 * -------------------------------
 *  - **Cross-track error.** A car is projected onto the reference line, so along-track
 *    error grows with how far its line sits from that line. Measured across the whole
 *    real window, all 19 cars: p99 **136 units**, max **194**, against a bound of 251.
 *    `residualM` is returned so a caller can see it rather than trust it.
 *  - **`t*` is sub-grid** — the projection's fractional index — so the answer is
 *    continuous, not quantised to the sample rate.
 *  - **`null` is a real answer**, and the caller must render it as such: a point further
 *    off the reference than `MAX_RESIDUAL_M` (the pit lane, a spin, a stationary car), a
 *    car that never moved, or a gap so large that neither direction of the query lands
 *    inside the window.
 */
import type { Replay } from "./schema";

/**
 * km/h × s → m. The schema pins `meta.units.speed` to km/h on both sides of the
 * contract, so this is a unit conversion and not an assumption about the data.
 */
const KMH_S_PER_METRE = 3.6;

/**
 * How far off the reference line a car may sit and still be considered to be at a point
 * on it, in metres.
 *
 * Roughly a track width plus run-off: wide enough for a defensive line, an overtake
 * around the outside, or lap-to-lap variation, and narrow enough that the pit lane and a
 * car parked in a gravel trap read `null` instead of being snapped onto the racing line
 * and reported with confidence.
 */
export const MAX_RESIDUAL_M = 25;

/**
 * Shortest lap this module will believe, in seconds.
 *
 * The reference car's lap is found by looking for its return to its own start; anything
 * sooner than this is the car still leaving the same cell, not a lap. No F1 circuit is
 * close.
 */
const MIN_LAP_S = 5;

/**
 * How much larger the field's largest empty arc must be than the next largest before the
 * ring cut is trusted. See `ProgressIndex.seedMargin`.
 *
 * A field strung right round the circuit has no hole to cut at, and the "largest" gap is
 * then just the biggest ordinary interval between two cars — indistinguishable from
 * noise. Measured on a real 19-car field the true hole beats the runner-up by ~3×, so
 * 2 is a bound that is quiet on good data and fires before the cut becomes a guess.
 */
export const SEED_MARGIN_MIN = 2;

/** A gap between one car and the focused car, at one instant. */
export interface Gap {
  /** Seconds. Positive when the queried car is BEHIND the focused car. */
  seconds: number;
  /** Metres along the measured car's own travel. Same sign convention as `seconds`. */
  metres: number;
  /** How far the queried car sat off the reference line, in metres. */
  residualM: number;
  /**
   * Whole laps down, signed the same way as `seconds`: `+1` is a lap behind, `-1` a lap
   * ahead, `0` within the same lap.
   *
   * Always `0` when the window is shorter than a lap, because there is then no ring to
   * be lapped around (see `lapUnits`).
   */
  lapsDown: number;
}

/** Every car's cumulative progress around one shared circuit. Built once per replay. */
export interface ProgressIndex {
  /**
   * One lap of the reference circuit, in position units — `0` when the reference car
   * never returns to its start, i.e. the window is shorter than a lap.
   *
   * Zero is the "no ring" case and it disables exactly two things: the unwrap (there is
   * nothing to wrap around) and the lapped-car report (nobody can be a lap down inside
   * less than a lap). Everything else works unchanged.
   */
  readonly lapUnits: number;
  /**
   * One lap of the reference car, in seconds — `0` alongside a zero `lapUnits`.
   *
   * The time counterpart of `lapUnits`, and it exists for the same reason: a lookup that
   * lands outside the window is answered by walking whole laps of the focused car, which
   * needs both halves of "a lap" to stay consistent. See `timeAtProgress`.
   */
  readonly lapSeconds: number;
  /** Per car: metres covered over one `lapSeconds`, for the same whole-lap walk. */
  readonly lapMetres: readonly number[];
  readonly sampleRateHz: number;
  /** Per car: cumulative unwrapped progress at each sample, in position units. */
  readonly progress: readonly Float64Array[];
  /** Per car: distance off the reference line at each sample, in position units. */
  readonly residual: readonly Float64Array[];
  /** Per car: cumulative metres travelled, from that car's own speed channel. */
  readonly travelM: readonly Float64Array[];
  /** Position units per metre, measured from the reference car's own path and travel. */
  readonly unitsPerMetre: number;
  /** Per car: `true` when the car covered no ground, so it has no answers to give. */
  readonly degenerate: readonly boolean[];
  /**
   * How many times larger the field's largest empty arc is than the next largest, at
   * `t = 0` — the confidence in the ring cut that seeds every car's lap offset.
   *
   * **THE LAPPED-CAR RULING, and the assumption it rests on.** Lapping that HAPPENS
   * during the window is observed: `ΔP` crossing `L` is an ordinary reading of the
   * precomputed series. Lapping that PRE-DATES the window is **not derivable** — the
   * schema carries no lap counter, and from one instant's geometry "34 s ahead",
   * "51 s behind" and "137 s behind" are the same picture. So the seed assumes no car
   * starts a lap down, which is exactly the assumption the ring cut encodes: a field
   * that fits inside one lap leaves a hole, and the hole is where the order starts.
   *
   * When this falls below `SEED_MARGIN_MIN` the field may be strung right round and the
   * cut is a guess. It is a tripwire in the style of Slice 7's `closing_time`: the index
   * is still built and still usable, the seed degrades to "everyone within one lap of
   * the reference", and `seedTrustworthy` says so rather than the module pretending.
   * `Infinity` when there is no ring to cut, or fewer than three cars to cut between.
   */
  readonly seedMargin: number;
  /** `seedMargin >= SEED_MARGIN_MIN`. Read this rather than re-deriving the comparison. */
  readonly seedTrustworthy: boolean;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/** The reference circuit: one lap, with a spatial hash over its segments. */
interface RefPath {
  xs: Float64Array;
  ys: Float64Array;
  /** Cumulative arc length at each reference sample. */
  arc: Float64Array;
  cell: number;
  grid: Map<string, number[]>;
  /** Lap length in position units, or 0 when the reference never closes a lap. */
  lapUnits: number;
  /** Lap length in seconds, or 0 to match. */
  lapSeconds: number;
}

/**
 * Preprocess a replay so any gap between any two of its cars can be answered in O(1).
 *
 * O(cars × samples) once, at load. Everything expensive happens here: projecting each
 * car onto the reference circuit, unwrapping its arc-position into cumulative progress,
 * and integrating its travel.
 */
export function buildProgressIndex(replay: Replay): ProgressIndex {
  const sampleRateHz = replay.meta.sampleRateHz;
  const cars = replay.cars;
  const travelM = cars.map((car) => travelIntegral(car.samples, sampleRateHz));
  const degenerate = cars.map(
    (car, i) =>
      pathLength(car.samples) === 0 || travelM[i][travelM[i].length - 1] === 0,
  );

  // The metre bridge is measured FIRST, from the reference car's own path against its
  // own travel, because everything downstream needs it: `findLapEnd` wants to know what
  // "back where it started" means in position units, and it is not entitled to guess.
  const referenceMetres = travelM[0][travelM[0].length - 1];
  const unitsPerMetre =
    referenceMetres === 0 ? 0 : pathLength(cars[0].samples) / referenceMetres;
  // A reference car that never moved leaves nothing to project onto. Every car is then
  // unanswerable, which is a state this returns rather than an error it throws — a
  // window can legitimately contain a car sitting in its box (Slice 8). Checked BEFORE
  // the reference is built, so `buildReference` never sees a path it cannot measure.
  if (unitsPerMetre === 0 || cars[0].samples.length < 2) {
    const empty = cars.map(() => new Float64Array(cars[0].samples.length));
    return {
      lapUnits: 0,
      lapSeconds: 0,
      lapMetres: cars.map(() => 0),
      sampleRateHz,
      progress: empty,
      residual: empty,
      travelM,
      unitsPerMetre: 0,
      degenerate: cars.map(() => true),
      seedMargin: Infinity,
      seedTrustworthy: true,
    };
  }

  const sameSpot = MAX_RESIDUAL_M * unitsPerMetre;
  const reference = buildReference(replay, sameSpot);
  const raw = cars.map((car) => projectPath(reference, car.samples));

  const seed = seedLapOffsets(
    raw.map((r) => r.progress[0]),
    reference.lapUnits,
  );

  const progress = raw.map((r, i) => {
    const out = new Float64Array(r.progress.length);
    const shift = seed.offsets[i] - r.progress[0];
    for (let k = 0; k < out.length; k++) out[k] = r.progress[k] + shift;
    return out;
  });

  return {
    lapUnits: reference.lapUnits,
    lapSeconds: reference.lapSeconds,
    // Each car's OWN travel over one reference lap: the metres counterpart of walking a
    // lap in time, and per-car because they do not cover a lap at the same pace.
    lapMetres: travelM.map(
      (travel) => at(travel, reference.lapSeconds * sampleRateHz) - travel[0],
    ),
    sampleRateHz,
    progress,
    residual: raw.map((r) => r.residual),
    travelM,
    unitsPerMetre,
    degenerate,
    seedMargin: seed.margin,
    seedTrustworthy: seed.margin >= SEED_MARGIN_MIN,
  };
}

/** Trapezoid travel in metres, matching how the pipeline integrates it (Slice 6b). */
function travelIntegral(
  samples: Replay["cars"][number]["samples"],
  sampleRateHz: number,
): Float64Array {
  const dt = 1 / sampleRateHz;
  const out = new Float64Array(samples.length);
  for (let k = 1; k < samples.length; k++) {
    out[k] =
      out[k - 1] +
      (((samples[k - 1].speed + samples[k].speed) / 2) * dt) / KMH_S_PER_METRE;
  }
  return out;
}

function pathLength(samples: Replay["cars"][number]["samples"]): number {
  let total = 0;
  for (let k = 1; k < samples.length; k++) {
    total += Math.hypot(
      samples[k].x - samples[k - 1].x,
      samples[k].y - samples[k - 1].y,
    );
  }
  return total;
}

/**
 * The reference circuit: ONE lap of `cars[0]`, plus a spatial hash over its segments.
 *
 * One lap rather than the window is the load-bearing choice — see the file header. When
 * the reference car never returns to its start the whole path is used and `lapUnits` is
 * 0, which is the "no ring" case.
 */
function buildReference(replay: Replay, sameSpot: number): RefPath {
  const samples = replay.cars[0].samples;
  const n = samples.length;
  const allX = new Float64Array(n);
  const allY = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    allX[k] = samples[k].x;
    allY[k] = samples[k].y;
  }

  const lapEnd = findLapEnd(allX, allY, replay.meta.sampleRateHz, sameSpot);
  const count = lapEnd === null ? n : lapEnd + 1;

  const xs = allX.slice(0, count);
  const ys = allY.slice(0, count);
  const arc = new Float64Array(count);
  for (let k = 1; k < count; k++) {
    arc[k] = arc[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
  }

  const total = arc[count - 1];
  // `count` is at least 2: a shorter reference is caught by `buildProgressIndex`'s
  // `xs.length < 2` guard, which returns the all-unanswerable index before any of this
  // is used. Dividing by `count - 1` unconditionally keeps that fact in one place rather
  // than as a second, untestable guard here.
  const meanSegment = total / (count - 1);
  const cell = Math.max(meanSegment * 4, 1e-9);
  const grid = new Map<string, number[]>();
  const add = (x: number, y: number, segment: number): void => {
    const key = cellKey(Math.floor(x / cell), Math.floor(y / cell));
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [segment]);
    else if (bucket[bucket.length - 1] !== segment) bucket.push(segment);
  };
  for (let k = 0; k < count - 1; k++) {
    add(xs[k], ys[k], k);
    add(xs[k + 1], ys[k + 1], k);
  }

  return {
    xs,
    ys,
    arc,
    cell,
    grid,
    lapUnits: lapEnd === null ? 0 : total,
    lapSeconds: lapEnd === null ? 0 : lapEnd / replay.meta.sampleRateHz,
  };
}

/**
 * The sample at which the reference car has come back to where it started, or `null`.
 *
 * The ARGMIN of the return excursion, not its first sample. Slice 9's `measureLapPeriod`
 * deliberately took the first re-entry into the residual bound because it only ever used
 * the value as a half-width and erring narrow was safe. `lapUnits` is not a half-width:
 * it is the modulus the unwrap and the lapped-car test are written against, so it wants
 * to be right rather than conservative.
 */
function findLapEnd(
  xs: Float64Array,
  ys: Float64Array,
  sampleRateHz: number,
  sameSpot: number,
): number | null {
  const n = xs.length;
  const first = Math.ceil(MIN_LAP_S * sampleRateHz);

  let best: number | null = null;
  let bestDistance = Infinity;
  for (let k = first; k < n; k++) {
    const d = Math.hypot(xs[k] - xs[0], ys[k] - ys[0]);
    if (d > sameSpot) {
      // Left the neighbourhood again, so the excursion that produced `best` is over and
      // its closest point was the lap. Returning here rather than scanning on is what
      // makes this the FIRST return and not the closest of several laps' worth.
      if (best !== null) return best;
      continue;
    }
    if (d < bestDistance) {
      bestDistance = d;
      best = k;
    }
  }
  return best;
}

/** One car projected onto the reference: cumulative progress and residual per sample. */
function projectPath(
  reference: RefPath,
  samples: Replay["cars"][number]["samples"],
): { progress: Float64Array; residual: Float64Array } {
  const n = samples.length;
  const progress = new Float64Array(n);
  const residual = new Float64Array(n);
  const L = reference.lapUnits;

  let laps = 0;
  let previousArc: number | null = null;

  for (let k = 0; k < n; k++) {
    const hit = nearestArc(reference, samples[k].x, samples[k].y, previousArc);
    residual[k] = hit.distance;

    if (previousArc !== null && L > 0) {
      const step = hit.arc - previousArc;
      // A step longer than half the circuit is the lap boundary, not motion: no car
      // covers half a lap in a grid step, and the sign says which way it crossed.
      if (step < -L / 2) laps += 1;
      else if (step > L / 2) laps -= 1;
    }
    progress[k] = laps * L + hit.arc;
    previousArc = hit.arc;
  }

  return { progress, residual };
}

/**
 * The arc-position on the reference nearest a point. Strictly nearest.
 *
 * THE TOLERANCE HERE MUST BE ZERO, and getting that wrong is worth recording because it
 * looked reasonable and produced a plausible-but-frozen answer. A first version treated
 * candidates within `MAX_RESIDUAL_M` of the minimum as tied and broke the tie by
 * continuity with the previous sample. For a car running parallel to the reference — the
 * pit lane, or simply a different line down a straight — every segment for ±36 m is
 * within that band, so continuity always won and the arc STUCK, advancing in quantised
 * 8.5 m jumps instead of sliding. SAI's gap moved 4.6 → 9.8 → 16.6 → 2.7 s in three
 * ticks off the back of it.
 *
 * The seam does not need a tolerance either, which is what makes zero affordable: arc 0
 * and arc L are the same ground, and a projection that flips between them is turned back
 * into a continuous progress by the lap counter in `projectPath`, not by a tiebreak here.
 * Continuity survives only as an EXACT-tie rule, where it cannot freeze anything.
 */
function nearestArc(
  reference: RefPath,
  x: number,
  y: number,
  previousArc: number | null,
): { arc: number; distance: number } {
  const { xs, ys, arc, cell, grid, lapUnits } = reference;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);

  let bestArc = previousArc ?? 0;
  let bestDistance = Infinity;
  let bestPenalty = Infinity;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const bucket = grid.get(cellKey(cx + i, cy + j));
      if (bucket === undefined) continue;
      for (const k of bucket) {
        const ax = xs[k];
        const ay = ys[k];
        const dx = xs[k + 1] - ax;
        const dy = ys[k + 1] - ay;
        const lengthSq = dx * dx + dy * dy;
        // Clamped, so a point beyond either end projects onto that end rather than onto
        // the segment's infinite extension.
        const f =
          lengthSq > 0
            ? Math.min(
                1,
                Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSq),
              )
            : 0;
        const distance = Math.hypot(x - (ax + dx * f), y - (ay + dy * f));
        const here = arc[k] + f * (arc[k + 1] - arc[k]);

        if (distance < bestDistance) {
          bestDistance = distance;
          bestArc = here;
          bestPenalty =
            previousArc === null
              ? 0
              : circularDelta(here - previousArc, lapUnits);
        } else if (distance === bestDistance) {
          // An EXACT tie only — two places on the reference the same distance away.
          // Continuity picks the branch the car is actually on.
          const penalty =
            previousArc === null
              ? 0
              : circularDelta(here - previousArc, lapUnits);
          if (penalty < bestPenalty) {
            bestPenalty = penalty;
            bestArc = here;
          }
        }
      }
    }
  }

  return { arc: bestArc, distance: bestDistance };
}

/** Shortest signed distance around a ring of circumference `L`, as a magnitude. */
function circularDelta(delta: number, L: number): number {
  if (L <= 0) return Math.abs(delta);
  const wrapped = ((delta % L) + L) % L;
  return Math.min(wrapped, L - wrapped);
}

/**
 * Where each car's lap counter starts, by cutting the ring at the field's largest hole.
 *
 * The leader is the car just BEFORE the hole; everyone after it is behind by up to a
 * lap. See `ProgressIndex.seedMargin` for the ruling this encodes and its tripwire.
 */
function seedLapOffsets(
  arcs: readonly number[],
  lapUnits: number,
): { offsets: number[]; margin: number } {
  // No ring means no wrap to seed around; one car has no field to cut. Two is enough —
  // there are then two arcs and two holes between them, and the larger is the answer.
  if (lapUnits <= 0 || arcs.length === 0) {
    return { offsets: [...arcs], margin: Infinity };
  }

  const sorted = [...arcs].sort((a, b) => a - b);
  const holes = sorted.map((value, i) =>
    i === sorted.length - 1
      ? sorted[0] + lapUnits - value
      : sorted[i + 1] - value,
  );

  let widest = 0;
  for (let i = 1; i < holes.length; i++)
    if (holes[i] > holes[widest]) widest = i;
  const runnerUp = Math.max(
    ...holes.filter((_, i) => i !== widest),
    Number.MIN_VALUE,
  );

  const cut = sorted[widest];
  return {
    // A car past the cut has not yet reached the leader's point this lap, so it belongs
    // one lap back on the linearised axis.
    offsets: arcs.map((a) => (a > cut ? a - lapUnits : a)),
    margin: holes[widest] / runnerUp,
  };
}

/** A value interpolated within the grid step, clamped at both ends. */
function at(series: Float64Array, index: number): number {
  const n = series.length;
  const x = Math.min(n - 1, Math.max(0, index));
  const i = Math.floor(x);
  const j = Math.min(i + 1, n - 1);
  return series[i] + (series[j] - series[i]) * (x - i);
}

/** How many whole laps a lookup may be walked outside the window before giving up. */
const MAX_LAP_EXTENSION = 4;

/**
 * The time at which a car reached `target` progress, extending by whole laps if needed.
 *
 * Binary search inside the window, so O(log n). Progress is non-decreasing — a car does
 * not drive backwards — which is what makes the inverse well defined.
 *
 * WHY IT EXTENDS PAST THE WINDOW, AND WHY THE OBVIOUS ALTERNATIVE WAS WRONG
 * ------------------------------------------------------------------------
 * A car 57 s behind sits at a progress the focused car reached BEFORE the window opened,
 * so a plain inversion has no answer for the first 57 s — measured on the real 19-car
 * file that is 11.5 % of all readings unanswerable, and worst for exactly the cars this
 * slice exists to fix.
 *
 * The first fix was to fall back to the mirror-image question at the other end ("when
 * will THIS car reach where the focused car is now?"), which exists precisely where the
 * primary does not, and took the unanswerable rate to 0.0 %. **Real data refuted it.**
 * The two questions are only the same quantity if the pace between the two cars holds
 * over the interval, and a PIT STOP is exactly where it does not: on the real file SAI
 * and STR each cross the boundary mid-window and the readout jumped **19 s in one tick**
 * (STR 51.2 → 32.0 at t = 32 s) as the definition switched under it. That is the same
 * species of discontinuity this slice exists to remove, reintroduced by its own fix.
 *
 * So there is ONE definition, and the window is extended instead: the focused car passed
 * this ground one of its own laps earlier, so walk back a lap of its progress and a lap
 * of its time. The assumption is stated rather than hidden — that the focused car's lap
 * either side of the window resembles the one inside it — and it is anchored on that
 * car's OWN measured lap, not on an invented pace. Being wrong by the difference between
 * two of its laps (well under a second in a race) is a different order of error from
 * switching to a quantity that answers a different question.
 */
function timeAtProgress(
  index: ProgressIndex,
  car: number,
  target: number,
): number | null {
  const { lapUnits, lapSeconds, sampleRateHz } = index;
  const progress = index.progress[car];
  const n = progress.length;

  let shifted = target;
  let laps = 0;
  if (lapUnits > 0 && lapSeconds > 0) {
    while (shifted < progress[0] && laps < MAX_LAP_EXTENSION) {
      shifted += lapUnits;
      laps += 1;
    }
    while (shifted > progress[n - 1] && -laps < MAX_LAP_EXTENSION) {
      shifted -= lapUnits;
      laps -= 1;
    }
  }
  if (shifted < progress[0] || shifted > progress[n - 1]) return null;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (progress[mid] <= shifted) lo = mid;
    else hi = mid;
  }
  // A car standing still has a FLAT stretch of progress, so the inverse is a range
  // rather than a point and any answer inside it is equally true. The search settles on
  // the latest such sample; the gap is then ambiguous by up to the length of the stop,
  // which is a property of standing still and not of this lookup. Guarding the zero span
  // is what keeps it from being a NaN instead.
  const span = progress[hi] - progress[lo];
  const f = span === 0 ? 0 : (shifted - progress[lo]) / span;
  return (lo + f) / sampleRateHz - laps * lapSeconds;
}

/**
 * Metres travelled by a car at an arbitrary time, extended by whole laps to match
 * `timeAtProgress`.
 *
 * The seconds and the metres have to be measured over the SAME interval or they would
 * describe different gaps, so when `t*` lands outside the window this walks the travel
 * integral by the same whole laps.
 */
function travelAt(index: ProgressIndex, car: number, t: number): number {
  const { lapSeconds, sampleRateHz, lapMetres } = index;
  const travel = index.travelM[car];
  const span = (travel.length - 1) / sampleRateHz;

  let u = t;
  let shift = 0;
  if (lapSeconds > 0) {
    let steps = 0;
    while (u < 0 && steps < MAX_LAP_EXTENSION) {
      u += lapSeconds;
      shift -= lapMetres[car];
      steps += 1;
    }
    while (u > span && steps < MAX_LAP_EXTENSION) {
      u -= lapSeconds;
      shift += lapMetres[car];
      steps += 1;
    }
  }
  return at(travel, u * sampleRateHz) + shift;
}

/**
 * The gap between `carIndex` and `focusIndex` at `now`.
 *
 * `null` when the data has no answer: the car is further off the reference than
 * `MAX_RESIDUAL_M` (the pit lane, a spin), either car never moved, or the gap is larger
 * than the window can measure in either direction. Callers render that as an em dash —
 * never as a zero.
 *
 * O(1) in the sample count, plus one O(log n) inversion.
 */
export function gapTo(
  index: ProgressIndex,
  focusIndex: number,
  carIndex: number,
  now: number,
): Gap | null {
  const { progress, residual, sampleRateHz, unitsPerMetre } = index;
  if (index.degenerate[focusIndex] || index.degenerate[carIndex]) return null;

  const cursor = now * sampleRateHz;
  const residualM = at(residual[carIndex], cursor) / unitsPerMetre;
  if (!(residualM <= MAX_RESIDUAL_M)) return null;

  const carAt = at(progress[carIndex], cursor);
  const focusAt = at(progress[focusIndex], cursor);
  const deltaP = focusAt - carAt;

  // ONE definition throughout: when was the focused car at this car's current point?
  // Slice 9's, unchanged. `t*` may fall before the window starts or after it ends, and
  // `timeAtProgress` walks whole laps of `F` to reach it — see there.
  const past = timeAtProgress(index, focusIndex, carAt);
  if (past === null) return null;

  return {
    seconds: now - past,
    metres:
      travelAt(index, focusIndex, now) - travelAt(index, focusIndex, past),
    residualM,
    lapsDown: lapsOf(deltaP, index.lapUnits),
  };
}

/** Whole laps in a progress difference, signed like `seconds`. */
function lapsOf(deltaP: number, lapUnits: number): number {
  return lapUnits <= 0 ? 0 : Math.trunc(deltaP / lapUnits);
}
