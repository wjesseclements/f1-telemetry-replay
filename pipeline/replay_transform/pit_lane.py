"""
Pit-lane traversal detection and lane geometry (Slice 16).

The pit lane is the path the cars that use it actually drive: this module finds
per-car pit-lane traversals in a window's EMITTED positions and elects real driven
polylines to be the file's `track.pitLane`. Nothing here is fitted, averaged or
smoothed — every emitted point is a sample some car drove, rounded exactly as its
own `samples` are.

A traversal is a maximal off-the-racing-line span that contains a genuine stop
AND spans real distance. All three halves are corpus-measured over the five
gallery windows (PLAN Slice 16):

- every one of the seven true traversals runs 12.6-28.5 s off-line (residual
  median 16-25 m against the reference's clean laps) and contains a stop of
  3.1-7.8 s below 15 km/h;
- every false candidate — ALO's three at-speed off-track excursions (219-274
  km/h), NOR's displaced rain pit-entry branch, PIA's dead-reckon residue — is
  at most 1.9 s long and contains 0.0 s of stop.

- a car PARKED off-line (Slice 8's legitimate window case) contains a stop but
  no distance: its jittering position cluster spans ~8 m where the narrowest
  true traversal spans 150 m.

The empty bands (stop time 0.0 -> 3.1 s; span length 1.9 -> 12.6 s; extent
8 -> 150 m) are what the thresholds below sit inside.

The racing line itself is the reference car's CLEAN laps — laps containing no
sub-`PIT_STOP_MAX_KMH` sample — so a reference car that pits (rain: HAM) still
yields a line without its own pit lane in it, and its own traversal is
detectable like anyone else's.

A car whose anchor plan was DECLINED (a known-corrupt region, Slice 9j) has its
traversals detected and reported but never contributes geometry: the corruption
is at pit entry, which is exactly what this element draws. Slice 9k later
adjudicates such a car AGAINST this geometry, which only works if the car never
helped build it.
"""

from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

#: Off-the-racing-line bound, metres. The same corpus fact as the app's
#: `OFFLINE_RESIDUAL_M` (carState.ts, Slice 19), re-measured here at the grid:
#: the widest on-line deviation across the five windows is 9.2 m; every pit
#: traversal's residual median is 16-25 m.
PIT_OFFLINE_M = 10.0

#: A "stop" is below this, km/h. Deliberately the same magnitude as
#: `IMPOSSIBLE_MIN_SPEED` (a car below walking pace has no reliable arc) but a
#: separate constant: that one gates anchor placement, this one classifies a
#: span, and tuning one must not silently move the other.
PIT_STOP_MAX_KMH = 15.0

#: Minimum stop inside an off-line span for it to be a traversal, seconds.
#: Measured stops are 3.1-7.8 s; measured false candidates carry 0.0 s. The
#: bound sits at the bottom of the 0.0 -> 3.1 s empty band, the Slice 19
#: `HOLD_MIN_S` argument.
PIT_STOP_MIN_S = 1.0

#: A traversal's DRAWN ends reach the racing line: each unclipped end extends
#: outward from the off-line core to the first sample within this many metres of
#: the line — the departure point on the way in, the rejoin point on the way
#: out — so the polyline flows off the ribbon and back onto it the way the car
#: actually drove. The watch found what a single-sample extension does instead:
#: the lane started and ended at the 10 m DETECTION bound, leaving the 0-10 m
#: departure curve undrawn (an end-cap "hook" against the ribbon) and stopping
#: the exit ~10 m short of the track (Monza's elected car takes another 4.3 s,
#: 12 -> 0 m, to converge). Measured: on-line running reads 0-1 m residual in
#: every end profile; the exit convergence tails pass through 2 m on their way
#: to 0. 2.0 sits above the on-line noise and far under the 10 m gate, and lands
#: inside the drawn ribbon's own width, so the joint is seamless at any zoom.
PIT_ONLINE_RESIDUAL_M = 2.0

#: ...and the walk is bounded: at most this many seconds of extension per end.
#: Measured convergences are 1.7-4.3 s (rain 17 samples, Monza and the red-flag
#: exit 43); 10 s is over 2x the worst. If the envelope is never reached inside
#: the cap (a car that hovers a few metres off-line — the corpus's widest
#: legitimate deviation at pace is 9.2 m), the end falls back to the walked
#: stretch's CLOSEST APPROACH to the line: the most honest joint the data
#: offers.
PIT_JOIN_MAX_S = 10.0

