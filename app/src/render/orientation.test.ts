/**
 * orientation.test.ts — the track is drawn the right way round.
 *
 * This file exists because of a defect that lived from Slice 4a to Slice 9f: the
 * renderer rotated world points but never negated y for a canvas whose y grows
 * downward, so every real circuit was drawn MIRRORED and every car circulated
 * backwards. It shipped to production and was found by eye, not by the suite.
 *
 * WHY NOTHING CAUGHT IT, and why this file is a class fix rather than one more test.
 *
 * 1. **The fixture is a symmetric oval.** Its mirror image is itself, so no assertion
 *    written against it can express handedness. This is the second time a symmetric
 *    fixture has hidden a real defect — Slice 9d's perfect circle made every lap pass
 *    at exactly zero distance, so a "nearest pass" bug tied with the right answer and
 *    won by luck. Symmetric fixtures are structurally blind to handedness.
 * 2. **The geometry tests hand-computed from the formula**, which catches a
 *    transposed term but cannot catch a formula MISSING a term: they agreed perfectly
 *    with an implementation that mirrored everything.
 * 3. **The eyeball checks asked the wrong question.** Slice 6 verified that Monza
 *    "renders true — layout recognisably Monza". A mirrored Monza is still
 *    recognisably Monza.
 *
 * So the assertions here are about a PROPERTY the defect must violate, measured on a
 * deliberately ASYMMETRIC path: circulation direction, via the sign of the signed
 * area. A rotation preserves that sign; only a reflection inverts it. That is the
 * discriminator that identified the bug, kept as the thing that prevents its return.
 */
import { describe, expect, it } from "vitest";
import { toScreenPoints, type Point } from "../engine/geometry";

/**
 * Twice the signed area of a closed polygon (the shoelace sum).
 *
 * Only the SIGN is meaningful here, and the convention is worth stating because it
 * inverts with the axis direction. In a y-UP frame a positive sum is
 * counter-clockwise. On a y-DOWN canvas the visual handedness flips, so a POSITIVE
 * sum is CLOCKWISE on screen. Worked example: (0,0)→(1,0)→(1,1)→(0,1) traces a
 * visually clockwise square on screen and sums to +2.
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

/**
 * A closed, deliberately ASYMMETRIC lap in FastF1's y-up world frame, traversed
 * clockwise as a real circuit is.
 *
 * Asymmetric on purpose, in two ways a symmetric oval is not: the radius varies with
 * angle so the shape has no mirror symmetry about either axis, and it is offset from
 * the origin so a reflection cannot be mistaken for a rotation about its own centre.
 * Reflecting this path produces a visibly different shape, which is exactly the
 * property the fixture lacks.
 *
 * `-angle` makes it clockwise in a y-up reading, matching Silverstone and Monza,
 * which both run clockwise in reality.
 */
function asymmetricLap(n = 240): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const angle = -((2 * Math.PI * i) / n);
    const radius = 800 + 260 * Math.cos(angle) + 120 * Math.sin(3 * angle);
    pts.push({
      x: 1500 + radius * Math.cos(angle),
      y: -400 + radius * Math.sin(angle),
    });
  }
  return pts;
}

const lap = asymmetricLap();

describe("world → screen orientation", () => {
  it("the source lap is clockwise in FastF1's y-up frame", () => {
    // The premise, asserted rather than assumed: in a y-up reading a clockwise loop
    // has a NEGATIVE signed area. Real Silverstone and Monza data both measure
    // negative here too (-4.069e8 and -6.798e8) — they are clockwise circuits and
    // FastF1's frame records them correctly.
    expect(signedArea(lap)).toBeLessThan(0);
  });

  it("draws it clockwise on a y-down canvas", () => {
    // THE REGRESSION PIN. On the canvas's y-down axis, clockwise is a POSITIVE sum.
    // Pre-9f this came back negative — counter-clockwise on screen — for every real
    // circuit, because the transform rotated without reflecting.
    expect(signedArea(toScreenPoints(lap, 92))).toBeGreaterThan(0);
  });

  it("keeps circulation clockwise at every rotation, because rotation cannot change it", () => {
    // The discriminator, stated as an invariant: if any of these came back with a
    // different sign, the transform would be doing something a rotation cannot do.
    for (const deg of [-180, -95, -14, 0, 14, 92, 95, 180, 270]) {
      expect(Math.sign(signedArea(toScreenPoints(lap, deg))), `${deg}°`).toBe(
        1,
      );
    }
  });

  it("reverses circulation relative to the untransformed source", () => {
    // The other side of the same fact: the transform contains a reflection, and a
    // reflection is precisely what inverts this sign. An implementation that only
    // rotated would fail this.
    expect(Math.sign(signedArea(toScreenPoints(lap, 92)))).toBe(
      -Math.sign(signedArea(lap)),
    );
  });

  it("preserves the shape — a reflection is an isometry, not a distortion", () => {
    // Guards the opposite error: "fixing" the mirror by scaling y negatively but
    // non-uniformly, which would correct the handedness and squash the circuit.
    const drawn = toScreenPoints(lap, 92);
    expect(Math.abs(signedArea(drawn))).toBeCloseTo(
      Math.abs(signedArea(lap)),
      6,
    );
    for (const i of [0, 37, 120, lap.length - 1]) {
      const j = (i + 1) % lap.length;
      const before = Math.hypot(lap[j].x - lap[i].x, lap[j].y - lap[i].y);
      const after = Math.hypot(
        drawn[j].x - drawn[i].x,
        drawn[j].y - drawn[i].y,
      );
      expect(after, `segment ${i}`).toBeCloseTo(before, 9);
    }
  });

  it("is blind to none of this on an asymmetric path, unlike the committed fixture", () => {
    // The lesson, executable. A mirror-symmetric path cannot distinguish the two
    // implementations by SHAPE at all — which is why the oval fixture hid this for
    // four months — while this path can. Reflecting the symmetric one lands back on
    // the same point set; reflecting this one does not.
    const symmetric: Point[] = Array.from({ length: 240 }, (_, i) => {
      const a = -((2 * Math.PI * i) / 240);
      return { x: 800 * Math.cos(a), y: 450 * Math.sin(a) };
    });
    const mirroredSym = symmetric.map((p) => ({ x: p.x, y: -p.y }));
    const mirroredAsym = lap.map((p) => ({ x: p.x, y: -p.y }));

    // Membership by distance, not by formatted string: the mirrored oval lands on
    // its own points via a different trigonometric expression, so the coordinates
    // agree to ~1e-13 rather than exactly.
    const covers = (whole: Point[], part: Point[], eps = 1e-6) =>
      part.every((q) =>
        whole.some((p) => Math.hypot(p.x - q.x, p.y - q.y) < eps),
      );

    // The oval mirrors onto itself: same point set, so shape alone proves nothing
    // about handedness — this is the fixture's blindness, executable.
    expect(covers(symmetric, mirroredSym)).toBe(true);
    // The asymmetric lap does not: reflecting it is visible.
    expect(covers(lap, mirroredAsym)).toBe(false);
  });
});
