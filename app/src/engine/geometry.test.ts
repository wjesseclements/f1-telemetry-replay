/**
 * Geometry tests — world→screen orientation, bounds and viewport fit.
 *
 * Expected values are hand-computed from the formulas, not snapshotted from the
 * implementation, so a sign flip or a transposed term fails here.
 *
 * That claim was not enough on its own, and Slice 9f is why. Every expectation below
 * was internally consistent AND WRONG for four months: they all encoded a rotation
 * with no y negation, so the hand-computed values agreed perfectly with an
 * implementation that drew every real circuit mirrored. Hand-computing from the
 * formula cannot catch a formula that is missing a term.
 *
 * What catches it is a test of a PROPERTY the defect must violate rather than of the
 * arithmetic: `reverses circulation, which no rotation can do`. Signed area's sign is
 * circulation direction; rotations preserve it, reflections invert it. See
 * `PLAN.md` §Slice 9f.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import {
  applyTransform,
  centroid,
  computeBounds,
  fitTransform,
  labelDirection,
  toScreenHeading,
  toScreenPoint,
  toScreenPoints,
  type Point,
} from "./geometry";

const replay = parseReplay(sampleLap, "sample-lap.json");
const lapPoints: Point[] = replay.cars[0].samples.map((s) => ({
  x: s.x,
  y: s.y,
}));
const rotation = replay.meta.rotation;

/**
 * Twice the signed area of a closed polygon (the shoelace sum).
 *
 * Only its SIGN is used, and that sign is the polygon's circulation direction — the
 * one property a rotation cannot change and a reflection always does. Doubling is
 * left in because halving it would add a division that no assertion needs.
 */
