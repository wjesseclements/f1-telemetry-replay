/**
 * scene.ts — canvas drawing, split into what is computed once and what is painted
 * every frame.
 *
 * `buildScene` runs once per replay: rotating a lap's worth of points, measuring their
 * bounds and bucketing every sample's speed is O(samples) and the result never changes,
 * so it must not happen in the animation loop. `buildScenePaths` (see `paths.ts`) then
 * projects that into screen space once per resize. `drawFrame` runs 60 times a second
 * and does only per-car work — and allocates nothing.
 *
 * Everything geometric here delegates to `src/engine/geometry.ts`; this module owns
 * the canvas calls and nothing else (CLAUDE.md architecture rule 4 keeps the maths
 * out of the renderer, and the renderer out of the engine).
 */
import { bucketOf } from "../engine/color";
import type { CarSnapshot } from "../engine/interpolate";
import {
  applyTransform,
  centroid,
  computeBounds,
  labelDirection,
  rotateHeading,
  rotatePoint,
  rotateWorld,
  type Bounds,
  type FitTransform,
  type Point,
} from "../engine/geometry";
import type { Replay } from "../engine/schema";
import type { ChromeColors } from "./palette";
import type { ScenePaths } from "./paths";
import { TAIL_SECONDS } from "./trail";

/** A corner marker in rotated world space, with the way its label should lean. */
export interface SceneCorner {
  at: Point;
  /** Unit vector pointing away from the track — see `geometry.labelDirection`. */
  dir: Point;
  text: string;
}

/** Everything about a replay that can be computed before the clock starts. */
export interface Scene {
  /** The track ribbon, in rotated world coordinates. */
  ribbon: readonly Point[];
  /** Every car's rotated path, in `replay.cars` order. */
  carPaths: readonly (readonly Point[])[];
  /**
   * Per car, the speed bucket of the segment leaving each sample.
   *
   * `Uint8Array` because there are 9 buckets and one entry per sample: a plain array
   * would box 585 numbers per car for data that never changes after load.
   */
  carBuckets: readonly Uint8Array[];
  /** Bounds of every car's rotated path — what the viewport is fitted to. */
  bounds: Bounds;
  /** `meta.rotation`, needed per frame to bring car headings into screen space. */
  rotationDeg: number;
  /** Car colours, in `replay.cars` order — parallel to the snapshot array. */
  carColors: readonly string[];
  /**
   * How many segments an unfocused car's tail spans.
   *
   * Derived from `TAIL_SECONDS` and the grid rate here, once, so the tail is a
   * DURATION rather than a sample count: a 10 Hz replay and a 20 Hz one show the same
   * length of wake.
   */
  tailSegments: number;
  corners: readonly SceneCorner[];
  startFinish: { at: Point; angle: number; dir: Point };
}

/** Where the scene is being drawn, recomputed on resize only. */
export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  fit: FitTransform;
}

/** Exported so a test can pick the ribbon's stroke out of a recording by width. */
export const TRACK_EDGE_WIDTH = 13;
const TRACK_FILL_WIDTH = 9;
const CAR_GLOW_RADIUS = 6.5;
const CAR_CORE_RADIUS = 3;
const CAR_HEADING_LENGTH = 12;
const UNFOCUSED_RADIUS = 4.5;
const UNFOCUSED_CORE_RADIUS = 2;
const UNFOCUSED_HEADING_LENGTH = 8;
const UNFOCUSED_ALPHA = 0.75;
/** Exported so a test can pick a badge out of a recording by its radius. */
export const CORNER_BADGE_RADIUS = 9;
const MARK_WIDTH = 2.5;
const HAIRLINE_WIDTH = 1;
const LABEL_FONT = "600 11px ui-monospace, Menlo, monospace";

const toPoints = (samples: Replay["cars"][number]["samples"]): Point[] =>
  samples.map((s) => ({ x: s.x, y: s.y }));

/**
 * Precompute the static parts of a replay's scene.
 *
 * The ribbon is traced from the FIRST car's lap: every car in a replay drives the
 * same circuit, so one lap is the track. That is a choice of source, not a branch
 * on car count — bounds below still span every car, so nothing can be fitted out
 * of frame when `cars` has twenty entries (rule 2).
 */
