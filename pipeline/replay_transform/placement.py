"""
placement.py — where each sample goes: arc-length reparameterization.

Position supplies the path shape, speed supplies the progress along it (Slice 6b).
This module owns the path/travel integrals, the closing chord, the parked-car
predicates, and `resample_positions_by_travel` — the mapping whose single global
fraction Slice 9i exists to re-anchor. Split verbatim from `replay_transform.py`
in Slice 9i Phase 0; no behaviour change.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np

from .contract import TelemetryShapeError
from .grid import forward_fill, interp_continuous

# --- arc-length reparameterization ------------------------------------------------


def cumulative_arclength(x: Any, y: Any) -> np.ndarray:
    """
    Distance along the recorded polyline at each of its points. `s[0]` is 0 and the
    result is non-decreasing, so it can be used as `xp` for an interpolation.

    Chordal length: the straight-line distance between consecutive position fixes.
    It slightly under-reads a curve, which is a rounding-order effect at 4 Hz through
    a corner and is in any case absorbed by the normalisation in
    `resample_positions_by_travel`.
    """
    px = np.asarray(x, dtype=float)
    py = np.asarray(y, dtype=float)
    return np.concatenate(([0.0], np.cumsum(np.hypot(np.diff(px), np.diff(py)))))


def cumulative_travel(t: Any, speed: Any) -> np.ndarray:
    """
    Cumulative distance travelled by time — the integral of speed, by trapezoid.

    Integrated over the RAW samples rather than over the emitted grid on purpose: it
    uses every source sample, including those falling between two grid points, which
    is exactly where a braking zone hides its detail.

    The result is in whatever unit `speed` multiplied by `t` happens to be. Nothing
    downstream cares, because only the RATIO to the total is ever used — see
    `resample_positions_by_travel`.
    """
    times = np.asarray(t, dtype=float)
    v = np.asarray(speed, dtype=float)
    steps = 0.5 * (v[:-1] + v[1:]) * np.diff(times)
    return np.concatenate(([0.0], np.cumsum(steps)))


def closing_time(t: Any, x: Any, y: Any, speed: Any) -> float:
    """
    Seconds the car needs to get from the LAST recorded fix back to the first.

    A lap's telemetry does not quite close. On 2024 Monza Q the recorded fixes stop
    0.67 m (VER) and 2.12 m (LEC) short of the fix they started from — 7 ms and 24 ms
    at 320 km/h. The app nevertheless loops sample n-1 straight back to sample 0, so
    that shortfall is real ground the car has to cover inside the wrap step, and a lap
    time that excludes it makes the wrap step overshoot by exactly the shortfall. It
    is the second half of the wrap-step fix; `source_times` is the first.

    SIGNED along the direction of travel at the end, so telemetry that stops SHORT of
    the line lengthens the lap while telemetry that runs PAST it shortens it. Both
    laps above stop short, but the sign is a property of how FastF1 cut the lap and
    is not ours to assume.

    UNIT-SAFE, by the same bridge `resample_positions_by_travel` already relies on:
    the total travel integral and the total path length measure the same distance in
    different units, so their ratio converts position units into travel units without
    anyone here knowing that FastF1 stores 1/10 m and km/h. Dividing by the speed at
    the line then gives seconds.

    Degenerate input returns 0.0 rather than raising: a lap that covers no ground has
    nothing to close, and `resample_positions_by_travel` is where that data gets its
    proper, named error.
    """
    px = np.asarray(x, dtype=float)
    py = np.asarray(y, dtype=float)
    v = np.asarray(speed, dtype=float)

    ux, uy = px[-1] - px[-2], py[-1] - py[-2]
    last_step = math.hypot(ux, uy)
    v_line = 0.5 * (v[0] + v[-1])
    path = cumulative_arclength(px, py)[-1]
    travel = cumulative_travel(t, v)[-1]
    if last_step <= 0.0 or v_line <= 0.0 or path <= 0.0 or travel <= 0.0:
        return 0.0

    gap = ((px[0] - px[-1]) * ux + (py[0] - py[-1]) * uy) / last_step
    return (travel * gap / path) / v_line


#: One car length, in metres. Below this much TRAVEL over a whole window, a car was
#: parked rather than moving, and its positions are held instead of being placed
#: along a path. See `covers_ground`.
PARKED_TRAVEL_M = 5.0

#: Travel-integral units per metre. `cumulative_travel` is sum(v*dt) with v in km/h
#: and t in seconds, so it carries km/h*s, and one metre is 3.6 of them.
#:
#: THIS IS THE MODULE'S ONLY UNIT CONVERSION, and it is deliberately on the one
#: channel whose unit is part of the CONTRACT rather than an undocumented FastF1
#: convention: `SPEED_UNIT` is emitted into `meta.units.speed` and schema.ts REJECTS
#: any other value at load ("the engine's speed-to-color stops are calibrated in
#: km/h"), so both sides enforce it. The POSITION channel's unit — FastF1's
#: undocumented 1/10 m — is still never assumed anywhere in this module, which is
#: what `resample_positions_by_travel`'s normalisation exists to preserve.
KMH_S_PER_METRE = 3.6


def covers_ground(t: Any, x: Any, y: Any, speed: Any) -> bool:
    """
    True when this car moved far enough for its positions to be placed by travelled
    distance; False when it was parked and they should simply be held.

    The distinction the caller is making is *parked* versus *corrupt*, and the two
    builders answer it differently on purpose: a LAP that covers no ground is
    impossible data and `resample_positions_by_travel` raises on it, while a WINDOW
    containing a car sitting in its pit box, on the grid, or retired in the garage is
    completely ordinary. Same condition, different meaning, so the predicate lives
    here and the window builder is the only caller.

    WHY THE TWO TESTS ARE ASYMMETRIC
    --------------------------------
    The path test is strict positivity — no threshold, no unit. All that can honestly
    be asked of a channel whose scale is unknown is whether it is degenerate, and
    `> 0` asks exactly that.

    The travel test carries the threshold, because travel is measured on the SPEED
    channel, whose unit is pinned by the schema on both sides of the contract (see
    `KMH_S_PER_METRE`). Putting a distance threshold on the position channel instead
    would embed FastF1's undocumented 1/10 m convention — the very assumption this
    module is built to avoid — and would silently mean something different the day
    FastF1 changed it.

    The scale bridge `s_total / d_total` cannot be used to derive the threshold, and
    that circularity is precisely why this predicate exists: for a parked car
    `d_total` is ~0, which makes the bridge itself meaningless. Something has to
    decide whether the bridge is trustworthy at all, BEFORE it is computed.

    The bound is absolute rather than scaled by window length: "did this car move?"
    is not a question whose answer should depend on how long you watched.

    ACCEPTED BEHAVIOUR, stated rather than guarded: a session whose speed channel
    reads ~1 km/h of noise while the car is stationary integrates to tens of metres
    over a long window and is classified as MOVING. That is the predicate trusting
    the speed channel, which is this module's standing policy, and the consequence is
    bounded — the positions it then places stay inside the car's own jitter radius.
    """
    return bool(
        cumulative_arclength(x, y)[-1] > 0.0
        and cumulative_travel(t, speed)[-1] >= PARKED_TRAVEL_M * KMH_S_PER_METRE
    )


def hold_positions(
    times: np.ndarray, t: np.ndarray, x: Any, y: Any
) -> "tuple[np.ndarray, np.ndarray]":
    """
    Positions for a car that did not move: forward-fill the recorded fixes.

    The honest output for a parked car. It is deliberately NOT interpolation — with
    no travel to distribute there is nothing to interpolate along, and lerping
    between two GPS fixes that differ only by noise would animate a stationary car.
    Forward-fill says "the car is where the last fix put it", which is all the data
    supports. See `covers_ground` for when this is chosen.
    """
    return (
        forward_fill(times, t, np.asarray(x, dtype=float)),
        forward_fill(times, t, np.asarray(y, dtype=float)),
    )


def resample_positions_by_travel(
    times: np.ndarray,
    t: np.ndarray,
    x: Any,
    y: Any,
    speed: Any,
    keep: "np.ndarray | None" = None,
    anchors: "Sequence[int]" = (),
) -> "tuple[np.ndarray, np.ndarray]":
    """
    Place each sample at the point along the recorded path where the speed integral
    says the car had got to.

    `times` are SOURCE instants (see `source_times`), not the emitted `t` values.

    Three steps: measure the path (`cumulative_arclength`), measure the progress
    (`cumulative_travel`), then read the path at that progress.

    NORMALISATION — the decision this function turns on
    ---------------------------------------------------
    Progress is scaled onto the path as a FRACTION, `s_k = (d_k / d_total) * s_total`,
    not carried across as a raw metric distance. On real data the two disagree by
    about 0.17% (Monza: a 5742.6 m path against a 5732.8 m speed integral), and this
    is how that disagreement is settled:

    * It makes the transform unit-agnostic, which is the difference between correct
      and silently broken. FastF1's X/Y are in 1/10 m and Speed is in km/h — both
      undocumented conventions this module otherwise never has to know. A raw metric
      mapping would need a hard-coded 0.1 and 1/3.6 baked in here; get either wrong,
      or have FastF1 change one, and every sample lands at a wildly wrong arc
      position. A dimensionless ratio cancels both.
    * The lap provably closes. The recorded path IS the lap and the car demonstrably
      traversed all of it, so the total distance is not in question — only its
      distribution in time, which is the one thing speed is being trusted for.
    * It costs nothing and it fixes the boundary. Correlation and the implied/actual
      ratio's spread are both scale-invariant, so normalising cannot flatter the
      quality metric. What it does buy is the endpoint: a raw mapping leaves the last
      sample ~9.8 m short of the path end, and that shortfall lands entirely in the
      wrap step at the start/finish line, where the natural step is ~7 m. Trading a
      0.17% global bias for a ~230% local one at the most-watched point on the
      circuit is a bad trade.
    * It cannot overrun. A speed channel reading a few percent high would run off the
      end of the path under a raw mapping and pancake the final samples onto the line.

    The 0.17% is not resolved by this, it is DISTRIBUTED — 0.17% spread across every
    step, which is finer than the precision x/y are emitted at.

    ANCHORS — where the normalisation is PINNED, and what that is for
    -----------------------------------------------------------------
    With no anchors the map has exactly two: the first fix and the last. That is what
    makes the fraction global, and it is also what makes a LOCAL change to the path
    move EVERY sample. Slice 9g shipped that consequence and it is what got reverted:
    removing 51 m of phantom arclength from a 29 km window shrank `s_total` by 0.175%
    and displaced one car by up to 30.3 m across a 513-second window, in a smooth arch
    that was zero at both ends and maximal in the middle. The gaps in the timing tower
    went with it.

    An anchor is a fix at which the map is pinned to that fix's own arc length, so the
    map becomes piecewise: `np.interp(travelled, d[anchors], s[anchors])`. Passing the
    two fixes that bound a repair therefore confines that repair's arithmetic to the
    stretch between them, in the sense that matters — the removed length is absorbed
    where it was removed instead of being spread over the window as a fraction.

    Anchoring is NOT free and is not a silent improvement: pinning splits the window
    into segments with their own path/travel ratios, so samples outside the repaired
    stretch move too. On 2024 Silverstone R that movement is a CORRECTION, and the
    timing loops are what say so — placement scatter falls from 108.9 m to 17.4 m
    (VER) and 61.7 m to 30.8 m (HAM) against a 6.6-11.7 m noise floor. See PLAN.md
    Slice 9h for the full four-scheme table, including the two schemes this beat.

    With no anchors the original expression is evaluated unchanged, rather than the
    equivalent two-point `np.interp`. That is deliberate: the two are the same
    mathematics but not the same floating-point association, and a car with nothing to
    repair must come out bit-identical rather than nearly so.

    BOUNDARY
    --------
    The app wraps the last sample round to the first across one full grid step, so the
    last sample belongs exactly ONE step of travel before the line, not on it. That is
    what `source_times` delivers: its last instant is `lap * (n-1) / n`, leaving the
    final `lap / n` seconds of travel — a full step's worth — for the wrap.

    Reading at `k / rate` instead left the last sample short by only the sub-step
    remainder of the lap, so the wrap step covered a fraction of a step's ground while
    the clock spent a whole step crossing it, and the car slowed at the start/finish
    line every lap. See the module docstring.

    The clip is a float-drift guard, and the backstop for the one case that could
    otherwise walk off the end: telemetry cut so far short of the line that closing it
    costs more than a whole grid step. `np.interp` holds the last value there, so the
    final samples repeat the last fix — a visible stall rather than a silent
    misplacement, and nothing measured on real data comes close (Monza's worst
    shortfall is 24 ms against a 100 ms step).
    """
    # `keep` drops fixes the speed channel says the car could not have reached, so
    # their spurious arclength never enters `s` (see `reject_impossible_fixes`). It
    # filters the POLYLINE only: `d` still integrates every speed reading, because
    # only the positions were corrupt. The two sides never need matching lengths —
    # the mapping below is by FRACTION of each, which is the same property that makes
    # this function unit-agnostic.
    kx = np.asarray(x, dtype=float)
    ky = np.asarray(y, dtype=float)
    if keep is not None:
        kx, ky = kx[keep], ky[keep]

    s = cumulative_arclength(kx, ky)
    d = cumulative_travel(t, speed)

    # Both are failures of the source data rather than dirt to be tidied: a lap that
    # covers no ground, or one whose speed channel reads zero throughout, cannot be
    # placed along a path at all. Falling back to time interpolation here would ship
    # the exact bug this function exists to remove, silently.
    if s[-1] <= 0.0:
        raise TelemetryShapeError(
            "position channel covers no distance; every X/Y fix is the same point"
        )
    if d[-1] <= 0.0:
        raise TelemetryShapeError(
            "speed channel integrates to zero distance over the lap; positions "
            "cannot be placed along the path by travelled distance"
        )

    # A stationary car or a repeated position fix leaves a zero-length segment, whose
    # two endpoints share an arc length. Dropping them keeps `s` STRICTLY increasing
    # for the lookup below; left in, it would evaluate a zero-width interval and
    # depend on numpy's undocumented NaN fallback to survive doing so. They carry no
    # information either way — both endpoints are the same point.
    moved = np.concatenate(([True], np.diff(s) > 0.0))

    travelled = interp_continuous(times, t, d)

    # `anchors` index the SOURCE fixes; `s` indexes the kept ones. An anchor that was
    # itself rejected has no arc length to pin to and is dropped — `keep` and the
    # repair are independent screens and neither is entitled to assume the other's
    # verdict. `np.interp` needs both axes strictly increasing, so an anchor that fails
    # to advance either (a stationary car, a duplicate fix) is dropped for the same
    # reason `moved` exists.
    kept_index = None if keep is None else np.cumsum(np.asarray(keep, dtype=int)) - 1
    pinned: "list[tuple[float, float]]" = [(0.0, 0.0)]
    for a in anchors:
        if keep is not None and not keep[a]:
            continue
        j = a if kept_index is None else int(kept_index[a])
        node = (float(d[a]), float(s[j]))
        if node[0] > pinned[-1][0] and node[1] > pinned[-1][1]:
            pinned.append(node)
    end = (float(d[-1]), float(s[-1]))
    if len(pinned) > 1 and end[0] > pinned[-1][0] and end[1] > pinned[-1][1]:
        pinned.append(end)

    if len(pinned) > 2:
        xp = np.array([p[0] for p in pinned])
        fp = np.array([p[1] for p in pinned])
        target = np.clip(np.interp(travelled, xp, fp), 0.0, s[-1])
    else:
        target = np.clip(travelled / d[-1] * s[-1], 0.0, s[-1])

    return (
        interp_continuous(target, s[moved], kx[moved]),
        interp_continuous(target, s[moved], ky[moved]),
    )


# --- anchor derivation (Slice 9i) --------------------------------------------------


def lap_start_anchors(t: Any, crossings: "Sequence[float]") -> "list[int]":
    """
    One anchor index per S/F timing-loop crossing strictly inside the coverage.

    The crossing times come from the lap table — timing-loop data, independent of
    both the position and speed channels — which is what entitles them to pin the
    travel→path map: at each crossing the car is AT the line, so the map may be told
    so. Slice 9i's held-out validation (sector marks, never inputs here) is what
    keeps this from grading its own homework.

    A margin of one second at each end keeps an anchor from landing on the very
    fixes the window boundary already pins implicitly; `resample_positions_by_travel`
    additionally drops any anchor that fails to advance path or travel, so a
    crossing during a stationary spell degrades to no-op rather than corrupting
    the map.
    """
    ts = np.asarray(t, dtype=float)
    out = []
    for cross in crossings:
        c = float(cross)
        if ts[0] + 1.0 < c < ts[-1] - 1.0:
            out.append(int(np.searchsorted(ts, c)))
    return sorted(set(out))


def slow_span_anchors(t: Any, speed: Any, min_speed: float) -> "list[int]":
    """
    Anchor indices bracketing every below-`min_speed` span — pit entries and exits.

    The pit lane is where the path/travel ratio breaks (Slice 9h's F3), so the map
    is pinned at the last moving fix before each slow span and the first moving fix
    after it, confining the break to the span it happened in. Anchors sit on the
    MOVING side of each edge: a fix inside the span has unreliable arc/travel
    advance, and `resample_positions_by_travel` would drop it anyway.

    `min_speed` is passed by the caller (the builders hand it
    `IMPOSSIBLE_MIN_SPEED`) rather than imported here — `repair` already imports
    this module, and the constant crossing back would be a cycle.
    """
    ts = np.asarray(t, dtype=float)
    slow = np.asarray(speed, dtype=float) < float(min_speed)
    if not slow.any():
        return []
    edges = np.flatnonzero(np.diff(slow.astype(int)))
    anchors = []
    for e in edges:
        anchors.append(int(e if not slow[e] else e + 1))
    return sorted({a for a in anchors if 0 < a < len(ts) - 1})
