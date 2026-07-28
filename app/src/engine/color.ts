/**
 * color.ts — speed → colour, the signature of the speed-painted trail.
 *
 * The thermal ramp and bucket domain are ported from the prototype's visual constants
 * (prototype/TelemetryReplay.jsx L41–62); nothing else about that file carries over.
 * They live here rather than as CSS custom properties because they are a data mapping
 * evaluated per sample, not chrome — but the legend swatch in the UI must be generated
 * FROM these stops rather than re-typed as hex.
 *
 * Stops are calibrated in km/h, which is why `schema.ts` pins `meta.units.speed`.
 */

/** `[r, g, b]`, each 0–255. */
export type Rgb = readonly [number, number, number];

interface Stop {
  /** km/h at which this colour is reached exactly. */
  kmh: number;
  rgb: Rgb;
}

/** Cold/slow → hot/fast. Ascending in `kmh`; at least two stops. */
export const THERMAL: readonly Stop[] = [
  { kmh: 80, rgb: [30, 80, 255] },
  { kmh: 150, rgb: [24, 195, 255] },
  { kmh: 220, rgb: [43, 224, 138] },
  { kmh: 280, rgb: [244, 224, 77] },
  { kmh: 340, rgb: [255, 86, 48] },
];

/** Number of discrete colours the trail is stroked in — one Path2D per bucket. */
export const SPEED_BUCKETS = 9;

/** Bucket domain, deliberately a little wider than the thermal stops. */
export const BUCKET_MIN_KMH = 70;
export const BUCKET_MAX_KMH = 345;

/**
 * Colour for a speed in km/h, as `[r, g, b]`.
 *
 * Clamps to the coldest stop below the ramp and the hottest at or above it. `NaN`
 * fails the `>` comparison and lands on the coldest stop rather than producing
 * `NaN` channels — a bad reading paints cold, it does not paint garbage.
 */
export function speedRgb(kmh: number): Rgb {
  const first = THERMAL[0];
  const last = THERMAL[THERMAL.length - 1];
  if (!(kmh > first.kmh)) return first.rgb;
  if (kmh >= last.kmh) return last.rgb;

  // Strictly inside the ramp, so a bracketing pair always exists.
  let i = 0;
  while (THERMAL[i + 1].kmh <= kmh) i++;
  const a = THERMAL[i];
  const b = THERMAL[i + 1];
  const f = (kmh - a.kmh) / (b.kmh - a.kmh);
  return [
    Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
    Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
    Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
  ];
}

/** Colour for a speed in km/h, as a canvas/CSS `rgb(...)` string. */
export function speedColor(kmh: number): string {
  const [r, g, b] = speedRgb(kmh);
  return `rgb(${r},${g},${b})`;
}

/**
 * Which of the `SPEED_BUCKETS` bands a speed falls in, clamped to `[0, n-1]`.
 *
 * Bucketing lets the trail be stroked as a handful of batched paths instead of one
 * `stroke()` per sample, which is what keeps 20 cars affordable.
 */
export function bucketOf(kmh: number): number {
  const f = (kmh - BUCKET_MIN_KMH) / (BUCKET_MAX_KMH - BUCKET_MIN_KMH);
  return Math.max(
    0,
    Math.min(SPEED_BUCKETS - 1, Math.floor(f * SPEED_BUCKETS)),
  );
}

/** The colour a whole bucket is stroked in — its band's midpoint. */
export function bucketColor(bucket: number): string {
  const span = BUCKET_MAX_KMH - BUCKET_MIN_KMH;
  return speedColor(BUCKET_MIN_KMH + ((bucket + 0.5) / SPEED_BUCKETS) * span);
}
