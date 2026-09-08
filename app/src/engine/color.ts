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

/**
 * Number of discrete colours the CIRCUIT TRAIL is stroked in — one Path2D per bucket.
 *
 * Tuned for a whole lap of track, where a bucket boundary falls somewhere along the
 * circuit and reads as texture. See `COMET_BUCKETS` for why the comet cannot use it.
 */
export const SPEED_BUCKETS = 9;

/**
 * The same ramp, sampled finely enough for the FOCUSED car's comet (Slice 9c).
 *
 * Not a second palette — `bucketOf` and `bucketColor` take the count as an argument, so
 * both resolutions are the same `THERMAL` interpolation over the same
 * `BUCKET_MIN_KMH`..`BUCKET_MAX_KMH` domain. Two samplings of one truth; there is
 * nothing here that can drift out of step with the trail.
 *
 * **Why the comet needs its own count.** `SPEED_BUCKETS` is read at a scale it was not
 * chosen for: the comet is ~2 s long, focal, and adjacent to a glowing marker, so its
 * nine steps land within a couple of centimetres of each other in the one place the eye
 * is already looking. A braking zone sweeps the whole ramp in about the comet's own
 * length, so every boundary is crossed inside it at once — and it reads as stripes.
 *
 * **Why 32 exactly**, measured on `monza_endgame.json` (Monza R, 3 cars, ~7 laps) rather
 * than chosen for roundness. Single-step |Δv| there is p50 1, p95 8, p99 13, max
 * **29 km/h** — every step in the file is smaller than one 30.6 km/h `SPEED_BUCKETS`
 * band, which is the mechanism: adjacent segments are FORCED to share a colour. Over the
 * hardest 2 s braking event (315 → 108 km/h), the comet's 21 segments draw:
 *
 *   | buckets | band width | distinct colours | longest run |
 *   |---------|------------|------------------|-------------|
 *   | 9       | 30.6 km/h  | 8 / 21           | 5           |
 *   | 16      | 17.2 km/h  | 13 / 21          | 3           |
 *   | 32      | 8.6 km/h   | 19 / 21          | 2           |
 *   | 48      | 5.7 km/h   | 21 / 21          | 1           |
 *
 *  - **The floor is the data.** 8.6 km/h sits under the p95 single step, so in the
 *    regime that produces the stripe almost every step crosses a boundary.
 *  - **The ceiling is the comet's own geometry.** It is 21 segments, so around 48 buckets
 *    every segment gets its own colour and the batching key stops batching anything. At
 *    32 a constant-speed stretch still collapses to one stroke, which is what the key is
 *    FOR, while a braking sweep gets a colour per segment.
 */
export const COMET_BUCKETS = 32;

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
 * Which of `buckets` bands a speed falls in, clamped to `[0, buckets - 1]`.
 *
 * Bucketing lets a wake be stroked as a handful of batched paths instead of one
 * `stroke()` per sample, which is what keeps 20 cars affordable.
 *
 * The count is a REQUIRED argument rather than a default, so every call site states
 * which resolution it means — `SPEED_BUCKETS` for the circuit trail, `COMET_BUCKETS`
 * for the comet. A default would let a wrong-resolution call happen in silence, and the
 * two keys are byte-compatible `Uint8Array`s, so nothing else would notice.
 */
export function bucketOf(kmh: number, buckets: number): number {
  const f = (kmh - BUCKET_MIN_KMH) / (BUCKET_MAX_KMH - BUCKET_MIN_KMH);
  return Math.max(0, Math.min(buckets - 1, Math.floor(f * buckets)));
}

/**
 * The colour a whole bucket is stroked in — its band's midpoint on the ramp.
 *
 * `buckets` must be the same count the index came out of `bucketOf` with: an index is
 * meaningless without the resolution that produced it.
 */
export function bucketColor(bucket: number, buckets: number): string {
  const span = BUCKET_MAX_KMH - BUCKET_MIN_KMH;
  return speedColor(BUCKET_MIN_KMH + ((bucket + 0.5) / buckets) * span);
}