export function buildScene(replay: Replay): Scene {
  const { rotation } = replay.meta;
  const carPaths = replay.cars.map((car) =>
    rotateWorld(toPoints(car.samples), rotation),
  );
  const ribbon = carPaths[0];
  const centre = centroid(ribbon);

  return {
    ribbon,
    carPaths,
    // The bucket of the segment LEAVING sample k, so index k is the trail segment
    // k → k+1. The last entry is only ever used by the head segment.
    carBuckets: replay.cars.map((car) =>
      Uint8Array.from(car.samples, (s) => bucketOf(s.speed)),
    ),
    bounds: computeBounds(carPaths.flat()),
    rotationDeg: rotation,
    carColors: replay.cars.map((car) => car.color),
    tailSegments: Math.max(
      1,
      Math.round(TAIL_SECONDS * replay.meta.sampleRateHz),
    ),
    corners: replay.track.corners.map((corner) => {
      const at = rotatePoint({ x: corner.x, y: corner.y }, rotation);
      return {
        at,
        dir: labelDirection(at, ribbon, centre),
        // `letter` is "" for a plain numbered corner and "A"/"B" for a named
        // complex, so concatenating covers both without branching.
        text: `${corner.number}${corner.letter}`,
      };
    }),
    startFinish: startFinishOf(replay, rotation, ribbon, centre),
  };
}

function startFinishOf(
  replay: Replay,
  rotation: number,
  ribbon: readonly Point[],
  centre: Point,
): Scene["startFinish"] {
  const { x, y, angle } = replay.track.startFinish;
  const at = rotatePoint({ x, y }, rotation);
  return {
    at,
    // The schema stores a WORLD-space angle, and the track is drawn rotated, so it
    // needs the same correction the car's heading tick does — otherwise the line
    // sits across the track at `rotation` degrees off square. See `rotateHeading`.
    angle: rotateHeading(angle, rotation),
    dir: labelDirection(at, ribbon, centre),
  };
}

/**
 * Paint one frame, back to front: track outline, trail, start/finish, corner badges,
 * then the cars on top.
 *
 * Allocates nothing per car except the two small points the transform returns. The
 * ribbon and the trail are retained `Path2D`s built at measure time, so lap length
 * costs nothing here.
 *
 * @param focusedIndex which car wears the full thermal trail and the bright marker.
 *        Every other car gets a short team-coloured tail instead. This is a per-car
 *        PROPERTY test inside the existing loop — nothing here branches on how many
 *        cars there are, and a one-car replay takes the focused path exactly as it
 *        did before focus existed. An index outside `cars` simply focuses nobody,
 *        which degrades to all-tails rather than to a crash; the store's `setReplay`
 *        is what keeps it in range.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  paths: ScenePaths,
  view: Viewport,
  snapshots: readonly CarSnapshot[],
  colors: ChromeColors,
  focusedIndex: number,
): void {
  // Draw in CSS pixels; the backing store is `dpr` times larger.
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawRibbon(ctx, paths.ribbon, colors);

  // Car positions are needed twice — by the trail's head segment here, and by the
  // marker after the chrome — so they are computed once into a scratch buffer that
  // was allocated at measure time. Recomputing them in the second pass would be
  // cheap; allocating a point array per frame to carry them would not.
  const at = paths.carPositions;
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    // Rotation is linear, so rotating the interpolated position is identical to
    // interpolating between rotated positions.
    const p = applyTransform(
      rotatePoint(snapshot, scene.rotationDeg),
      view.fit,
    );
    at[i * 2] = p.x;
    at[i * 2 + 1] = p.y;

    if (i === focusedIndex) {
      const trail = paths.trails[i];
      trail.syncTo(snapshot.index);
      trail.stroke(ctx);
      // The trail's last whole segment ends at sample `index`; the car is up to one
      // grid step past it. This closes that gap — and it belongs in THIS pass, with
      // the rest of the trail: drawn later it would paint over the corner badges that
      // every other trail segment passes under, and with twenty cars each car's head
      // would paint over its neighbours' chrome.
      trail.strokeHead(ctx, snapshot.index, p.x, p.y);
    } else {
      // Unfocused cars are never `syncTo`'d, so an unfocused `TrailPainter` costs
      // nothing at all — that is where the twenty-car saving is. Refocusing one
      // rebuilds it in a single frame, the same one-off a lap wrap already pays.
      paths.tails[i].stroke(ctx, snapshot.index, p.x, p.y, scene.carColors[i]);
    }
  }

  drawStartFinish(ctx, paths, colors);
  drawCorners(ctx, paths, colors);

  for (let i = 0; i < snapshots.length; i++) {
    // The heading arrives in WORLD space; the points around it were rotated. Without
    // this the marker points `rotationDeg` off the direction it is visibly travelling
    // — see `rotateHeading`.
    const heading = rotateHeading(snapshots[i].heading, scene.rotationDeg);
    const draw = i === focusedIndex ? drawFocusedCar : drawUnfocusedCar;
    draw(ctx, at[i * 2], at[i * 2 + 1], heading, scene.carColors[i], colors);
  }
}

/** The faint closed loop of the circuit: a light edge with a darker fill on top. */
function drawRibbon(
  ctx: CanvasRenderingContext2D,
  ribbon: Path2D,
  colors: ChromeColors,
): void {
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = TRACK_EDGE_WIDTH;
  ctx.stroke(ribbon);
  ctx.strokeStyle = colors.trackFill;
  ctx.lineWidth = TRACK_FILL_WIDTH;
  ctx.stroke(ribbon);
}

