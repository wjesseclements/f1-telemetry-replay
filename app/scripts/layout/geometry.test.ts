import { contains, intersect, overlaps, viewportBox } from "./geometry";
import type { Box } from "./probe";

const box = (
  top: number,
  left: number,
  bottom: number,
  right: number,
): Box => ({
  top,
  left,
  bottom,
  right,
  width: right - left,
  height: bottom - top,
});

describe("layout geometry", () => {
  it("intersects overlapping boxes and never goes negative apart", () => {
    expect(intersect(box(0, 0, 10, 10), box(5, 5, 20, 20))).toEqual(
      box(5, 5, 10, 10),
    );
    const apart = intersect(box(0, 0, 10, 10), box(50, 50, 60, 60));
    expect(apart.width).toBe(0);
    expect(apart.height).toBe(0);
  });

  it("contains within the 1 px tolerance, and not beyond it", () => {
    const outer = box(54, 0, 677, 1280);
    expect(contains(outer, box(54.6, 10, 676.4, 1270))).toBe(true);
    expect(contains(outer, box(53.2, 10, 100, 100))).toBe(true);
    // The 1280x720 heading row: clipped 20+ px above the scrollport.
    expect(contains(outer, box(8.6, 10, 33.1, 100))).toBe(false);
  });

  it("treats a shared edge as touching, not overlapping", () => {
    // The 1280x720 side-by-side layout: aside and canvas share x = 1056.
    const canvas = box(54, 0, 677, 1056);
    const aside = box(54, 1056, 677, 1280);
    expect(overlaps(canvas, aside)).toBe(false);
    // The 375x812 spill: the aside runs 109 px into the transport bar.
    expect(overlaps(box(138, 0, 1071, 375), box(703, 0, 812, 375))).toBe(true);
  });

  it("sees a zero-height box as overlapping nothing", () => {
    // The collapsed phone canvas: the canvas-height assertion owns that failure.
    expect(overlaps(box(138, 0, 1071, 375), box(138, 0, 138, 375))).toBe(false);
  });

  it("builds the viewport box at the origin", () => {
    expect(viewportBox(375, 812)).toEqual(box(0, 0, 812, 375));
  });
});