#: A traversal GOES somewhere: its bounding-box diagonal must span at least this
#: many metres. This is what tells a drive through the lane from a car PARKED
#: off-line (Slice 8's legitimate case): a parked position channel jitters, and
#: its accumulated path length can read hundreds of phantom metres, but its
#: extent stays the size of the jitter. Measured: true traversals span 150-567 m
#: (the 150 is a window-clipped pit start); a parked car's cluster spans ~8 m.
#: The bound sits inside that empty band.
PIT_MIN_EXTENT_M = 50.0

#: A candidate polyline is redundant when nearly all of it lies within this many
#: metres of the lane already accepted. Measured: traversals of the SAME lane
#: sit 0-3.8 m apart (different pit boxes included); geometry that is genuinely
#: elsewhere sits 224+ m away.
PIT_LANE_REDUNDANT_M = 10.0

#: ...and "nearly all" is this fraction: a candidate must put more than this
#: share of its points beyond `PIT_LANE_REDUNDANT_M` to add a polyline. Between
#: the measured populations (0% new for every same-lane pair, 100% for disjoint
#: geometry) any value works; 0.25 keeps a mostly-overlapping tail from
#: spawning a duplicate lane.
PIT_LANE_NEW_FRAC = 0.25


@dataclass(frozen=True)
class PitTraversal:
    """One car's drive through the pit lane, in grid indices (inclusive)."""

    driver: str
    #: Entry/exit indices: each unclipped end extends beyond the off-line core
    #: to the on-line envelope (`PIT_ONLINE_RESIDUAL_M`, the departure/rejoin
    #: points), so the polyline touches the racing line at both ends and the
    #: drawn lane merges with the circuit ribbon.
    start_i: int
    end_i: int
    #: Seconds below `PIT_STOP_MAX_KMH` inside the span — the discriminator.
    stop_s: float
    #: Worst residual against the racing line, metres — for the report.
    max_res_m: float
    #: True when the span runs into a window edge (a pit-lane start, or a field
    #: that enters the lane as the window closes): that side has no on-line
    #: extension and the lane honestly ends where the data does.
    clipped_start: bool
    clipped_end: bool


@dataclass(frozen=True)
class PitLaneResult:
    """What the detector decided for one window."""

    #: Every traversal found, including those of excluded cars, in car order.
    traversals: "tuple[PitTraversal, ...]"
    #: Drivers whose traversals were withheld from the geometry (declined plans).
    excluded: "tuple[str, ...]"
    #: The accepted union, in acceptance order (longest driven path first).
    lane: "tuple[PitTraversal, ...]"
    #: Emission-ready polylines: rounded like `samples`, consecutive duplicates
    #: (the pit-box stop) collapsed. Empty when the window has no pit lane.
    polylines: "tuple[tuple[dict[str, float], ...], ...]"

    @property
    def n(self) -> int:
        return len(self.traversals)


#: The no-op result for a window with no traversal.
NO_PIT_LANE = PitLaneResult(traversals=(), excluded=(), lane=(), polylines=())


def units_per_metre(x: Any, y: Any, speed_kmh: Any, rate: float) -> float:
    """
    The metre bridge: emitted position units per metre of travel, measured from
    one car's own path against its own speed integral — the same bridge the app
    measures per file (`gaps.ts`), never a constant, because FastF1's position
    units are undocumented.
    """
    xs = np.asarray(x, dtype=float)
    ys = np.asarray(y, dtype=float)
    sp = np.asarray(speed_kmh, dtype=float)
    if len(xs) < 2:
        return 0.0
    path = float(np.sqrt(np.diff(xs) ** 2 + np.diff(ys) ** 2).sum())
    metres = float((sp / 3.6).sum()) / float(rate)
    return path / metres if metres > 0 else 0.0


def clean_line(
    x: Any, y: Any, speed_kmh: Any, lap_starts_s: "Sequence[float]", rate: float
) -> "tuple[np.ndarray, np.ndarray]":
    """
    The racing line: the reference car's samples restricted to CLEAN laps.

    Lap `i` spans `[lap_starts_s[i], lap_starts_s[i+1])` (the schema's laps carry
    only `startT`; the last lap runs to the window's end, and the first commonly
    starts negative — clamped). A lap is clean when it contains no
    sub-`PIT_STOP_MAX_KMH` sample, which excludes the reference's own pit laps
    and any lap holding a grid stand. When no lap is clean (or no lap table
    exists) the fallback is every at-speed sample — a line that may contain the
    reference's own pit lane, which under-detects rather than fabricates.
    """
    xs = np.asarray(x, dtype=float)
    ys = np.asarray(y, dtype=float)
    sp = np.asarray(speed_kmh, dtype=float)
    n = len(xs)
    keep = np.zeros(n, dtype=bool)
    bounds = [int(round(float(s) * rate)) for s in lap_starts_s] + [n]
    for i in range(len(lap_starts_s)):
        a, b = max(bounds[i], 0), min(bounds[i + 1], n)
        if a < b and not (sp[a:b] < PIT_STOP_MAX_KMH).any():
            keep[a:b] = True
    if not keep.any():
        keep = sp >= PIT_STOP_MAX_KMH
    return xs[keep], ys[keep]


