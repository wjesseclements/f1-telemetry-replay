/**
 * geometry.ts — world coordinates → screen coordinates.
 *
 * Three pure steps, kept separate so each is testable and each is computed at its
 * own cadence by the renderer: rotate the track once per replay, measure its bounds
 * once, and recompute the fit only when the viewport resizes. None of this runs per
 * frame, and none of it touches a canvas — the caller applies the transform.
 *
 * Stored `x`/`y` are never mutated: `meta.rotation` is a presentation concern, applied
 * here at render time, exactly as the schema documents.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Maps world → screen as `screen = world * scale + offset`. */
export interface FitTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Rotate points about the world origin by `rotationDeg` (as `meta.rotation` gives it).
 *
 * The circuit rotation FastF1 publishes is what makes a track read the way it does on
 * a broadcast graphic, so it is applied to every world point — track ribbon, corner
 * markers and car positions alike — before fitting.
 */
export function rotateWorld(
  pts: readonly Point[],
  rotationDeg: number,
): Point[] {
  const rad = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return pts.map((p) => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }));
}

/**
 * Axis-aligned bounding box of `pts`.
 *
 * @throws {RangeError} on an empty array — returning `±Infinity` bounds would flow
 *         downstream as a `NaN` transform and paint a blank canvas with no clue why.
 */
export function computeBounds(pts: readonly Point[]): Bounds {
  if (pts.length === 0) {
    throw new RangeError("computeBounds needs at least one point");
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Fit `bounds` into a `width` × `height` viewport with `pad` px of margin, preserving
 * aspect ratio and centring the result.
 *
 * y is not flipped: world y grows downward on screen, matching the source data's
 * orientation.
 *
 * Degenerate inputs are absorbed rather than propagated as `NaN`/`Infinity`:
 * an axis with zero span imposes no constraint, a point-like bounds fits at `scale`
 * 1, and a viewport smaller than its own padding clamps to `scale` 0 (nothing drawn)
 * instead of going negative and mirroring the render.
 */
export function fitTransform(
  bounds: Bounds,
  width: number,
  height: number,
  pad: number,
): FitTransform {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const availW = Math.max(0, width - pad * 2);
  const availH = Math.max(0, height - pad * 2);

  const scaleX = spanX > 0 ? availW / spanX : Infinity;
  const scaleY = spanY > 0 ? availH / spanY : Infinity;
  const fitted = Math.min(scaleX, scaleY);
  // Both spans zero — a single point, or every point identical.
  const scale = Number.isFinite(fitted) ? fitted : 1;

  return {
    scale,
    offsetX: (width - spanX * scale) / 2 - bounds.minX * scale,
    offsetY: (height - spanY * scale) / 2 - bounds.minY * scale,
  };
}

/**
 * The screen-space equivalent of a world-space heading, in radians.
 *
 * `rotateWorld` turns world points into the frame the track is actually drawn in,
 * so a heading measured in world coordinates — as `sampleCarAt` returns it — is
 * off by exactly `rotationDeg` once drawn. Nothing about that error is visible in
 * the car's position, only in anything that points: at the fixture's -14° it aims
 * the heading tick 14° away from the direction the car is visibly travelling.
 *
 * Adding the rotation is exact rather than approximate: rotating a direction
 * vector `(cos h, sin h)` by `r` yields `(cos(h+r), sin(h+r))`, and `fitTransform`
 * only ever applies a uniform scale and a translation — no flip, no shear — so it
 * leaves angles untouched.
 *
 * The result is normalised into `(-π, π]`, matching `atan2`'s range, so it can be
 * compared against a heading measured from screen coordinates directly.
 */
export function rotateHeading(headingRad: number, rotationDeg: number): number {
  const a = headingRad + rotationDeg * DEG_TO_RAD;
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Apply a fit transform to one point. */
export function applyTransform(p: Point, t: FitTransform): Point {
  return {
    x: p.x * t.scale + t.offsetX,
    y: p.y * t.scale + t.offsetY,
  };
}
