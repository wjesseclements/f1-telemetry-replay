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
 * Bring one world point into SCREEN orientation: rotate by `rotationDeg`, then
 * negate y because the canvas grows downward.
 *
 * TWO operations, and the second one used to be missing. FastF1's X/Y are a Y-UP
 * frame — its own documentation plots them straight into matplotlib — while a canvas
 * puts +y at the BOTTOM. `fitTransform` applies only a positive scale and a
 * translation, so without the negation here every circuit was drawn MIRRORED, and
 * therefore circulating backwards, from Slice 4a until Slice 9f.
 *
 * It survived because the claim that it was correct was written down as a fact
 * (`fitTransform` said "world y grows downward on screen, matching the source data's
 * orientation" — it does not) and because the only fixture with a closed lap is a
 * symmetric oval, which cannot express handedness. See `PLAN.md` §Slice 9f.
 *
 * The mirror is why the defect read as a rotation error. `M·R(r) = R(−r)·M`, so a
 * mirrored render is indistinguishable from a 2×rotation offset if you assume the
 * error must be rotational: 184° at Silverstone, 190° at Monza. Rotation alone
 * cannot produce it — a rotation preserves the sign of a polygon's signed area, and
 * circulation direction is exactly that sign. Only a reflection reverses it.
 *
 * The single-point form exists for the render loop: sampling gives one position per
 * car per frame, and going through `toScreenPoints` for it would allocate an array
 * every frame to hold `cars.length` points. Same maths, one definition.
 */
export function toScreenPoint(p: Point, rotationDeg: number): Point {
  const rad = rotationDeg * DEG_TO_RAD;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: p.x * cos - p.y * sin,
    y: -(p.x * sin + p.y * cos),
  };
}

/**
 * Bring world points into screen orientation (see `toScreenPoint`).
 *
 * The circuit rotation FastF1 publishes is what makes a track read the way it does on
 * a broadcast graphic, so it is applied to every world point — track ribbon, corner
 * markers and car positions alike — before fitting. The y negation rides with it, so
 * everything downstream (`centroid`, `labelDirection`, `fitTransform`, the trail
 * painters) works in ONE consistent screen-oriented frame and needs no correction of
 * its own.
 */