/** The speeds the ramp spans, `[coldest, hottest]` in km/h — for legend labels. */
export function thermalRangeKmh(): readonly [number, number] {
  return [THERMAL[0].kmh, THERMAL[THERMAL.length - 1].kmh];
}

/**
 * The thermal ramp as a CSS `linear-gradient`, left (cold) to right (hot).
 *
 * The legend swatch has to be GENERATED from `THERMAL` rather than re-typed as hex —
 * see this file's header, and the prototype for the failure mode: it hard-codes the
 * same five colours a second time in its stylesheet (`TelemetryReplay.jsx:588`), so
 * retuning a stop silently desyncs the legend from the trail it is labelling.
 *
 * Stops are positioned by where their speed actually falls across the ramp, not
 * spread evenly, so the swatch is the same non-uniform ramp `speedRgb` interpolates.
 */
export function thermalGradientCss(): string {
  const [coldest, hottest] = thermalRangeKmh();
  const span = hottest - coldest;
  const stops = THERMAL.map((stop) => {
    // One decimal place: enough to place a stop sub-pixel on any real swatch width.
    const pct = Math.round(((stop.kmh - coldest) / span) * 1000) / 10;
    return `rgb(${stop.rgb[0]},${stop.rgb[1]},${stop.rgb[2]}) ${pct}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/**
 * sRGB channel (0–255) → linear-light (0–1), per the WCAG/IEC 61966 transfer curve.
 * Luminance is a LINEAR combination of these, which is what makes `floorLuminance`'s
 * closed form exact.
 */
function linearChannel(byte: number): number {
  const s = byte / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** The inverse: linear-light (0–1) → sRGB channel (0–255). */
function srgbChannel(linear: number): number {
  const s =
    linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** `#rgb` or `#rrggbb` (the two shapes `schema.ts` admits) → linear-light channels. */
function linearRgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c) : hex;
  return [
    linearChannel(parseInt(h.slice(1, 3), 16)),
    linearChannel(parseInt(h.slice(3, 5), 16)),
    linearChannel(parseInt(h.slice(5, 7), 16)),
  ];
}

/** WCAG relative luminance of a hex colour: 0 (black) – 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = linearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The colour, lightened just enough to reach `floor` relative luminance — or returned
 * VERBATIM when it is already there. A minimum-contrast floor as a principle, not a
 * per-team patch: Slice 15's browser pass found Red Bull's navy overlay near-invisible
 * on `--c-bg`, and the next dark livery would fail the same way.
 *
 * The mechanism is a mix toward white in LINEAR-light space, where luminance is a
 * linear function of the channels — so the mixing fraction that lands exactly on the
 * floor has a closed form, `t = (floor − L₀) / (1 − L₀)`, no search, and the hue only
 * drifts the way lightening always drifts it (toward pastel). Bright colours pass
 * through untouched, byte-for-byte, so team identity is preserved wherever it already
 * reads.
 */
/**
 * The luminance floor for the timing tower's team swatches, `floorLuminance`d in
 * `CarEntry` (Slice 17, ruled): 2026's Cadillac livery arrives as `#444444`, which
 * is a 1.7:1 ghost against `--c-panel` — the first real livery dark enough to
 * vanish in the TOWER rather than the trace. The value is `COMPARISON_MIN_LUMINANCE`'s
 * measured 0.25 (≥5.5:1 on the app's darks), named separately for the tyre-token
 * reason: retuning the trace overlay must not silently repaint the tower, and
 * vice versa. The CANVAS is deliberately not floored — its tails and markers
 * still paint raw team colour, a scoped ruling flagged in PLAN (re-flooring the
 * scene would re-baseline the drawcall md5s and lift Red Bull's navy too).
 */
export const SWATCH_MIN_LUMINANCE = 0.25;

export function floorLuminance(hex: string, floor: number): string {
  const lum = relativeLuminance(hex);
  if (lum >= floor) return hex;
  const t = (floor - lum) / (1 - lum);
  const [r, g, b] = linearRgb(hex).map((v) => v + t * (1 - v));
  const to2 = (byte: number) => byte.toString(16).padStart(2, "0");
  return `#${to2(srgbChannel(r))}${to2(srgbChannel(g))}${to2(srgbChannel(b))}`;
}