def polyline_distance(px: Any, py: Any, lx: Any, ly: Any) -> np.ndarray:
    """
    Distance from each point to the nearest segment of the polyline, in the
    points' own units. Vectorised over segments, chunked over points so the
    (points x segments) working set stays bounded.
    """
    pxs = np.asarray(px, dtype=float)
    pys = np.asarray(py, dtype=float)
    lxs = np.asarray(lx, dtype=float)
    lys = np.asarray(ly, dtype=float)
    if len(lxs) == 0:
        return np.full(pxs.shape, np.inf)
    if len(lxs) == 1:
        return np.sqrt((pxs - lxs[0]) ** 2 + (pys - lys[0]) ** 2)
    ax, ay = lxs[:-1], lys[:-1]
    abx, aby = lxs[1:] - ax, lys[1:] - ay
    ab2 = abx * abx + aby * aby
    ab2 = np.where(ab2 == 0, 1e-12, ab2)
    out = np.empty(pxs.shape, dtype=float)
    step = 512
    for i in range(0, len(pxs), step):
        pxc = pxs[i : i + step, None]
        pyc = pys[i : i + step, None]
        t = np.clip(((pxc - ax) * abx + (pyc - ay) * aby) / ab2, 0.0, 1.0)
        dx = pxc - (ax + t * abx)
        dy = pyc - (ay + t * aby)
        out[i : i + step] = np.sqrt((dx * dx + dy * dy).min(axis=1))
    return out


def _spans(mask: np.ndarray) -> "list[tuple[int, int]]":
    """Maximal (a, b) inclusive runs of True."""
    if not mask.any():
        return []
    edges = np.diff(mask.astype(int))
    starts = list(np.flatnonzero(edges == 1) + 1)
    ends = list(np.flatnonzero(edges == -1))
    if mask[0]:
        starts.insert(0, 0)
    if mask[-1]:
        ends.append(len(mask) - 1)
    return list(zip(starts, ends))


def detect_traversals(
    driver: str,
    x: Any,
    y: Any,
    speed_kmh: Any,
    line_x: np.ndarray,
    line_y: np.ndarray,
    upm: float,
    rate: float,
) -> "list[PitTraversal]":
    """
    Every pit-lane traversal in one car's grid positions: a maximal span more
    than `PIT_OFFLINE_M` off the racing line that contains at least
    `PIT_STOP_MIN_S` below `PIT_STOP_MAX_KMH`. Each unclipped end is extended
    to the ON-LINE ENVELOPE (`PIT_ONLINE_RESIDUAL_M`, capped by
    `PIT_JOIN_MAX_S`) so the polyline runs departure point to rejoin point and
    touches the racing line at both ends — the 10 m gate DETECTS a traversal,
    it does not bound the drawn road.
    """
    xs = np.asarray(x, dtype=float)
    ys = np.asarray(y, dtype=float)
    sp = np.asarray(speed_kmh, dtype=float)
    if upm <= 0 or len(xs) < 2 or len(line_x) < 2:
        return []
    res_m = polyline_distance(xs, ys, line_x, line_y) / upm
    cap = max(1, int(round(PIT_JOIN_MAX_S * rate)))
    out: "list[PitTraversal]" = []
    for a, b in _spans(res_m > PIT_OFFLINE_M):
        stop_s = float((sp[a : b + 1] < PIT_STOP_MAX_KMH).sum()) / rate
        if stop_s < PIT_STOP_MIN_S:
            continue
        extent = float(
            np.hypot(
                xs[a : b + 1].max() - xs[a : b + 1].min(),
                ys[a : b + 1].max() - ys[a : b + 1].min(),
            )
        )
        if extent / upm < PIT_MIN_EXTENT_M:
            # A stop with no extent is a car PARKED off-line, not a drive
            # through the lane — jitter is not geometry.
            continue
        clipped_start = a == 0
        clipped_end = b == len(xs) - 1
        out.append(
            PitTraversal(
                driver=driver,
                start_i=a if clipped_start else _join_index(res_m, a, -1, cap),
                end_i=b if clipped_end else _join_index(res_m, b, +1, cap),
                stop_s=round(stop_s, 1),
                max_res_m=round(float(res_m[a : b + 1].max()), 1),
                clipped_start=clipped_start,
                clipped_end=clipped_end,
            )
        )
    return out


