/**
 * gaps.ts — how far another car is from the focused car, in seconds and metres.
 *
 * WHAT A GAP IS HERE
 * ------------------
 * For a car `C` at clock `now`, project `C`'s current position onto the FOCUSED car's
 * own sampled path and read off the time `t*` at which the focused car `F` was at that
 * point:
 *
 *     seconds = now − t*                          ( > 0  ⇒  C is BEHIND F )
 *     metres  = travel_F(now) − travel_F(t*)      travel_F = ∫ speed_F dt / 3.6
 *
 * That is the broadcast definition — the interval between two cars crossing one point
 * on the circuit — and it is the only form the data actually supports.
 *
 * WHY NOT COMPARE THE CARS' DISTANCES
 * -----------------------------------
 * Cars share a clock but NOT a distance axis. Over one real window (2024 Monza R, VER
 * laps 20-22) VER covered 17408 m to LEC's 18190 m: two different numbers measured
 * from two different starting points on the circuit, with no common origin to subtract
 * against. This computation never puts them in the same expression. Only `F`'s path
 * and `F`'s own travel integral are read; `C` contributes a single point. There is no
 * cross-car scale term, which is the corrected model Slice 8 handed forward after its
 * per-car "unit bridge" turned out to cancel out of the pipeline's placement entirely.
 *
 * WHY METRES DO NOT NEED A POSITION UNIT
 * --------------------------------------
 * FastF1's X/Y are in an undocumented 1/10 m and this module refuses to know that
 * (Slice 6b's rule). Metres come from the SPEED channel, whose unit the schema pins on
 * both sides of the contract (`SPEED_UNIT`), integrated over the gap — the same bridge
 * Slice 8 used for `PARKED_TRAVEL_M`. Position units appear in exactly one place, the
 * residual bound, and they are converted through a ratio measured from this car's own
 * data (`unitsPerMetre`), never through a constant.
 *
 * ACCURACY, AND WHERE IT RUNS OUT
 * -------------------------------
 *  - **Cross-track error.** The query point is projected onto F's line, so along-track
 *    error grows with how far C's line sits from F's. Measured over a whole real window
 *    (LEC against NOR, 2607 samples): mean residual 0.09 m, max 16.4 m. `residualM` is
 *    returned so a caller can see it rather than trust it.
 *  - **Resampling.** Positions are placed by ∫speed·dt with per-car motion fidelity
 *    r = 0.9998–0.9999 (Slice 8), i.e. along-track timing error under 1 % of a grid step.
 *  - **`t*` is sub-grid**: it is the projection's fractional index, so the answer is
 *    continuous, not quantised to the sample rate.
 *  - **Nearest crossing wins.** A multi-lap window passes the same ground repeatedly, so
 *    candidates are filtered to within half a lap of `now` (`lapPeriod`, measured from
 *    the path itself). The reported gap is therefore always the shorter way round — the
 *    standard convention. Lapped cars are NOT distinguished: the schema carries no lap
 *    counter, so this module never claims "+1 lap".
 *  - **`null` is a real answer**, and the caller must render it as such. A car ahead has
 *    no gap near the END of a window (F never reaches its position); a car behind has
 *    none at the very start; a car in the pit lane or off at a corner is further from
 *    F's path than `MAX_RESIDUAL_M`. On the real Monza window that is 2.6 % of samples
 *    for the car 10 s up the road and 0.3 % for the car a second behind.
 */
import type { Car } from "./schema";

/**
 * km/h × s → m. The schema pins `meta.units.speed` to km/h on both sides of the
 * contract, so this is a unit conversion and not an assumption about the data.
 */
const KMH_S_PER_METRE = 3.6;

/**
 * How far off the focused car's path a query point may sit and still be considered to
 * be at a point on it, in metres.
 *
 * Roughly a track width plus run-off: wide enough for a defensive line, an overtake
 * around the outside, or a lap-to-lap variation, and narrow enough that the pit lane
 * and a car parked in a gravel trap read `null` instead of being snapped onto the
 * racing line and reported with confidence.
 */
export const MAX_RESIDUAL_M = 25;

/**
 * Shortest lap this module will believe, in seconds.
 *
 * `lapPeriod` looks for the next time the car passed its own position; anything sooner
 * than this is the car still leaving the same cell, not a lap. No F1 circuit is close.
 */
const MIN_LAP_S = 5;

/** A gap between one car and the focused car, at one instant. */
export interface Gap {
  /** Seconds. Positive when the queried car is BEHIND the focused car. */
  seconds: number;
  /** Metres along the focused car's own travel. Same sign convention as `seconds`. */
  metres: number;
  /** How far the query point sat off the focused car's path, in metres. */
  residualM: number;
}

