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
 * Rotate one point about the world origin by `rotationDeg`.
 *
 * The single-point form exists for the render loop: sampling gives one position per
 * car per frame, and going through `rotateWorld` for it would allocate an array
 * every frame to hold `cars.length` points. Same maths, one definition.
 */
export function rotatePoint(p: Point, rotationDeg: number): Point {
  const rad = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  };
}

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
  return pts.map((p) => rotatePoint(p, rotationDeg));
}

/**
 * Arithmetic mean of `pts` — a stand-in for "the middle of the track".
 *
 * Only ever used to decide which side of the racing line is *outside*, so the
 * centre of mass of the sample points is precise enough; nothing depends on it
 * being the true centroid of the enclosed area.
 *
 * @throws {RangeError} on an empty array, for the same reason `computeBounds` does.
 */
export function centroid(pts: readonly Point[]): Point {
  if (pts.length === 0) {
    throw new RangeError("centroid needs at least one point");
  }
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

/**
 * Unit vector to offset a label along so it sits OFF the track, not on it.
 *
 * Corner numbers drawn at their own coordinates land on the racing line, which is
 * exactly where the speed trail is — the one thing on the canvas worth looking at.
 * So the label is pushed along the local outward normal instead.
 *
 * "Outward" is the track's normal at the nearest ribbon sample, sign-disambiguated
 * by `centre`. Using the tangent rather than simply `at - centre` is what makes this
 * hold on a circuit that folds back on itself: on an inner section the radial
 * direction points across the track, while the normal is still perpendicular to it.
 *
 * Degenerate inputs fall back rather than returning `NaN`: a zero-length tangent
 * (duplicate ribbon points) falls back to the radial direction, and a point sitting
 * exactly on `centre` falls back to straight up.
 *
 * @throws {RangeError} if `ribbon` is empty — there is no track to be outside of.
 */
export function labelDirection(
  at: Point,
  ribbon: readonly Point[],
  centre: Point,
): Point {
  if (ribbon.length === 0) {
    throw new RangeError("labelDirection needs a non-empty ribbon");
  }

  // Nearest sample by squared distance — no `sqrt` needed to compare.
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < ribbon.length; i++) {
    const dx = ribbon[i].x - at.x;
    const dy = ribbon[i].y - at.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      nearest = i;
    }
  }

  // A lap is a closed loop, so the neighbours wrap: a corner at sample 0 still has
  // a tangent rather than a one-sided difference.
  const n = ribbon.length;
  const prev = ribbon[(nearest - 1 + n) % n];
  const next = ribbon[(nearest + 1) % n];
  const tx = next.x - prev.x;
  const ty = next.y - prev.y;

  // Perpendicular to the tangent; radial if the tangent has no direction.
  const radialX = at.x - centre.x;
  const radialY = at.y - centre.y;
  const [cx, cy] = tx !== 0 || ty !== 0 ? [-ty, tx] : [radialX, radialY];

  const len = Math.hypot(cx, cy);
  if (len === 0) return { x: 0, y: -1 };

  // Point it away from the middle of the track. A zero dot product means the label
  // is on the centre line itself, where neither side is "out" — either is fine.
  const sign = cx * radialX + cy * radialY < 0 ? -1 : 1;
  return { x: (sign * cx) / len, y: (sign * cy) / len };
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
