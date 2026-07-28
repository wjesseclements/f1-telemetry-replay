/**
 * clock.ts — how the playback clock advances, as pure arithmetic.
 *
 * The live clock itself lives in a ref inside the render loop (CLAUDE.md
 * architecture rule 1) and is never React or store state. What lives HERE is the
 * rule for moving it: the loop supplies two timestamps and the transport's
 * multiplier, and gets back the next clock value. That keeps the discipline below
 * unit-testable instead of buried in a `requestAnimationFrame` callback.
 *
 * Two properties this file exists to guarantee:
 *
 *  - **Scaled deltas accumulate; the clock is never derived from an absolute
 *    timestamp.** `clock = (now - start) * speedMult` would retroactively rescale
 *    already-elapsed time, so switching to 4x at the halfway point would teleport
 *    the car. Adding `dt * speedMult` each frame leaves elapsed time alone.
 *  - **`dt` is clamped.** A backgrounded tab stops firing frames; when it resumes,
 *    `now - prev` can be minutes. Unclamped, the car jumps an arbitrary distance
 *    around the lap on the first frame back.
 */
import { wrapClock } from "./interpolate";

/**
 * Largest frame delta the clock will honour, in seconds.
 *
 * Generous next to a real frame (~16 ms at 60 Hz, ~33 ms at 30 Hz) so ordinary
 * jank still plays through smoothly, but small enough that a resumed background
 * tab advances by a tenth of a second rather than by however long it was hidden.
 */
export const MAX_FRAME_DT_S = 0.1;

/**
 * Elapsed seconds between two `requestAnimationFrame` timestamps, clamped to
 * `MAX_FRAME_DT_S`.
 *
 * @param prevMs Previous frame's timestamp, or `null` on the first frame — there
 *               is no interval to measure yet, so the answer is 0.
 * @param nowMs  This frame's timestamp, in milliseconds.
 *
 * A non-positive interval yields 0: rAF timestamps are monotonic, but a clock
 * adjustment or a stubbed timer in a test should stall the replay, never rewind it.
 */
export function frameDelta(prevMs: number | null, nowMs: number): number {
  if (prevMs === null) return 0;
  const dt = (nowMs - prevMs) / 1000;
  if (!(dt > 0)) return 0; // also catches NaN
  return Math.min(dt, MAX_FRAME_DT_S);
}

/**
 * The clock one frame later: `clock + dt * speedMult`, folded into `[0, duration)`.
 *
 * Wrapping is delegated to `wrapClock` rather than re-implemented here, so the
 * replay has exactly one definition of "past the end comes round to the start"
 * (and one of "seeking before zero comes round from the end").
 *
 * @param duration The transport's loop length — `meta.duration`. The schema pins
 *                 every car's sample grid to it, so this agrees with the span
 *                 `interpolate.ts` wraps on.
 */
export function advanceClock(
  clock: number,
  dt: number,
  speedMult: number,
  duration: number,
): number {
  return wrapClock(clock + dt * speedMult, duration);
}