/** The line across the track where the lap begins and ends. */
function drawStartFinish(
  ctx: CanvasRenderingContext2D,
  paths: ScenePaths,
  colors: ChromeColors,
): void {
  const { from, to, label } = paths.startFinish;
  ctx.strokeStyle = colors.txt;
  ctx.lineWidth = MARK_WIDTH;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colors.dim;
  ctx.fillText("S/F", label.x, label.y);
}

/**
 * Corner numbers, drawn OFF the racing line with a leader back to the corner.
 *
 * On the line they would sit on top of the trail, which is the one thing on the
 * canvas worth looking at — see `geometry.labelDirection`.
 */
function drawCorners(
  ctx: CanvasRenderingContext2D,
  paths: ScenePaths,
  colors: ChromeColors,
): void {
  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const corner of paths.corners) {
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = HAIRLINE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(corner.on.x, corner.on.y);
    ctx.lineTo(corner.badge.x, corner.badge.y);
    ctx.stroke();

    ctx.fillStyle = colors.panel2;
    ctx.beginPath();
    ctx.arc(
      corner.badge.x,
      corner.badge.y,
      CORNER_BADGE_RADIUS,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = colors.dim;
    ctx.fillText(corner.text, corner.badge.x, corner.badge.y);
  }
}

/**
 * The focused car: a glowing dot in the car's colour with a tick for its heading.
 *
 * Unchanged from before focus existed, deliberately — no selection ring, no extra
 * emphasis. Everything that distinguishes focus is subtracted from the OTHER cars, so
 * a one-car replay draws exactly the calls it always drew.
 */
function drawFocusedCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  headingRad: number,
  carColor: string,
  colors: ChromeColors,
): void {
  ctx.shadowColor = carColor;
  ctx.shadowBlur = 18;
  ctx.fillStyle = carColor;
  ctx.beginPath();
  ctx.arc(x, y, CAR_GLOW_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = colors.bg;
  ctx.beginPath();
  ctx.arc(x, y, CAR_CORE_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = carColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(
    x + Math.cos(headingRad) * CAR_HEADING_LENGTH,
    y + Math.sin(headingRad) * CAR_HEADING_LENGTH,
  );
  ctx.stroke();
}

/**
 * Every other car: the same marker, smaller, dimmer, and without the glow.
 *
 * The glow is what carries the focused car across a crowded canvas, so it is the one
 * thing an unfocused car may not have — at twenty cars, twenty glows would fill the
 * circuit with light and the eye would have nothing to land on.
 */
function drawUnfocusedCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  headingRad: number,
  carColor: string,
  colors: ChromeColors,
): void {
  ctx.globalAlpha = UNFOCUSED_ALPHA;

  ctx.fillStyle = carColor;
  ctx.beginPath();
  ctx.arc(x, y, UNFOCUSED_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = colors.bg;
  ctx.beginPath();
  ctx.arc(x, y, UNFOCUSED_CORE_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = carColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(
    x + Math.cos(headingRad) * UNFOCUSED_HEADING_LENGTH,
    y + Math.sin(headingRad) * UNFOCUSED_HEADING_LENGTH,
  );
  ctx.stroke();

  ctx.globalAlpha = 1;
}