/**
 * The focused car's path, preprocessed for O(1) gap queries.
 *
 * Built once per focused car — not per frame and not per query — and treated as an
 * immutable value: `gapTo` only reads it.
 */
export interface PathIndex {
  /** Cumulative metres travelled at each sample, from the speed channel. */
  readonly travelM: Float64Array;
  /** Position units per metre, measured from this car's own path and travel. */
  readonly unitsPerMetre: number;
  /**
   * Seconds between successive passes of the same point, or `Infinity` when the path
   * never revisits itself (a window shorter than a lap — nothing to disambiguate).
   */
  readonly lapPeriod: number;
  /** Sample grid rate, carried so a query can turn an index into a time. */
  readonly sampleRateHz: number;
  /** `true` when the car covered no ground at all, and every query is `null`. */
  readonly degenerate: boolean;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Cell size of the lookup grid, in position units. */
  readonly cell: number;
  /** Cell key → indices of the segments touching that cell. */
  readonly grid: ReadonlyMap<string, readonly number[]>;
}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * Preprocess a car's path so gaps against it can be answered in O(1).
 *
 * O(samples) once. The grid is a uniform spatial hash rather than a tree because the
 * points are samples of a smooth path at a near-constant spacing, which is the case a
 * hash handles best and a tree's balancing buys nothing for.
 */
export function buildPathIndex(car: Car, sampleRateHz: number): PathIndex {
  const samples = car.samples;
  const n = samples.length;
  const dt = 1 / sampleRateHz;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const travelM = new Float64Array(n);
  let pathUnits = 0;

  xs[0] = samples[0].x;
  ys[0] = samples[0].y;
  for (let k = 1; k < n; k++) {
    xs[k] = samples[k].x;
    ys[k] = samples[k].y;
    pathUnits += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
    // Trapezoid, matching how the pipeline integrates travel (Slice 6b).
    travelM[k] =
      travelM[k - 1] +
      (((samples[k - 1].speed + samples[k].speed) / 2) * dt) / KMH_S_PER_METRE;
  }

  const travelTotal = travelM[n - 1];
  // A car that never moved has no path to project onto and no travel to measure a
  // bridge with. That is ordinary data for a window (a car parked in its box — Slice
  // 8), so it is not an error; it just has no answers to give.
  if (pathUnits === 0 || travelTotal === 0) {
    return {
      travelM,
      unitsPerMetre: 0,
      lapPeriod: Infinity,
      sampleRateHz,
      degenerate: true,
      xs,
      ys,
      cell: 1,
      grid: new Map(),
    };
  }

  const unitsPerMetre = pathUnits / travelTotal;
  const meanSegment = pathUnits / (n - 1);
  // Big enough that a point up to `MAX_RESIDUAL_M` off the path is still found in the
  // 3×3 neighbourhood a query searches, and at least a couple of segments wide so a
  // long step cannot fall between cells.
  const cell = Math.max(2 * meanSegment, MAX_RESIDUAL_M * unitsPerMetre);

  const grid = new Map<string, number[]>();
  const add = (x: number, y: number, segment: number): void => {
    const key = cellKey(Math.floor(x / cell), Math.floor(y / cell));
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [segment]);
    // Segments arrive in order, so a repeat is always the last entry.
    else if (bucket[bucket.length - 1] !== segment) bucket.push(segment);
  };
  for (let k = 0; k < n - 1; k++) {
    add(xs[k], ys[k], k);
    add(xs[k + 1], ys[k + 1], k);
  }

  const index: PathIndex = {
    travelM,
    unitsPerMetre,
    lapPeriod: Infinity,
    sampleRateHz,
    degenerate: false,
    xs,
    ys,
    cell,
    grid,
  };
  return { ...index, lapPeriod: measureLapPeriod(index) };
}

/** One candidate point on the path: when the car was there, and how far off it is. */
interface Candidate {
  t: number;
  distance: number;
}

/** Project a query point onto every path segment near it. */
function candidatesNear(index: PathIndex, x: number, y: number): Candidate[] {
  const { cell, grid, xs, ys, sampleRateHz } = index;
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const out: Candidate[] = [];

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
        // Clamped, so a point beyond either end projects onto that end rather than
        // onto the segment's infinite extension.
        const f =
          lengthSq > 0
            ? Math.min(
                1,
                Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSq),
              )
            : 0;
        out.push({
          // Fractional index → time. This is what makes the answer continuous rather
          // than quantised to the sample grid.
          t: (k + f) / sampleRateHz,
          distance: Math.hypot(x - (ax + dx * f), y - (ay + dy * f)),
        });
      }
    }
  }
  return out;
}