def _join_index(res_m: np.ndarray, edge: int, step: int, cap: int) -> int:
    """
    Where a traversal's drawn end joins the racing line: walking outward from
    the off-line core's `edge` in direction `step`, the first sample whose
    residual is inside the on-line envelope. If the envelope is never reached
    within `cap` samples (or the window's edge), the walked stretch's closest
    approach to the line joins instead — never the raw 10 m detection bound,
    which is what the watch saw as a hook at entry and a gap at exit.
    """
    i = edge
    best = edge
    for _ in range(cap):
        if i + step < 0 or i + step >= len(res_m):
            break
        i += step
        if res_m[i] < res_m[best]:
            best = i
        if res_m[i] <= PIT_ONLINE_RESIDUAL_M:
            return i
    return best


def _driven_length(xs: np.ndarray, ys: np.ndarray) -> float:
    return float(np.sqrt(np.diff(xs) ** 2 + np.diff(ys) ** 2).sum())


def _emit_polyline(xs: np.ndarray, ys: np.ndarray) -> "tuple[dict[str, float], ...]":
    """Round like `build_samples` does, then collapse consecutive duplicates
    (the pit-box stop is hundreds of identical fixes; the geometry is one)."""
    points: "list[dict[str, float]]" = []
    for xv, yv in zip(xs, ys):
        pt = {"x": round(float(xv), 1), "y": round(float(yv), 1)}
        if not points or points[-1] != pt:
            points.append(pt)
    return tuple(points)


def detect_pit_lane(
    cars: "Sequence[tuple[str, Any, Any, Any, bool]]",
    ref_lap_starts_s: "Sequence[float]",
    rate: float,
) -> PitLaneResult:
    """
    The window's pit lane, from the cars that actually drove it.

    `cars` is `(driver, x, y, speed_kmh, declined)` per car on the shared grid,
    reference first — exactly the arrays the window builder already holds. The
    union is greedy over REAL polylines rather than an average: an averaged lane
    would blend different pit boxes into geometry nobody drove, while a greedy
    union keeps every emitted point a driven sample. Longest driven path is
    elected first (it covers the most lane); another traversal joins only when
    more than `PIT_LANE_NEW_FRAC` of its points lie beyond
    `PIT_LANE_REDUNDANT_M` from everything accepted — same-lane traversals
    measure 0-3.8 m apart, so today's windows all elect exactly one polyline,
    and a window whose lane is only covered piecewise (entry by one car, exit by
    another) is the case the union rule exists for.
    """
    if len(cars) == 0:
        return NO_PIT_LANE
    ref_driver, ref_x, ref_y, ref_speed, _ = cars[0]
    upm = units_per_metre(ref_x, ref_y, ref_speed, rate)
    line_x, line_y = clean_line(ref_x, ref_y, ref_speed, ref_lap_starts_s, rate)
    traversals: "list[PitTraversal]" = []
    excluded: "list[str]" = []
    candidates: "list[tuple[PitTraversal, np.ndarray, np.ndarray, float]]" = []
    for driver, x, y, speed, declined in cars:
        found = detect_traversals(
            str(driver), x, y, speed, line_x, line_y, upm, rate
        )
        traversals.extend(found)
        if not found:
            continue
        if declined:
            excluded.append(str(driver))
            continue
        xs = np.asarray(x, dtype=float)
        ys = np.asarray(y, dtype=float)
        for trav in found:
            seg_x = xs[trav.start_i : trav.end_i + 1]
            seg_y = ys[trav.start_i : trav.end_i + 1]
            candidates.append((trav, seg_x, seg_y, _driven_length(seg_x, seg_y)))

    # Deterministic election: longest driven path, then driver, then position.
    candidates.sort(key=lambda c: (-c[3], c[0].driver, c[0].start_i))
    lane: "list[tuple[PitTraversal, np.ndarray, np.ndarray, float]]" = []
    for cand in candidates:
        if lane:
            dmin = np.min(
                [polyline_distance(cand[1], cand[2], a[1], a[2]) for a in lane],
                axis=0,
            )
            if float((dmin / upm > PIT_LANE_REDUNDANT_M).mean()) <= PIT_LANE_NEW_FRAC:
                continue
        lane.append(cand)

    return PitLaneResult(
        traversals=tuple(traversals),
        excluded=tuple(excluded),
        lane=tuple(c[0] for c in lane),
        polylines=tuple(_emit_polyline(c[1], c[2]) for c in lane),
    )