export function toScreenPoints(
  pts: readonly Point[],
  rotationDeg: number,
): Point[] {
  return pts.map((p) => toScreenPoint(p, rotationDeg));
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

/** A margin per side, in CSS px. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Fit `bounds` into a `width` × `height` viewport inside `pad` px of margin,
 * preserving aspect ratio and centring the result between the margins.
 *
 * `pad` is either one margin for every side or an `Insets` (Slice 26, so the bottom
 * can keep the speed legend's row while the other sides shrink on a phone). Equal
 * insets give EXACTLY the numbers a plain `pad` does, bit for bit, at whole-pixel
 * sizes: `width + left - right` is `width` again before anything is divided — which
 * is what keeps the draw-call capture's digests unchanged.
 *
 * No flip here, and that is now TRUE rather than merely asserted: the world→screen
 * y negation lives in `toScreenPoint`, upstream of this, so by the time bounds are
 * measured the points are already in screen orientation. This function is a positive
 * uniform scale and a translation, nothing else — which is what lets `toScreenHeading`
 * reason about angles without a second correction.
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
  pad: number | Insets,
): FitTransform {
  const { top, right, bottom, left } =
    typeof pad === "number"
      ? { top: pad, right: pad, bottom: pad, left: pad }
      : pad;
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const availW = Math.max(0, width - left - right);
  const availH = Math.max(0, height - top - bottom);

  const scaleX = spanX > 0 ? availW / spanX : Infinity;
  const scaleY = spanY > 0 ? availH / spanY : Infinity;
  const fitted = Math.min(scaleX, scaleY);
  // Both spans zero — a single point, or every point identical.
  const scale = Number.isFinite(fitted) ? fitted : 1;

  return {
    scale,
    offsetX: (width + left - right - spanX * scale) / 2 - bounds.minX * scale,
    offsetY: (height + top - bottom - spanY * scale) / 2 - bounds.minY * scale,
  };
}

/**
 * The margin every desktop canvas gets on every side — and the bottom margin on
 * EVERY canvas, which never scales: it is the speed legend's row (`canvasInsets`).
 */
export const MARGIN_MAX_PX = 46;
/**
 * The top, left and right margin on a small canvas.
 *
 * The labels sit at FIXED pixel offsets from the track (`render/paths.ts`), so what
 * they need from the margin does not shrink with the canvas. Measured in headless
 * Chrome against the five gallery files and the fixture at 16 viewports (Slice 26),
 * a corner badge on the fitted bounds' extreme reaches 19 + 9 + 0.5 = 28.5 px past
 * it (offset, radius, half the hairline ring) — several real corners sit exactly
 * there, pointing out — and the S/F label at most 22.5 px. 32 keeps the worst badge
 * 3.5 px clear of the canvas edge, so its ring never meets the header's border.
 */
export const MARGIN_MIN_PX = 32;
/**
 * The top/left/right margin's share of the canvas's shorter side, between the two
 * bounds.
 *
 * Chosen against measured canvases: every desktop one keeps exactly 46 px — the
 * smallest the layout gate sees is 1056x623 (1280x720), the draw-call capture's is
 * 1176x657, and 46 px is reached from a 460 px shorter side, ~26% under both — while
 * every phone canvas measured (shorter side 159–390 px) gets 32–39 px.
 */
export const MARGIN_SHARE = 0.1;

/**
 * The margins, in CSS px, between the fitted track and the canvas edge, for a
 * canvas of `width` × `height` — `fitTransform`'s `pad`.
 *
 * Until Slice 26 this was a fixed 46 px on every side, which left the circuit 68 px
 * tall on the 468x160 canvas iOS Safari leaves a landscape phone. Now the top, left
 * and right are a tenth of the shorter side, never under `MARGIN_MIN_PX` nor over
 * `MARGIN_MAX_PX` (82 px tall there), so a desktop canvas draws exactly what it
 * always drew.
 *
 * The bottom stays at 46 px, by measurement: the speed legend is an overlay in the
 * canvas's bottom-left corner, 14 px up with a 15 px line box, and the badges at the
 * bottom of a circuit point down into it — Monza's T1–T3 at most short sizes. No
 * bottom margin under 57.5 px (29 + 28.5) can keep such a badge off the legend, so
 * the bottom keeps desktop's 46 and the overlaps main already had stay about as
 * they were: badge on legend text in 17 of 96 measured cells against main's 14,
 * none more than 2 px deeper, from badges moving sideways as the circuit grows. A
 * symmetric margin was measured first and rejected for it: at 36 px a Monza badge
 * landed on "340 km/h" at every Safari size — 21 cells worse than main, by up to
 * 7 px. 46 also keeps the ribbon itself 10.5 px clear of the legend's box, where
 * 35.5 px is the least that clears it at all.
 */
export function canvasInsets(width: number, height: number): Insets {
  const side = Math.min(
    MARGIN_MAX_PX,
    Math.max(MARGIN_MIN_PX, MARGIN_SHARE * Math.min(width, height)),
  );
  return { top: side, right: side, bottom: MARGIN_MAX_PX, left: side };
}

/**
 * The screen-space equivalent of a world-space heading, in radians.
 *
 * `toScreenPoints` turns world points into the frame the track is actually drawn in,
 * so a heading measured in world coordinates — as `sampleCarAt` returns it — is
 * wrong once drawn unless it makes the SAME journey. Nothing about that is visible in
 * the car's position, only in anything that points: the marker's heading tick and the
 * start/finish line.
 *
 * Both halves of `toScreenPoint`, applied to a direction instead of a position, and
 * exact rather than approximate. Rotating `(cos h, sin h)` by `r` gives
 * `(cos(h+r), sin(h+r))`; negating y then gives `(cos(h+r), −sin(h+r))`, which is
 * the direction at angle **−(h+r)**. So the mirror negates the angle, exactly as it
 * reverses circulation — the same fact seen from the other side.
 *
 * `fitTransform` is a uniform positive scale plus a translation — no flip, no shear —
 * so it leaves angles untouched and needs no further correction here.
 *
 * The result is normalised into `(-π, π]`, matching `atan2`'s range, so it can be
 * compared against a heading measured from screen coordinates directly.
 */
export function toScreenHeading(
  headingRad: number,
  rotationDeg: number,
): number {
  const a = -(headingRad + rotationDeg * DEG_TO_RAD);
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Apply a fit transform to one point. */
export function applyTransform(p: Point, t: FitTransform): Point {
  return {
    x: p.x * t.scale + t.offsetX,
    y: p.y * t.scale + t.offsetY,
  };
}
