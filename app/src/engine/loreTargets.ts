/**
 * loreTargets.ts — how big each corner-story tap area may be (Slice 18).
 *
 * The painted corner badges are 18 px discs, and on a phone canvas two of them can
 * sit a few pixels apart. A story's button gets one square per member disc, centred
 * on it, as large as it can be without breaking three rules:
 *
 * 1. never wider than `LORE_TARGET_MAX_PX` (the 44 px touch target);
 * 2. never overlapping a square of a DIFFERENT story, so no tap is contested
 *    (squares of one story may overlap: either opens the same card);
 * 3. never leaving the canvas.
 *
 * For rule 2 the side is at most the Chebyshev distance (the larger of |dx| and
 * |dy|) to the nearest member of another story. Two squares of sides s and t at
 * that distance d apart are disjoint when (s + t) / 2 <= d, which holds when both
 * are at most d; they may touch along an edge but never share area. Where even
 * that leaves a target too small to hit, the card's Previous/Next is the route.
 *
 * Pure (CLAUDE.md rule 4): points in, sides out. It runs once per resize, never per
 * frame, and its O(n²) is over at most a couple of dozen points.
 */

/** The touch-target ceiling, in CSS px. */
export const LORE_TARGET_MAX_PX = 44;

/** One painted badge belonging to a story, in canvas CSS px. */
export interface LoreTargetPoint {
  /** Which story this badge opens; badges of one story share a number. */
  readonly story: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The side of the square tap area centred on each point, in input order, for a
 * canvas `width` by `height` CSS px. Never negative: a point on or past the edge,
 * or on top of another story's, gets 0.
 */
export function loreTargetSides(
  points: readonly LoreTargetPoint[],
  width: number,
  height: number,
  maxPx: number = LORE_TARGET_MAX_PX,
): number[] {
  return points.map((p) => {
    let side = Math.min(
      maxPx,
      2 * Math.min(p.x, width - p.x, p.y, height - p.y),
    );
    for (const q of points) {
      if (q.story === p.story) continue;
      side = Math.min(side, Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)));
    }
    return Math.max(0, side);
  });
}
