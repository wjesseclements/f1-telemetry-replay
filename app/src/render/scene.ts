/**
 * scene.ts — canvas drawing, split into what is computed once and what is painted
 * every frame.
 *
 * `buildScene` runs once per replay: rotating a lap's worth of points and measuring
 * their bounds is O(samples) and the result never changes, so it must not happen in
 * the animation loop. `drawFrame` runs 60 times a second and does only per-car work.
 *
 * Everything geometric here delegates to `src/engine/geometry.ts`; this module owns
 * the canvas calls and nothing else (CLAUDE.md architecture rule 4 keeps the maths
 * out of the renderer, and the renderer out of the engine).
 */
import type { CarSnapshot } from "../engine/interpolate";
import {
  applyTransform,
  computeBounds,
  rotateHeading,
  rotateWorld,
  type Bounds,
  type FitTransform,
  type Point,
} from "../engine/geometry";
import type { Replay } from "../engine/schema";
import type { ChromeColors } from "./palette";

/** Everything about a replay that can be computed before the clock starts. */
export interface Scene {
  /** The track ribbon, in rotated world coordinates. */
  ribbon: readonly Point[];
  /** Bounds of every car's rotated path — what the viewport is fitted to. */
  bounds: Bounds;
  /** `meta.rotation`, needed per frame to bring car headings into screen space. */
  rotationDeg: number;
  /** Car colours, in `replay.cars` order — parallel to the snapshot array. */
  carColors: readonly string[];
}

/** Where the scene is being drawn, recomputed on resize only. */
export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  fit: FitTransform;
}

const TRACK_EDGE_WIDTH = 13;
const TRACK_FILL_WIDTH = 9;
const CAR_GLOW_RADIUS = 6.5;
const CAR_CORE_RADIUS = 3;
const CAR_HEADING_LENGTH = 12;

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
  const ribbon = rotateWorld(toPoints(replay.cars[0].samples), rotation);
  const allPoints = replay.cars.flatMap((car) =>
    rotateWorld(toPoints(car.samples), rotation),
  );

  return {
    ribbon,
    bounds: computeBounds(allPoints),
    rotationDeg: rotation,
    carColors: replay.cars.map((car) => car.color),
  };
}

/** Paint one frame: clear, track ribbon, then one marker per car. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: Viewport,
  snapshots: readonly CarSnapshot[],
  colors: ChromeColors,
): void {
  // Draw in CSS pixels; the backing store is `dpr` times larger.
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);

  drawRibbon(ctx, scene.ribbon, view.fit, colors);

  // Rotate every car's position in one call, then pair by index: `sampleAt`
  // returns snapshots in `replay.cars` order, which is `scene.carColors` order.
  // Rotation is linear, so rotating the interpolated position is identical to
  // interpolating between rotated positions.
  const rotated = rotateWorld(snapshots, scene.rotationDeg);
  rotated.forEach((p, i) => {
    drawCar(
      ctx,
      applyTransform(p, view.fit),
      // The heading arrives in WORLD space; the points around it were rotated.
      // Without this the marker points `rotationDeg` off the direction it is
      // visibly travelling — see `rotateHeading`.
      rotateHeading(snapshots[i].heading, scene.rotationDeg),
      scene.carColors[i],
      colors,
    );
  });
}

/** The faint closed loop of the circuit: a light edge with a darker fill on top. */
function drawRibbon(
  ctx: CanvasRenderingContext2D,
  ribbon: readonly Point[],
  fit: FitTransform,
  colors: ChromeColors,
): void {
  if (ribbon.length === 0) return;

  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  const first = applyTransform(ribbon[0], fit);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < ribbon.length; i++) {
    const p = applyTransform(ribbon[i], fit);
    ctx.lineTo(p.x, p.y);
  }
  // A lap ends where it starts, so the ribbon is closed rather than left with a
  // gap across the start/finish line.
  ctx.closePath();

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = TRACK_EDGE_WIDTH;
  ctx.stroke();
  ctx.strokeStyle = colors.trackFill;
  ctx.lineWidth = TRACK_FILL_WIDTH;
  ctx.stroke();
}

/** One car: a glowing dot in the car's colour with a tick for its heading. */
function drawCar(
  ctx: CanvasRenderingContext2D,
  at: Point,
  headingRad: number,
  carColor: string,
  colors: ChromeColors,
): void {
  ctx.shadowColor = carColor;
  ctx.shadowBlur = 18;
  ctx.fillStyle = carColor;
  ctx.beginPath();
  ctx.arc(at.x, at.y, CAR_GLOW_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = colors.bg;
  ctx.beginPath();
  ctx.arc(at.x, at.y, CAR_CORE_RADIUS, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = carColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(
    at.x + Math.cos(headingRad) * CAR_HEADING_LENGTH,
    at.y + Math.sin(headingRad) * CAR_HEADING_LENGTH,
  );
  ctx.stroke();
}
