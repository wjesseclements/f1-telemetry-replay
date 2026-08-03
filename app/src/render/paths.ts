/**
 * paths.ts — everything that depends on the viewport but not on the clock.
 *
 * Three cadences run this renderer, and this file is the middle one. `scene.ts`
 * computes what depends only on the replay (rotation, bounds, speed buckets);
 * `drawFrame` does what depends on the clock; and this does what changes only when
 * the canvas is resized — which is to say, almost never.
 *
 * That is where world→screen belongs. Slice 4a applied `applyTransform` to every
 * ribbon point inside the frame callback, allocating one point object per sample per
 * frame (~585 objects every 16 ms on the fixture) to redraw a line that had not
 * moved. Here the same work happens once per resize, into a retained `Path2D` and a
 * flat `Float64Array`, and the frame callback allocates nothing.
 */
import {
  applyTransform,
  type FitTransform,
  type Point,
} from "../engine/geometry";
import { TailPainter, TrailPainter } from "./trail";
import type { Scene } from "./scene";

/** How far off the racing line a corner number sits, in CSS pixels. */
export const CORNER_OFFSET_PX = 19;
/** Half-length of the start/finish line across the track, in CSS pixels. */
export const START_FINISH_HALF_PX = 11;
/** How far off the track the `S/F` label sits, in CSS pixels. */
export const START_FINISH_LABEL_PX = 17;

/** A corner number's badge, and the point on track it belongs to. */
export interface CornerLabel {
  /** Where the badge is drawn — off the racing line. */
  badge: Point;
  /** The corner's actual position, where the leader line lands. */
  on: Point;
  text: string;
}

/** The start/finish line: a stroke across the track, plus its label anchor. */
export interface StartFinishMark {
  from: Point;
  to: Point;
  label: Point;
}

/** Screen-space scene: valid for one viewport, rebuilt on resize. */
export interface ScenePaths {
  /** The closed track outline, retained so the frame does not rebuild it. */
  ribbon: Path2D;
  /** One trail painter per car, in `replay.cars` order (rule 2: an array). */
  trails: readonly TrailPainter[];
  /**
   * One tail painter per car, over the SAME screen coordinates as `trails[i]`.
   *
   * Both painters exist for every car because which one is drawn is decided per frame
   * by which car is focused, and focus changes with a keypress. Building both costs
   * one object each — the projected coordinates, which are the only thing with a size,
   * are shared.
   */
  tails: readonly TailPainter[];
  corners: readonly CornerLabel[];
  startFinish: StartFinishMark;
  /**
   * Scratch space for this frame's car positions, `[x0, y0, x1, y1, …]`.
   *
   * The trail's head segment and the car marker need the same screen position, but
   * they are drawn in different passes — the head with the rest of the trail, under
   * the chrome; the marker on top of it. Carrying the positions between passes in a
   * buffer allocated here keeps that split free; a per-frame array would reintroduce
   * exactly the allocation this file exists to remove.
   */
  carPositions: Float64Array;
}

/**
 * Project a scene into screen space for one viewport.
 *
 * Called from `measure()` on mount and on resize. Everything it returns is either
 * retained (the ribbon path, the trail painters) or plain precomputed points; nothing
 * downstream recomputes a transform per frame.
 *
 * Note the trail painters are built fresh here, which resets them. That is correct
 * rather than incidental: a painter's whole state is how many segments it has
 * appended, so a new one refills to exactly the covered portion on the next frame at
 * the new scale. `TrackCanvas.test.tsx` pins that behaviour on a mid-lap resize.
 */
export function buildScenePaths(scene: Scene, fit: FitTransform): ScenePaths {
  // Projected once per car and handed to BOTH painters: the trail and the tail draw
  // the same geometry, and a second copy would double the only allocation here that
  // scales with window length.
  const screens = scene.carPaths.map((pts) => toScreenArray(pts, fit));

  return {
    ribbon: buildRibbonPath(scene.ribbon, fit),
    trails: screens.map(
      (screen, i) => new TrailPainter(screen, scene.carBuckets[i]),
    ),
    tails: screens.map((screen) => new TailPainter(screen, scene.tailSegments)),
    corners: scene.corners.map((corner) => ({
      badge: offsetBy(corner.at, corner.dir, CORNER_OFFSET_PX, fit),
      on: applyTransform(corner.at, fit),
      text: corner.text,
    })),
    startFinish: buildStartFinish(scene, fit),
    carPositions: new Float64Array(scene.carPaths.length * 2),
  };
}

/** Sample positions as a flat `[x0, y0, x1, y1, …]` — no point objects to walk. */
function toScreenArray(pts: readonly Point[], fit: FitTransform): Float64Array {
  const out = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    out[i * 2] = pts[i].x * fit.scale + fit.offsetX;
    out[i * 2 + 1] = pts[i].y * fit.scale + fit.offsetY;
  }
  return out;
}

/** The circuit outline as one retained closed path. */
function buildRibbonPath(ribbon: readonly Point[], fit: FitTransform): Path2D {
  const path = new Path2D();
  if (ribbon.length === 0) return path;

  const first = applyTransform(ribbon[0], fit);
  path.moveTo(first.x, first.y);
  for (let i = 1; i < ribbon.length; i++) {
    const p = applyTransform(ribbon[i], fit);
    path.lineTo(p.x, p.y);
  }
  // A lap ends where it starts, so the outline is closed rather than left with a gap
  // across the start/finish line.
  path.closePath();
  return path;
}

/**
 * A point pushed `px` screen pixels along a world-space unit direction.
 *
 * The offset is applied AFTER the transform so it is a fixed pixel distance at every
 * zoom level — a badge 19 px clear of the track stays 19 px clear when the window is
 * resized. `fitTransform` is a uniform scale plus a translation with no flip, so a
 * unit direction in rotated-world space is the same direction on screen.
 */
function offsetBy(at: Point, dir: Point, px: number, fit: FitTransform): Point {
  const p = applyTransform(at, fit);
  return { x: p.x + dir.x * px, y: p.y + dir.y * px };
}

function buildStartFinish(scene: Scene, fit: FitTransform): StartFinishMark {
  const { at, angle, dir } = scene.startFinish;
  const p = applyTransform(at, fit);
  // Perpendicular to the direction of travel, so the line lies ACROSS the track.
  const nx = Math.cos(angle + Math.PI / 2);
  const ny = Math.sin(angle + Math.PI / 2);

  return {
    from: {
      x: p.x + nx * START_FINISH_HALF_PX,
      y: p.y + ny * START_FINISH_HALF_PX,
    },
    to: {
      x: p.x - nx * START_FINISH_HALF_PX,
      y: p.y - ny * START_FINISH_HALF_PX,
    },
    label: offsetBy(at, dir, START_FINISH_LABEL_PX, fit),
  };
}
