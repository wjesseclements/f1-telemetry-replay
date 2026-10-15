/**
 * Corner-story tap-area tests (Slice 18).
 *
 * The three rules `loreTargetSides` promises: at most 44 px, never overlapping a
 * different story's square, never leaving the canvas. Each is pinned on a small
 * case, then all three together on a seeded sweep of random layouts. The same
 * rules on the real circuits at the gated canvas sizes are in
 * `src/data/loreAssets.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  LORE_TARGET_MAX_PX,
  loreTargetSides,
  type LoreTargetPoint,
} from "./loreTargets";

const W = 800;
const H = 600;

describe("loreTargetSides", () => {
  it("gives an isolated badge the full 44 px", () => {
    expect(LORE_TARGET_MAX_PX).toBe(44);
    expect(loreTargetSides([{ story: 0, x: 400, y: 300 }], W, H)).toEqual([44]);
  });

  it("takes a different ceiling when asked", () => {
    expect(loreTargetSides([{ story: 0, x: 400, y: 300 }], W, H, 24)).toEqual([
      24,
    ]);
  });

  it("returns nothing for no badges", () => {
    expect(loreTargetSides([], W, H)).toEqual([]);
  });

  it("shrinks two stories' badges until their squares only touch", () => {
    const sides = loreTargetSides(
      [
        { story: 0, x: 400, y: 300 },
        { story: 1, x: 420, y: 300 },
      ],
      W,
      H,
    );
    expect(sides).toEqual([20, 20]);
  });

  it("measures the gap by the larger axis, as squares need", () => {
    // 30 px across and 10 down: squares of 30 clear each other horizontally,
    // although the straight-line distance is 31.6 px.
    expect(
      loreTargetSides(
        [
          { story: 0, x: 100, y: 100 },
          { story: 1, x: 130, y: 110 },
        ],
        W,
        H,
      ),
    ).toEqual([30, 30]);
  });

  it("lets badges of ONE story overlap, since either opens the same card", () => {
    expect(
      loreTargetSides(
        [
          { story: 2, x: 400, y: 300 },
          { story: 2, x: 405, y: 300 },
        ],
        W,
        H,
      ),
    ).toEqual([44, 44]);
  });

  it("sizes each badge against its own nearest other story", () => {
    const sides = loreTargetSides(
      [
        { story: 0, x: 100, y: 100 },
        { story: 0, x: 200, y: 100 },
        { story: 1, x: 230, y: 100 },
      ],
      W,
      H,
    );
    // The far member of story 0 keeps 44; the near one gives way.
    expect(sides).toEqual([44, 30, 30]);
  });

  it("keeps a square inside the canvas at every edge", () => {
    expect(
      loreTargetSides(
        [
          { story: 0, x: 10, y: 300 },
          { story: 1, x: 400, y: 595 },
          { story: 2, x: 790, y: 300 },
          { story: 3, x: 400, y: 15 },
        ],
        W,
        H,
      ),
    ).toEqual([20, 10, 20, 30]);
  });

  it("gives 0 to a badge on or past the edge, or on another story's", () => {
    expect(
      loreTargetSides(
        [
          { story: 0, x: 0, y: 300 },
          { story: 1, x: -5, y: 100 },
          { story: 2, x: 400, y: 300 },
          { story: 3, x: 400, y: 300 },
        ],
        W,
        H,
      ),
    ).toEqual([0, 0, 0, 0]);
  });

  it("holds all three rules over a seeded sweep of random layouts", () => {
    // A small LCG, so the sweep is the same on every run and every machine.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 300; trial++) {
      const w = 160 + rand() * 1100;
      const h = 120 + rand() * 700;
      const points: LoreTargetPoint[] = Array.from(
        { length: 2 + Math.floor(rand() * 20) },
        () => ({
          story: Math.floor(rand() * 8),
          x: rand() * w,
          y: rand() * h,
        }),
      );
      const sides = loreTargetSides(points, w, h);
      points.forEach((p, i) => {
        const half = sides[i] / 2;
        expect(sides[i]).toBeGreaterThanOrEqual(0);
        expect(sides[i]).toBeLessThanOrEqual(LORE_TARGET_MAX_PX);
        expect(p.x - half).toBeGreaterThanOrEqual(0);
        expect(p.x + half).toBeLessThanOrEqual(w + 1e-9);
        expect(p.y - half).toBeGreaterThanOrEqual(0);
        expect(p.y + half).toBeLessThanOrEqual(h + 1e-9);
        points.forEach((q, j) => {
          if (q.story === p.story) return;
          // Disjoint interiors: separated along at least one axis.
          const reach = (sides[i] + sides[j]) / 2;
          expect(
            Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)),
          ).toBeGreaterThanOrEqual(reach - 1e-9);
        });
      });
    }
  });
});
