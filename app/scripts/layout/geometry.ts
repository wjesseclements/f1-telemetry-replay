/**
 * geometry.ts — rectangle arithmetic for the layout assertions.
 *
 * Pure, Node-side, and deliberately tiny: "inside", "overlaps" and "the part of a
 * box you can actually see" are the whole vocabulary the assertions need.
 */
import type { Box } from "./probe";

/**
 * Sub-pixel tolerance, in CSS px, for every containment and overlap test.
 *
 * `getBoundingClientRect` returns fractional values, and two boxes that share an
 * edge can disagree by a rounding step. 1 px is below anything a person reads as
 * "clipped", and two orders of magnitude below the defects this check exists for
 * (a heading 60+ px off the top of its panel, a canvas squeezed by hundreds).
 */
export const EPS_PX = 1;

export function viewportBox(width: number, height: number): Box {
  return { top: 0, left: 0, bottom: height, right: width, width, height };
}

/** The overlap of two boxes; zero-sized (never negative) when they are apart. */
export function intersect(a: Box, b: Box): Box {
  const top = Math.max(a.top, b.top);
  const left = Math.max(a.left, b.left);
  const bottom = Math.max(top, Math.min(a.bottom, b.bottom));
  const right = Math.max(left, Math.min(a.right, b.right));
  return {
    top,
    left,
    bottom,
    right,
    width: right - left,
    height: bottom - top,
  };
}

/** `inner` lies entirely within `outer`, give or take `EPS_PX`. */
export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.top >= outer.top - EPS_PX &&
    inner.left >= outer.left - EPS_PX &&
    inner.bottom <= outer.bottom + EPS_PX &&
    inner.right <= outer.right + EPS_PX
  );
}

/**
 * The two boxes share area beyond `EPS_PX` in BOTH directions. Boxes that merely
 * touch — a border on a shared edge — do not overlap.
 */
export function overlaps(a: Box, b: Box): boolean {
  const i = intersect(a, b);
  return i.width > EPS_PX && i.height > EPS_PX;
}

/** `y=[top,bottom]`, one decimal, for the measured column. */
export function ySpan(b: Box): string {
  return `y=[${b.top.toFixed(1)},${b.bottom.toFixed(1)}]`;
}

/** `WxH`, one decimal. */
export function size(b: Box): string {
  return `${b.width.toFixed(1)}x${b.height.toFixed(1)}`;
}