/**
 * Seconds between successive passes of the same point on the path.
 *
 * Measured from the path itself rather than taken from lap metadata, because a v2
 * replay is a session-time window and carries no lap markers at all. Probing several
 * points and taking the median keeps one unlucky probe — a pit entry, a point the car
 * passed only once — from setting the value for the whole window.
 *
 * SOONEST, NOT NEAREST, and that distinction is the whole function. A three-lap window
 * passes each point three times, all of them within a metre of each other, so "the
 * closest other point on the path" picks between them on lap-to-lap line variation —
 * effectively at random. Measured on 2024 Monza R that returned TWO laps for NOR
 * (167 s), which doubled the search window in `gapTo` and let it answer with the next
 * lap's crossing: LEC read −82.80 s instead of +0.95 s on roughly half the samples.
 * So candidates are filtered to points the car genuinely returned to (within the same
 * residual bound a gap uses) and the EARLIEST return wins.
 *
 * THE ERROR IS ONE-DIRECTIONAL, AND THAT IS THE SAFETY ARGUMENT
 * ------------------------------------------------------------
 * The value comes back systematically a little UNDER a lap — roughly the residual bound
 * divided by the car's speed, about 0.4 s on an 84 s lap — because the return is timed
 * from where the path first re-enters `MAX_RESIDUAL_M`, not from the same point exactly.
 * That direction is chosen, because the two directions fail differently and only one of
 * them is acceptable:
 *
 *  - **Too SMALL** narrows `gapTo`'s window. The only gaps it can affect are ones within
 *    the error of half a lap, which is already the point where "ahead" and "behind" are
 *    the same answer measured the other way round. Such a gap stops being reported and
 *    becomes `null` — an em dash. The readout loses a number it could not have been
 *    trusted on anyway.
 *  - **Too LARGE** widens the window until the NEXT LAP's crossing becomes admissible,
 *    and the nearest-in-space rule then picks it. That is not a missing number, it is a
 *    confident wrong one: the defect this function was rewritten for reported a car one
 *    second behind as 82.8 seconds ahead, with no indication anything was wrong.
 *
 * So an honest `—` is always preferred to a plausible lie, and anything that makes this
 * estimate more generous has to argue against that trade first.
 *
 * `Infinity` when no probe found a second pass: the window is shorter than a lap, so
 * there is nothing to disambiguate and every candidate is admissible.
 */
function measureLapPeriod(index: PathIndex): number {
  const n = index.xs.length;
  const sameSpot = MAX_RESIDUAL_M * index.unitsPerMetre;
  const periods: number[] = [];

  for (const k of [0, n >> 2, n >> 1, (3 * n) >> 2]) {
    const at = k / index.sampleRateHz;
    let soonest = Infinity;
    for (const c of candidatesNear(index, index.xs[k], index.ys[k])) {
      const delta = Math.abs(c.t - at);
      if (delta < MIN_LAP_S || c.distance > sameSpot) continue;
      if (delta < soonest) soonest = delta;
    }
    if (soonest < Infinity) periods.push(soonest);
  }

  if (periods.length === 0) return Infinity;
  periods.sort((a, b) => a - b);
  return periods[periods.length >> 1];
}

/** Metres travelled at an arbitrary time, interpolated within the grid step. */
function travelAt(index: PathIndex, t: number): number {
  const n = index.travelM.length;
  const x = Math.min(n - 1, Math.max(0, t * index.sampleRateHz));
  const i = Math.floor(x);
  const j = Math.min(i + 1, n - 1);
  return index.travelM[i] + (index.travelM[j] - index.travelM[i]) * (x - i);
}

/**
 * The gap between the car at `(x, y)` and the focused car whose path this index is.
 *
 * `null` when the question has no answer in the data: the focused car never passed
 * that point within half a lap of `now` (a window edge), or the point is further from
 * its path than `MAX_RESIDUAL_M` (the pit lane, a spin, a stationary car). Callers
 * render that as an em dash — never as a zero.
 *
 * O(1): the grid returns a bounded candidate set regardless of how long the window is.
 */
export function gapTo(
  index: PathIndex,
  x: number,
  y: number,
  now: number,
): Gap | null {
  if (index.degenerate) return null;

  const reach = index.lapPeriod / 2;
  let best: Candidate | null = null;
  for (const c of candidatesNear(index, x, y)) {
    // Half a lap either way: past that, the same ground belongs to a different lap and
    // the nearer crossing is the one that means anything.
    if (Math.abs(c.t - now) > reach) continue;
    if (best === null || c.distance < best.distance) best = c;
  }
  if (best === null) return null;

  const residualM = best.distance / index.unitsPerMetre;
  if (residualM > MAX_RESIDUAL_M) return null;

  return {
    seconds: now - best.t,
    metres: travelAt(index, now) - travelAt(index, best.t),
    residualM,
  };
}
