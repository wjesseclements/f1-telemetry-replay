/**
 * ScenePaths tests — the corner badges and the start/finish mark.
 *
 * The maths these lean on is unit-tested in `engine/geometry`; what is asserted here
 * is the wiring, which is where the two mistakes that actually happen live: offsetting
 * in world units instead of screen pixels (badges that drift as you resize), and
 * forgetting that a stored angle is in world space (a start/finish line sitting across
 * the track at `meta.rotation` degrees off square).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixtureReplay } from "../data/fixture";
import { fitTransform, applyTransform, rotatePoint } from "../engine/geometry";
import { installCanvasEnvironment } from "../test/canvas";
import {
  buildScenePaths,
  CORNER_OFFSET_PX,
  START_FINISH_HALF_PX,
} from "./paths";
import { buildScene } from "./scene";
import { PAD_PX } from "./TrackCanvas";

const replay = loadFixtureReplay();
const scene = buildScene(replay);
const fit = fitTransform(scene.bounds, 800, 600, PAD_PX);

beforeEach(() => {
  // Only for `Path2D`, which jsdom does not provide.
  installCanvasEnvironment(800, 600);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildScenePaths corners", () => {
  it("labels every corner in the replay", () => {
    const paths = buildScenePaths(scene, fit);
    expect(paths.corners).toHaveLength(replay.track.corners.length);
    expect(paths.corners.map((c) => c.text)).toEqual(
      replay.track.corners.map((c) => `${c.number}${c.letter}`),
    );
  });

  it("anchors the leader line on the corner itself", () => {
    const paths = buildScenePaths(scene, fit);
    replay.track.corners.forEach((corner, i) => {
      const want = applyTransform(
        rotatePoint({ x: corner.x, y: corner.y }, replay.meta.rotation),
        fit,
      );
      expect(paths.corners[i].on.x).toBeCloseTo(want.x, 9);
      expect(paths.corners[i].on.y).toBeCloseTo(want.y, 9);
    });
  });

  it("puts the badge exactly CORNER_OFFSET_PX off the corner, in screen pixels", () => {
    const paths = buildScenePaths(scene, fit);
    for (const corner of paths.corners) {
      expect(
        Math.hypot(corner.badge.x - corner.on.x, corner.badge.y - corner.on.y),
        corner.text,
      ).toBeCloseTo(CORNER_OFFSET_PX, 6);
    }
  });

  it("keeps that offset a constant pixel distance at any zoom", () => {
    // The bug this catches: offsetting before the transform, so badges creep toward
    // the track as the window shrinks and away from it as it grows.
    const big = buildScenePaths(
      scene,
      fitTransform(scene.bounds, 1600, 1200, PAD_PX),
    );
    for (const corner of big.corners) {
      expect(
        Math.hypot(corner.badge.x - corner.on.x, corner.badge.y - corner.on.y),
        corner.text,
      ).toBeCloseTo(CORNER_OFFSET_PX, 6);
    }
  });

  it("moves the badge clear of the racing line", () => {
    // Every badge must be further from the nearest point of the track than it would
    // be sitting on the corner — i.e. the offset actually points away from the road.
    const paths = buildScenePaths(scene, fit);
    const ribbon = scene.ribbon.map((p) => applyTransform(p, fit));

    for (const corner of paths.corners) {
      let nearest = Infinity;
      for (const p of ribbon) {
        nearest = Math.min(
          nearest,
          Math.hypot(p.x - corner.badge.x, p.y - corner.badge.y),
        );
      }
      // Half the trail's width plus the badge's radius is the point of the offset:
      // clearing the painted line rather than merely being distinct from the corner.
      expect(nearest, corner.text).toBeGreaterThan(CORNER_OFFSET_PX / 2);
    }
  });
});

describe("buildScenePaths startFinish", () => {
  it("centres the line on the start/finish point", () => {
    const { startFinish } = buildScenePaths(scene, fit);
    const want = applyTransform(
      rotatePoint(
        { x: replay.track.startFinish.x, y: replay.track.startFinish.y },
        replay.meta.rotation,
      ),
      fit,
    );
    expect((startFinish.from.x + startFinish.to.x) / 2).toBeCloseTo(want.x, 9);
    expect((startFinish.from.y + startFinish.to.y) / 2).toBeCloseTo(want.y, 9);
  });

  it("spans START_FINISH_HALF_PX either side", () => {
    const { startFinish } = buildScenePaths(scene, fit);
    expect(
      Math.hypot(
        startFinish.to.x - startFinish.from.x,
        startFinish.to.y - startFinish.from.y,
      ),
    ).toBeCloseTo(START_FINISH_HALF_PX * 2, 6);
  });

  it("lies ACROSS the track, using the rotated angle not the stored one", () => {
    const { startFinish } = buildScenePaths(scene, fit);
    const lineAngle = Math.atan2(
      startFinish.to.y - startFinish.from.y,
      startFinish.to.x - startFinish.from.x,
    );

    // The direction the car is actually travelling on screen at the line.
    const [a, b] = [scene.ribbon[0], scene.ribbon[1]].map((p) =>
      applyTransform(p, fit),
    );
    const travel = Math.atan2(b.y - a.y, b.x - a.x);

    // Perpendicular: cos of the angle between them is 0. The tolerance is 0.01
    // rather than exact because `track.startFinish.angle` is stored to 6 decimal
    // places and the sample 0→1 direction is recomputed from rounded coordinates —
    // they differ by about 0.3°, which is data precision, not a wiring error.
    expect(Math.abs(Math.cos(lineAngle - travel))).toBeLessThan(0.01);

    // And the WORLD angle would not have been perpendicular — it is off by exactly
    // `meta.rotation`, giving |cos| ≈ sin(14°) ≈ 0.24, twenty times the tolerance
    // above. This is the same world-vs-screen trap the heading tick fell into, so it
    // is pinned negatively too.
    const worldAngle = replay.track.startFinish.angle + Math.PI / 2;
    expect(Math.abs(Math.cos(worldAngle - travel))).toBeGreaterThan(0.2);
  });
});
