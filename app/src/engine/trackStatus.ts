/**
 * trackStatus.ts — which flag the window is under, at a clock.
 *
 * The schema carries status as a sorted, non-overlapping interval list in window
 * seconds (`replay.trackStatus`), and this module owns the two pure questions the
 * UI asks of it:
 *
 *  - `statusAt` — the flag under the playhead, read at the HUD's ≤30 Hz tick. A
 *    linear scan, deliberately: a window carries a handful of intervals (the red-flag
 *    scenario's worst case is four), so a binary search would be complexity spent on
 *    n ≤ ~10. Nothing on the 60 fps frame path ever calls this (CLAUDE.md rule 1).
 *  - `statusSegments` — the intervals as fractions of the replay's duration, for the
 *    scrubber's tint. Computed once per replay, not per tick: the answer is a
 *    function of static data alone.
 *
 * Both answer `null`/nothing for time the data does not cover. A gap in the interval
 * list means the source had no answer there, and inventing green would be a lie —
 * the same "absence is not zero" contract as `stint.ageAtStart`.
 */
import type { StatusInterval, TrackStatus } from "./schema";

/**
 * The flag at `t` seconds, or `null` where the data has no answer.
 *
 * Intervals are treated as CLOSED `[fromT, toT]`, first match wins. The schema
 * forbids overlap, so the only shared instants are adjacent boundaries, where the
 * earlier interval answers — at a transition instant either answer is defensible
 * for one tick, and closed ends are what keep the final interval answering at
 * exactly `t = duration`, where an open window's clock parks.
 */
export function statusAt(
  intervals: readonly StatusInterval[],
  t: number,
): TrackStatus | null {
  for (const interval of intervals) {
    if (t >= interval.fromT && t <= interval.toT) return interval.status;
  }
  return null;
}

/** One tinted stretch of the scrubber: `[from, to]` as fractions of the duration. */
export interface StatusSegment {
  status: TrackStatus;
  /** 0..1, clamped. */
  from: number;
  /** 0..1, clamped; always greater than `from`. */
  to: number;
}

/**
 * The interval list as clamped duration-fractions, zero-width stretches dropped.
 *
 * Clamping is defensive symmetry with `resolveStartClock`: the schema already pins
 * intervals inside the replay, so out-of-range input cannot arrive through a
 * validated file — but this function's contract is "fractions in [0, 1]", and it
 * keeps that promise itself rather than delegating it to a caller's schema.
 */
export function statusSegments(
  intervals: readonly StatusInterval[],
  duration: number,
): StatusSegment[] {
  if (!(duration > 0)) return [];
  const segments: StatusSegment[] = [];
  for (const interval of intervals) {
    const from = Math.min(Math.max(interval.fromT / duration, 0), 1);
    const to = Math.min(Math.max(interval.toT / duration, 0), 1);
    if (to > from) segments.push({ status: interval.status, from, to });
  }
  return segments;
}
