/**
 * trace.ts — the speed sparkline's geometry.
 *
 * Pure and headless like the rest of the engine: this returns an SVG path string and a
 * playhead position, and knows nothing about React or the DOM. The path depends only on
 * the samples and the box, so a component computes it once with `useMemo` and re-renders
 * only the playhead as the clock moves.
 *
 * The y axis is scaled to the lap's OWN speed range rather than to a fixed 0–350, so a
 * slow lap still fills the box and the shape stays readable. That means the sparkline
 * shows relative shape, not absolute speed — the HUD's number is what says absolute.
 */
import type { Sample } from "./schema";

/** Where the playhead sits, and the polyline behind it. */
export interface SpeedTrace {
  /** SVG `d` for the speed curve across the full box. */
  path: string;
  /** Lowest and highest speed in the lap, km/h — for the axis labels. */
  minKmh: number;
  maxKmh: number;
}

/**
 * Build the speed curve for one car's lap, fitted to a `width` × `height` box.
 *
 * Screen y is inverted (fast is UP), which is the opposite of the track canvas's
 * convention and correct here: a chart reads upward, a circuit map does not.
 *
 * A flat lap (every sample the same speed) would divide by zero, so it draws down the
 * middle of the box instead of collapsing to `NaN`.
 *
 * @throws {RangeError} on an empty sample array — an empty path would render as a blank
 *         box with no clue why, the same reasoning as `computeBounds`.
 */
export function buildSpeedTrace(
  samples: readonly Sample[],
  width: number,
  height: number,
): SpeedTrace {
  if (samples.length === 0) {
    throw new RangeError("buildSpeedTrace needs at least one sample");
  }

  let minKmh = Infinity;
  let maxKmh = -Infinity;
  for (const s of samples) {
    if (s.speed < minKmh) minKmh = s.speed;
    if (s.speed > maxKmh) maxKmh = s.speed;
  }

  const span = maxKmh - minKmh;
  const lastIndex = Math.max(1, samples.length - 1);

  let path = "";
  for (let i = 0; i < samples.length; i++) {
    const x = (i / lastIndex) * width;
    // Flat lap: no range to scale against, so sit on the centre line.
    const f = span > 0 ? (samples[i].speed - minKmh) / span : 0.5;
    const y = height - f * height;
    path += `${i === 0 ? "M" : "L"}${round(x)} ${round(y)}`;
    if (i < samples.length - 1) path += " ";
  }

  return { path, minKmh, maxKmh };
}

/**
 * The playhead's x position for a clock, in the same box.
 *
 * Uses `duration` rather than the sample count so the playhead agrees with the scrubber,
 * which is also ranged on `meta.duration`. Clamped, so a clock at exactly `duration`
 * lands on the right edge instead of just past it.
 */
export function tracePlayheadX(
  clock: number,
  duration: number,
  width: number,
): number {
  if (!(duration > 0) || !Number.isFinite(duration)) return 0;
  const f = Math.min(1, Math.max(0, clock / duration));
  return f * width;
}

/** Two decimal places is sub-pixel at any realistic sparkline size. */
const round = (n: number): number => Math.round(n * 100) / 100;
