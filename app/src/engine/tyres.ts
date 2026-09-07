/**
 * tyres.ts — which tyre a car is on, and how old it is.
 *
 * A stint is located via the lap table (`stintAt` goes through `lapAt`), which is
 * why the schema rejects stints without laps. The engine deals only in compound
 * STRINGS from `COMPOUNDS`; the compound→colour mapping is presentation and lives
 * with the components, the way `drs.ts` leaves the pill's styling to `DrsPill`.
 *
 * Age arithmetic: `ageAtStart` is FastF1's `TyreLife` at the stint's first
 * in-window lap, so the age on lap L is `ageAtStart + (L - fromLap)`. When
 * `ageAtStart` is absent the age is UNKNOWN — `null`, rendered as `NO_VALUE`,
 * never a zero that would read as a fresh set.
 */
import type { Car, Compound, Stint } from "./schema";
import { lapAt } from "./laps";

/** Whether this car carries tyre data at all — the `carHasDrs` shape. */
export function carHasTyres(car: Car): boolean {
  return car.stints.length > 0;
}

/**
 * The stint covering `lapNumber`, or `null` when no stint does (no tyre data,
 * or a lap outside every stint's range — a gap is a real state, not an error).
 * Predecessor binary search on `fromLap` (stints are schema-enforced ordered
 * and non-overlapping), then a containment check against that stint's `toLap`.
 */
export function stintForLap(car: Car, lapNumber: number): Stint | null {
  const stints = car.stints;
  const n = stints.length;
  if (n === 0 || lapNumber < stints[0].fromLap) return null;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (stints[mid].fromLap <= lapNumber) lo = mid;
    else hi = mid;
  }
  const stint = stints[hi].fromLap <= lapNumber ? stints[hi] : stints[lo];
  return lapNumber <= stint.toLap ? stint : null;
}

/** The stint `car` is on at `clock`, via `lapAt` — `null` when either has no answer. */
export function stintAt(car: Car, clock: number): Stint | null {
  const lap = lapAt(car, clock);
  return lap === null ? null : stintForLap(car, lap);
}

/**
 * Laps on the current set at `lapNumber`, or `null` when the stint's starting
 * age is unknown. Callers pass a lap inside the stint (what `stintForLap`
 * returned it for); the arithmetic is not re-guarded here.
 */
export function tyreAge(stint: Stint, lapNumber: number): number | null {
  if (stint.ageAtStart === undefined) return null;
  return stint.ageAtStart + (lapNumber - stint.fromLap);
}

/** What the HUD shows about a tyre: the compound, and the set's age if known. */
export interface TyreState {
  compound: Compound;
  age: number | null;
}

/**
 * The tyre `car` is on at `clock` — one lookup for the HUD tick: lap, stint,
 * age, in that order, `null` as soon as the data has no answer. Derived from
 * the replay and the clock like a gap is (never from the published snapshot),
 * so `CarSnapshot` and `displaySignature` never learn what a tyre is.
 */
export function tyreStateAt(car: Car, clock: number): TyreState | null {
  const lap = lapAt(car, clock);
  if (lap === null) return null;
  const stint = stintForLap(car, lap);
  if (stint === null) return null;
  return { compound: stint.compound, age: tyreAge(stint, lap) };
}

/** The compound as its one-letter broadcast mark; `"?"` for UNKNOWN. */
export function compoundLetter(compound: Compound): string {
  return compound === "UNKNOWN" ? "?" : compound[0];
}
