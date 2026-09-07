/**
 * laps.ts — which lap a car is on at a given clock.
 *
 * `car.laps` is an ordered list of `{number, startT}` boundaries (schema-enforced
 * strictly increasing in both), so "which lap" is a predecessor search on `startT`:
 * the latest lap that has already started. O(log n), the `timeAtProgress` idiom —
 * rule 3's O(1) is about the per-frame 60 fps sample path, and these run at the
 * ≤30 Hz HUD tick over at most a race's worth of entries, where a precomputed
 * per-grid-sample index would buy nothing measurable. A linear scan is foreclosed
 * because rule 3 is phrased absolutely.
 *
 * Both functions take the transport's ALREADY-WRAPPED clock (what the HUD tick and
 * the transport bar hold); they do not wrap it themselves.
 *
 * AFTER THE LAST KNOWN LAP START, `lapAt` HOLDS THE LAST LAP — decided, not
 * defaulted. No lap-end times are carried, and a retired or partial-coverage car
 * honestly stopped ON the lap it stopped on; returning `null` there would blank a
 * dot and a chip that were true a moment earlier. `leaderLap` is unaffected: a
 * held lap can never exceed a live leader's.
 *
 * ON A CLOSED (single-lap) FILE the same lap number is returned on every wrap.
 * That is correct — the data is one lap, replayed — not a frozen counter.
 */
import type { Car, Replay } from "./schema";

/**
 * The lap `car` is on at `clock`, or `null` when the data has no answer:
 * the car carries no laps, the clock is non-finite, or the clock is before the
 * car's first known lap start (possible in a v2 window — see `LapSchema`).
 */
export function lapAt(car: Car, clock: number): number | null {
  const laps = car.laps;
  const n = laps.length;
  if (n === 0 || !Number.isFinite(clock)) return null;
  if (clock < laps[0].startT) return null;

  // Predecessor search: the latest lap with startT <= clock. After the last
  // start this settles on the last lap and holds it (see header).
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (laps[mid].startT <= clock) lo = mid;
    else hi = mid;
  }
  return laps[hi].startT <= clock ? laps[hi].number : laps[lo].number;
}

/**
 * The highest lap any car is on at `clock` — the number a broadcast lap counter
 * shows. It is a NUMBER, never a car: when several cars share the max lap (the
 * normal case) no tie is broken, and if the data ever carries a lap beyond the
 * window's advertised range the number is displayed honestly, not clamped.
 *
 * `null` when no car has an answer (no lap data anywhere), which is how every
 * pre-Slice-14 file renders no indicator at all.
 */
export function leaderLap(replay: Replay, clock: number): number | null {
  let max: number | null = null;
  for (const car of replay.cars) {
    const lap = lapAt(car, clock);
    if (lap !== null && (max === null || lap > max)) max = lap;
  }
  return max;
}
