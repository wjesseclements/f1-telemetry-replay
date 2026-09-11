/**
 * pitLane.ts — distance to the file's pit-lane geometry (Slice 16).
 *
 * `track.pitLane` is the polyline(s) real cars drove through the pit lane, emitted
 * by the pipeline from the traversals it detected. This module answers the one
 * question consumers ask of it: how far is a point from that lane? `carState` uses
 * the answer to say PIT only where it is true — an off-line car NEAR the lane is in
 * the pits; an off-line car hundreds of metres from it is off-track, and the honest
 * label for that is no label (the em dash Slice 19 originally shipped).
 *
 * Distances are returned in POSITION UNITS — the caller owns the metre bridge
 * (`ProgressIndex.unitsPerMetre`), the same division of labour `gaps.ts` uses,
 * because the units-per-metre ratio is a fact about a whole file, not about one
 * polyline.
 */
import type { Replay } from "./schema";

type Track = Replay["track"];

/** Squared distance from `(px, py)` to the segment `(ax, ay)-(bx, by)`. */
function segmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const ab2 = abx * abx + aby * aby;
  // A zero-length segment is its point — the guard also keeps 0/0 out of `t`.
  const t =
    ab2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / ab2));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return dx * dx + dy * dy;
}

/**
 * Distance in position units from `(x, y)` to the nearest pit-lane segment, or
 * `Infinity` when the track carries no lane — which makes every "near the lane?"
 * comparison false without the caller branching on presence.
 *
 * O(total lane points), on demand: the corpus's lanes are 90–280 points and the
 * caller asks only for off-line cars at the ≤30 Hz tick, so this stays microseconds
 * without an index.
 */
export function distanceToPitLane(track: Track, x: number, y: number): number {
  let best = Infinity;
  for (const poly of track.pitLane) {
    for (let i = 1; i < poly.length; i++) {
      const d = segmentDistanceSq(
        x,
        y,
        poly[i - 1].x,
        poly[i - 1].y,
        poly[i].x,
        poly[i].y,
      );
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