function signedArea(pts: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

describe("toScreenPoints", () => {
  // Every expectation here carries the y NEGATION as well as the rotation. That is
  // the whole of Slice 9f: FastF1's frame is y-up, the canvas is y-down, and these
  // tests previously encoded the missing flip as if it were correct.

  it("negates y even at 0 degrees — the flip is not part of the rotation", () => {
    const pts: Point[] = [
      { x: 3, y: -7 },
      { x: 0, y: 0 },
    ];
    // NOT the identity, and that is the point: a zero-rotation circuit still has to
    // be turned the right way up for the canvas.
    expect(toScreenPoints(pts, 0)).toEqual([
      { x: 3, y: 7 },
      { x: 0, y: -0 },
    ]);
  });

  it("rotates 90 degrees, then flips: x' = -y, y' = -x", () => {
    const [p] = toScreenPoints([{ x: 1, y: 0 }], 90);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(-1, 12);

    const [q] = toScreenPoints([{ x: 0, y: 1 }], 90);
    expect(q.x).toBeCloseTo(-1, 12);
    expect(q.y).toBeCloseTo(0, 12);
  });

  it("rotates 180 degrees to the negation in x only, y coming back round", () => {
    const [p] = toScreenPoints([{ x: 5, y: -2 }], 180);
    expect(p.x).toBeCloseTo(-5, 12);
    expect(p.y).toBeCloseTo(-2, 12);
  });

  it("matches the hand-computed value at the fixture's -14 degrees", () => {
    const rad = (-14 * Math.PI) / 180;
    const [p] = toScreenPoints([{ x: 152.4, y: 1092.2 }], replay.meta.rotation);
    expect(replay.meta.rotation).toBe(-14);
    expect(p.x).toBeCloseTo(152.4 * Math.cos(rad) - 1092.2 * Math.sin(rad), 9);
    expect(p.y).toBeCloseTo(
      -(152.4 * Math.sin(rad) + 1092.2 * Math.cos(rad)),
      9,
    );
  });

  it("is its own inverse in y: applying it twice restores the world frame", () => {
    // `M·R(r)` twice is `M·R(r)·M·R(r)` = `R(-r)·R(r)` = identity, because M is an
    // involution and `M·R(r)·M = R(-r)`. A round trip therefore needs the SAME
    // angle twice, not opposite angles — which is the algebraic signature of a
    // reflection and would be false for a pure rotation.
    const back = toScreenPoints(toScreenPoints(lapPoints, -14), -14);
    for (const k of [0, 1, 200, lapPoints.length - 1]) {
      expect(back[k].x, `x at ${k}`).toBeCloseTo(lapPoints[k].x, 9);
      expect(back[k].y, `y at ${k}`).toBeCloseTo(lapPoints[k].y, 9);
    }
  });

  it("reverses circulation, which no rotation can do", () => {
    // The discriminator that caught the defect, as a test. Signed area's SIGN is
    // circulation direction; a rotation preserves it and a reflection inverts it.
    // An asymmetric path is required — see the `signedArea` helper's note.
    const before = signedArea(lapPoints);
    const after = signedArea(toScreenPoints(lapPoints, -14));
    expect(Math.sign(after)).toBe(-Math.sign(before));
    // ...and the magnitude is untouched, because a reflection is an isometry.
    expect(Math.abs(after)).toBeCloseTo(Math.abs(before), 6);
  });

  it("preserves length — one output point per input point", () => {
    expect(toScreenPoints(lapPoints, -14)).toHaveLength(lapPoints.length);
    expect(toScreenPoints([], 42)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const pts: Point[] = [{ x: 1, y: 2 }];
    toScreenPoints(pts, 90);
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
    const b = computeBounds(toScreenPoints(lapPoints, replay.meta.rotation));
    const t = fitTransform(b, 900, 600, 46);
    for (const p of toScreenPoints(lapPoints, replay.meta.rotation)) {
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

describe("toScreenHeading", () => {
  it("negates the sum of heading and rotation, because the frame is mirrored", () => {
    expect(toScreenHeading(0, 90)).toBeCloseTo(-Math.PI / 2, 12);
    expect(toScreenHeading(Math.PI / 2, -90)).toBeCloseTo(0, 12);
  });

  it("still negates at zero rotation — the flip is not part of the rotation", () => {
    // The angle counterpart of `toScreenPoints`' zero-degree case: a circuit with no
    // rotation still has its headings mirrored, because the canvas is still y-down.
    expect(toScreenHeading(0.206591, 0)).toBeCloseTo(-0.206591, 12);
  });

  it("normalises into atan2's range so it can be compared with a measured angle", () => {
    const r = toScreenHeading(3.0, 45);
    expect(r).toBeGreaterThan(-Math.PI);
    expect(r).toBeLessThanOrEqual(Math.PI);
    expect(r).toBeCloseTo(-(3.0 + Math.PI / 4) + 2 * Math.PI, 12);
  });

  it("matches the direction of travel measured in the DRAWN frame", () => {
    // The pin for the world-vs-screen heading bug. A world-space heading drawn
    // against rotated points is wrong by exactly `rotation` — invisible in the
    // car's position, visible only as a tick that points off-track. Measuring
    // atan2 from successive rotated+fitted points is the independent check.
    const { rotation } = replay.meta;
    const samples = replay.cars[0].samples;
    const fit = fitTransform(
      computeBounds(toScreenPoints(lapPoints, rotation)),
      800,
      600,
      40,
    );

    const gaps: number[] = [];
    for (const i of [0, 137, 400, samples.length - 2]) {
      const worldHeading = Math.atan2(
        samples[i + 1].y - samples[i].y,
        samples[i + 1].x - samples[i].x,
      );
      const [a, b] = toScreenPoints(
        [
          { x: samples[i].x, y: samples[i].y },
          { x: samples[i + 1].x, y: samples[i + 1].y },
        ],
        rotation,
      ).map((p) => applyTransform(p, fit));
      const drawnHeading = Math.atan2(b.y - a.y, b.x - a.x);

      expect(toScreenHeading(worldHeading, rotation)).toBeCloseTo(
        drawnHeading,
        10,
      );
      // Negative control, measured ACROSS the sampled points rather than at each
      // one. Per-index it is not sound: the discrepancy is |2h + r|, which passes
      // through zero when h approaches -r/2, so an honest implementation can agree
      // with the unadjusted heading at an isolated point by coincidence. At -14°
      // that happens near h = 7°, and it is what this control tripped on.
      gaps.push(Math.abs(worldHeading - drawnHeading));
    }
    // Somewhere in the lap the unadjusted heading must be plainly wrong, or this
    // test would pass against an implementation that did nothing at all.
    expect(Math.max(...gaps)).toBeGreaterThan(0.2);
  });
});

describe("toScreenPoint", () => {
  it("agrees with toScreenPoints point for point", () => {
    const pts = replay.cars[0].samples
      .slice(0, 50)
      .map((s) => ({ x: s.x, y: s.y }));
    const batch = toScreenPoints(pts, rotation);
    pts.forEach((p, i) => {
      const one = toScreenPoint(p, rotation);
      expect(one.x).toBeCloseTo(batch[i].x, 12);
      expect(one.y).toBeCloseTo(batch[i].y, 12);
    });
  });

  it("turns +x into -y at 90 degrees (rotation, then the flip)", () => {
    const p = toScreenPoint({ x: 1, y: 0 }, 90);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(-1, 12);
  });
});

describe("centroid", () => {
  it("is the arithmetic mean of the points", () => {
    expect(
      centroid([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 2, y: 6 },
      ]),
    ).toEqual({ x: 2, y: 2 });
  });

  it("throws on an empty array rather than returning NaN", () => {
    expect(() => centroid([])).toThrow(RangeError);
  });
});

describe("labelDirection", () => {
  /** A closed circular ribbon of radius `r` about the origin. */
  const circle = (r: number, n = 64): Point[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    });

  const ORIGIN = { x: 0, y: 0 };

  it("points radially outward on a circular track", () => {
    const dir = labelDirection({ x: 100, y: 0 }, circle(100), ORIGIN);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it("still points outward for a corner marked just inside the line", () => {
    const dir = labelDirection({ x: 90, y: 0 }, circle(100), ORIGIN);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it("wraps the tangent at the seam instead of taking a one-sided difference", () => {
    const ribbon = circle(100);
    // ribbon[0] is (100, 0): its neighbours are the LAST and the second sample.
    const dir = labelDirection(ribbon[0], ribbon, ORIGIN);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it("uses the track normal, not the radial direction, on an inner section", () => {
    // A straight run of track along the x-axis with the middle of the circuit off
    // to one side: radial and normal disagree, and the normal is the right answer.
    const ribbon: Point[] = [
      { x: -2, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    const dir = labelDirection({ x: 0, y: 0 }, ribbon, { x: 100, y: 50 });
    // Perpendicular to the track and on the far side from the centre.
    expect(dir.x).toBeCloseTo(0, 12);
    expect(dir.y).toBeCloseTo(-1, 12);
    // The radial direction would have been roughly (-0.89, -0.45) — pinned so the
    // cheaper "away from the centroid" implementation cannot pass this test.
    expect(dir.x).not.toBeCloseTo(-0.894, 2);
  });

  it("falls back to the radial direction when the tangent has no direction", () => {
    const stuck = [ORIGIN, ORIGIN, ORIGIN];
    const dir = labelDirection({ x: 3, y: 4 }, stuck, ORIGIN);
    expect(dir.x).toBeCloseTo(0.6, 12);
    expect(dir.y).toBeCloseTo(0.8, 12);
  });

  it("falls back to straight up when there is no direction at all", () => {
    const stuck = [ORIGIN, ORIGIN];
    expect(labelDirection(ORIGIN, stuck, ORIGIN)).toEqual({ x: 0, y: -1 });
  });

  it("throws on an empty ribbon", () => {
    expect(() => labelDirection(ORIGIN, [], ORIGIN)).toThrow(RangeError);
  });

  it("returns a unit vector perpendicular to the track at every fixture corner", () => {
    const ribbon = toScreenPoints(lapPoints, rotation);
    const centre = centroid(ribbon);
    expect(replay.track.corners.length).toBeGreaterThan(0);

    for (const corner of replay.track.corners) {
      const at = toScreenPoint({ x: corner.x, y: corner.y }, rotation);
      const dir = labelDirection(at, ribbon, centre);
      expect(Math.hypot(dir.x, dir.y), `corner ${corner.number}`).toBeCloseTo(
        1,
        12,
      );

      // Perpendicular to the local tangent — the defining property.
      let nearest = 0;
      let best = Infinity;
      ribbon.forEach((p, i) => {
        const d2 = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
        if (d2 < best) {
          best = d2;
          nearest = i;
        }
      });
      const n = ribbon.length;
      const prev = ribbon[(nearest - 1 + n) % n];
      const next = ribbon[(nearest + 1) % n];
      const tangent = { x: next.x - prev.x, y: next.y - prev.y };
      const len = Math.hypot(tangent.x, tangent.y);
      const dot = (dir.x * tangent.x + dir.y * tangent.y) / len;
      expect(dot, `corner ${corner.number} tangent`).toBeCloseTo(0, 10);
    }
  });
});
