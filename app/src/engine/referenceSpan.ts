/**
 * referenceSpan.ts — the reference lap as SAMPLES: which car's, which indices, and
 * what the one index that does not exist means (Slice 24, consumer half).
 *
 * `track.referenceLap = { car, fromT, toT }` is in seconds on the sample grid, so
 * every consumer reads it the same way — `fromT * sampleRateHz ..= toT *
 * sampleRateHz` of `cars[car]`, no search (CLAUDE.md rule 3) — and every consumer
 * meets the same edge: `toT` may be `meta.duration`, sample `n`, which does not
 * exist. A closed lap reaches it by WRAPPING to its first sample (every closed
 * file's own `{0, 0, duration}`: the closing chord is part of the lap); an open
 * window HOLDS its last. That rule used to live in one function
 * (`referenceLapEnds`); it now has three readers — the schema's closure check, the
 * gap reference circuit and the track ribbon — so it lives here, ONCE, where none
 * of them can restate it differently.
 *
 * Its own module rather than `referenceLap.ts` because `gaps.ts` reads it and
 * `referenceLap.ts` imports `gaps.ts`: a cycle between the two would leave
 * `REFERENCE_LAP_MIN_S = MIN_LAP_S` reading an uninitialised binding whenever
 * `gaps.ts` happened to load first. This module imports types only.
 */
import type { LoopMode, ReferenceLap, Sample } from "./schema";

/** A reference lap on the grid: `cars[car]`'s samples `from ..= to`. */
export interface ReferenceSpan {
  readonly car: number;
  /** `fromT` as a sample index. */
  readonly from: number;
  /**
   * `toT` as a sample index — possibly `n`, or `n + 1` in a file whose duration
   * rounds a step past its samples (the schema allows one). Read it through
   * `spanSample`, never by indexing.
   */
  readonly to: number;
}

/**
 * `reference` in sample indices. Rounded: the schema has already held both bounds
 * to the grid within `GRID_TOLERANCE_S`, so this snaps rather than searches.
 */
export function referenceSpan(
  sampleRateHz: number,
  reference: ReferenceLap,
): ReferenceSpan {
  return {
    car: reference.car,
    from: Math.round(reference.fromT * sampleRateHz),
    to: Math.round(reference.toT * sampleRateHz),
  };
}

/**
 * The sample at span index `k`. Inside the array it is `samples[k]`; past its end
 * it is what the engine draws at that instant — a closed lap has wrapped back to
 * its first sample, an open window holds its last.
 */
export function spanSample(
  samples: readonly Sample[],
  k: number,
  loop: LoopMode,
): Sample {
  const last = samples.length - 1;
  if (k <= last) return samples[k];
  return loop === "closed" ? samples[0] : samples[last];
}
