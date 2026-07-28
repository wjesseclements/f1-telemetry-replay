/**
 * Geometry tests — rotation, bounds and viewport fit.
 *
 * Expected values are hand-computed from the formulas, not snapshotted from the
 * implementation, so a sign flip or a transposed term fails here rather than showing
 * up as a mirrored track in Slice 4a.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import {
  applyTransform,
  computeBounds,
  fitTransform,
  rotateWorld,
  type Point,
} from "./geometry";

const replay = parseReplay(sampleLap, "sample-lap.json");
const lapPoints: Point[] = replay.cars[0].samples.map((s) => ({
  x: s.x,
  y: s.y,
}));

describe("rotateWorld", () => {
  it("is the identity at 0 degrees", () => {
    const pts: Point[] = [
      { x: 3, y: -7 },
      { x: 0, y: 0 },
    ];
    expect(rotateWorld(pts, 0)).toEqual(pts);
  });

  it("rotates 90 degrees as x' = -y, y' = x", () => {
    const [p] = rotateWorld([{ x: 1, y: 0 }], 90);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(1, 12);

    const [q] = rotateWorld([{ x: 0, y: 1 }], 90);
    expect(q.x).toBeCloseTo(-1, 12);
    expect(q.y).toBeCloseTo(0, 12);
  });

  it("rotates 180 degrees to the negation", () => {
    const [p] = rotateWorld([{ x: 5, y: -2 }], 180);
    expect(p.x).toBeCloseTo(-5, 12);
    expect(p.y).toBeCloseTo(2, 12);
  });

  it("matches the hand-computed value at the fixture's -14 degrees", () => {
    const rad = (-14 * Math.PI) / 180;
    const [p] = rotateWorld([{ x: 152.4, y: 1092.2 }], replay.meta.rotation);
    expect(replay.meta.rotation).toBe(-14);
    expect(p.x).toBeCloseTo(152.4 * Math.cos(rad) - 1092.2 * Math.sin(rad), 9);
    expect(p.y).toBeCloseTo(152.4 * Math.sin(rad) + 1092.2 * Math.cos(rad), 9);
  });

  it("round-trips: rotating by -theta undoes theta", () => {
    const back = rotateWorld(rotateWorld(lapPoints, -14), 14);
    for (const k of [0, 1, 200, lapPoints.length - 1]) {
      expect(back[k].x, `x at ${k}`).toBeCloseTo(lapPoints[k].x, 9);
      expect(back[k].y, `y at ${k}`).toBeCloseTo(lapPoints[k].y, 9);
    }
  });

  it("preserves length — one output point per input point", () => {
    expect(rotateWorld(lapPoints, -14)).toHaveLength(lapPoints.length);
    expect(rotateWorld([], 42)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const pts: Point[] = [{ x: 1, y: 2 }];
    rotateWorld(pts, 90);
    expect(pts).toEqual([{ x: 1, y: 2 }]);
  });
});

describe("computeBounds", () => {
  it("finds the extremes, including negatives", () => {
    expect(
      computeBounds([
        { x: 1, y: 5 },
        { x: -3, y: 2 },
        { x: 4, y: -8 },
      ]),
    ).toEqual({ minX: -3, minY: -8, maxX: 4, maxY: 5 });
  });

  it("collapses to a point for a single input", () => {
    expect(computeBounds([{ x: 2, y: 3 }])).toEqual({
      minX: 2,
      minY: 3,
      maxX: 2,
      maxY: 3,
    });
  });

  it("measures the fixture lap", () => {
    const b = computeBounds(lapPoints);
    expect(b.minX).toBeCloseTo(102, 6);
    expect(b.maxX).toBeCloseTo(1150, 6);
    expect(b.minY).toBeCloseTo(197.9, 6);
    expect(b.maxY).toBeCloseTo(1147.2, 6);
  });

  it("throws on an empty array rather than returning infinities", () => {
    expect(() => computeBounds([])).toThrow(RangeError);
    expect(() => computeBounds([])).toThrow(/at least one point/);
  });
});

describe("fitTransform", () => {
  const square = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("fits to the tighter axis and centres on the slack one", () => {
    // 100x100 into 400x200 with pad 20: avail 360x160, so height binds at 1.6.
    const t = fitTransform(square, 400, 200, 20);
    expect(t.scale).toBeCloseTo(1.6, 12);
    expect(t.offsetX).toBeCloseTo((400 - 160) / 2, 12); // 120
    expect(t.offsetY).toBeCloseTo((200 - 160) / 2, 12); // 20
  });

  it("puts the bounds corners exactly on the padded edges of the binding axis", () => {
    const t = fitTransform(square, 400, 200, 20);
    const topLeft = applyTransform({ x: 0, y: 0 }, t);
    const bottomRight = applyTransform({ x: 100, y: 100 }, t);
    expect(topLeft.y).toBeCloseTo(20, 9); // == pad
    expect(bottomRight.y).toBeCloseTo(180, 9); // == height - pad
    // and stays inside the padding on the slack axis
    expect(topLeft.x).toBeGreaterThanOrEqual(20);
    expect(bottomRight.x).toBeLessThanOrEqual(380);
  });

  it("honours padding: more padding means a smaller scale", () => {
    const tight = fitTransform(square, 400, 400, 0);
    const padded = fitTransform(square, 400, 400, 50);
    expect(tight.scale).toBeCloseTo(4, 12);
    expect(padded.scale).toBeCloseTo(3, 12);
  });

  it("offsets a non-origin bounds so it still centres", () => {
    const shifted = { minX: 1000, minY: 1000, maxX: 1100, maxY: 1100 };
    const t = fitTransform(shifted, 400, 400, 0);
    const centre = applyTransform({ x: 1050, y: 1050 }, t);
    expect(centre.x).toBeCloseTo(200, 9);
    expect(centre.y).toBeCloseTo(200, 9);
  });

  it("keeps the fixture lap inside the padded viewport", () => {
    const b = computeBounds(rotateWorld(lapPoints, replay.meta.rotation));
    const t = fitTransform(b, 900, 600, 46);
    for (const p of rotateWorld(lapPoints, replay.meta.rotation)) {
      const s = applyTransform(p, t);
      expect(s.x).toBeGreaterThanOrEqual(46 - 1e-9);
      expect(s.x).toBeLessThanOrEqual(900 - 46 + 1e-9);
      expect(s.y).toBeGreaterThanOrEqual(46 - 1e-9);
      expect(s.y).toBeLessThanOrEqual(600 - 46 + 1e-9);
    }
  });

  it("falls back to scale 1 for a point-like bounds instead of dividing by zero", () => {
    const t = fitTransform(
      { minX: 5, minY: 5, maxX: 5, maxY: 5 },
      400,
      200,
      20,
    );
    expect(t.scale).toBe(1);
    expect(applyTransform({ x: 5, y: 5 }, t)).toEqual({ x: 200, y: 100 });
  });

  it("lets a single unconstrained axis take the other axis's scale", () => {
    // Zero height: only width constrains, so scale comes from x alone.
    const t = fitTransform(
      { minX: 0, minY: 7, maxX: 100, maxY: 7 },
      400,
      200,
      0,
    );
    expect(t.scale).toBeCloseTo(4, 12);
  });

  it("clamps to scale 0 rather than mirroring when padding exceeds the viewport", () => {
    const t = fitTransform(square, 100, 100, 80);
    expect(t.scale).toBe(0);
    expect(t.scale).not.toBeLessThan(0);
  });
});

describe("applyTransform", () => {
  it("applies scale then offset, with no y flip", () => {
    const t = { scale: 2, offsetX: 10, offsetY: -5 };
    expect(applyTransform({ x: 3, y: 4 }, t)).toEqual({ x: 16, y: 3 });
  });

  it("keeps screen y increasing with world y", () => {
    const t = fitTransform(
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      100,
      100,
      0,
    );
    const low = applyTransform({ x: 0, y: 0 }, t);
    const high = applyTransform({ x: 0, y: 10 }, t);
    expect(high.y).toBeGreaterThan(low.y);
  });
});
