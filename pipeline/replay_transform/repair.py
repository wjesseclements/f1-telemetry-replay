"""
repair.py — detection and repair of impossible position data.

Two screens over the source polyline, in a load-bearing order (repair first — see
`assembly.build_replay_dict`): `repair_frame_displacements` translates a bounded
displacement of the position frame back, `reject_impossible_fixes` drops fixes the
speed channel says the car could not have reached. Split verbatim from
`replay_transform.py` in Slice 9i Phase 0; no behaviour change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .placement import KMH_S_PER_METRE

#: How far a fix may outrun its own speed channel before it is judged impossible,
#: as a multiple of the car's OWN median implied-vs-channel ratio.
#:
#: Measured, not chosen. Over 35,869 source steps across all three gallery windows
#: (above `IMPOSSIBLE_MIN_SPEED`): p99 = 1.76, p99.9 = 2.24, and cars with no known
#: defect top out at 2.23-2.77. The three cars in the Silverstone rain window — the
#: ones carrying the excursion this slice removes — reach 6.85, 11.16 and 12.46.
#: The empty band is therefore 2.8-6.8, and 3.0 sits in it.
#:
#: An earlier draft proposed 2.0 from a 79-step slice of EMITTED data. Over the full
#: source windows that would flag 76 steps, most of them in clean cars. The number
#: had to come from the distribution it is applied to.
IMPOSSIBLE_RATIO = 3.0

#: Below this speed the ratio is a division by nearly nothing and means nothing.
#: Every false positive in the survey sat at 3-11 km/h; a car in its pit box has a
#: speed channel at zero and a position channel still jittering by a metre or two.
IMPOSSIBLE_MIN_SPEED = 15.0

#: The most consecutive fixes that may be rejected before the scan gives up and keeps
#: them. A handful of bad fixes is a cluster to bridge; a long run is a different
#: disease — a broken position channel, or a speed channel reading far too low — and
#: bridging it would invent a racing line rather than repair one. Surrender is
#: reported and warned about, never silent.
IMPOSSIBLE_MAX_RUN = 6

#: Below this displacement, in metres through the car's own scale bridge, a step
#: cannot be judged impossible by EITHER screen. An unmeasurable step is not evidence
#: of anything: a fix within the position channel's own noise of where the car already
#: was cannot prove the car was somewhere it could not be, no matter how enormous
#: dividing that noise by a tiny dt makes the implied rate look.
#:
#: THE DEGENERATE STEP this floors out, measured (2024 Silverstone R, HAM, rain
#: window, t=386.45s): a 0.25 m step 3 ms after its predecessor reads 3.8x — noise
#: over nearly-no-time — and entered the repair screen as a phantom fifth jump. The
#: residual spreading then manufactured a 1.52 m kink across those same 3 ms, which
#: the fix screen rejected at 23.1x: the detector convicting the fix for the damage
#: the detector's own earlier stage had done to it. Both screens misjudge the same
#: row for the same reason, so both take the same floor.
#:
#: WHY NO REAL DEFECT CAN HIDE UNDER IT. On FastF1's merged axis, rows closer
#: together than the position channel's native period (~220 ms) carry INTERPOLATED
#: positions, and interpolation apportions any real displacement pro-rata to dt — the
#: bulk of a genuine jump always lands on a step that is large in metres, whatever
#: its dt. Measured across all nine gallery car-windows: every real jump-step is
#: >= 4.51 m; every step the ratio test flags at dt <= 10 ms is <= 0.25 m, and
#: small-dt steps top out near 0.5 m. The empty band is 0.5-4.5 m and 2.0 sits in
#: it — below half a car length (`PARKED_TRAVEL_M`) and a sixth of the placement
#: instrument's ~12 m resolution, so nothing this floor could mask is visible to any
#: other measure this project has. A hypothetical genuinely-impossible small-dt step
#: is a frame displacement, tens of metres, far over the floor: still convicted, and
#: pinned by test.
#:
#: The conversion to position units is `IMPOSSIBLE_MIN_STEP_M * KMH_S_PER_METRE *
#: scale` — the reports' own bridge run backwards, resting on the one unit the
#: contract pins (speed) and never on FastF1's undocumented position convention.
IMPOSSIBLE_MIN_STEP_M = 2.0


@dataclass(frozen=True)
class FixRejection:
    """What `reject_impossible_fixes` decided, and enough to report it honestly."""

    #: Boolean mask over the input fixes: True = keep.
    keep: np.ndarray
    #: Source times of the rejected fixes, for the per-run report.
    rejected_times: "tuple[float, ...]"
    #: Largest implied-vs-channel ratio seen, rejected or not. 0.0 if uncalibrated.
    worst_ratio: float
    #: Runs that hit `IMPOSSIBLE_MAX_RUN` and were KEPT rather than rejected, as
    #: `(t_start, t_end, arc_over_net)`.
    #:
    #: The RATIO is the point, and it is the discriminator this slice's diagnosis
    #: turned on: arclength over net displacement across the run. **~1.0 is a STEP
    #: CHANGE** — the polyline relocates and stays, a coordinate discontinuity that
    #: cannot be bridged without deciding which side is real. **Much greater than 1
    #: is an EXCURSION** that doubles back but ran longer than the bound, which is a
    #: bridging problem rather than a reconstruction one. Measured on 2024
    #: Silverstone R VER: the out-and-back at t=286.2 scores 2.56, the pit-entry step
    #: at t=290.2 scores 1.00. A future reader classifies a surrender from the log
    #: alone, without re-deriving the distinction.
    surrendered: "tuple[tuple[float, float, float], ...]"
    #: True when the FIRST fix was retracted as the bad one. See the seeding note.
    seed_retracted: bool

    @property
    def n_rejected(self) -> int:
        return int((~self.keep).sum())

    @property
    def surrendered_runs(self) -> int:
        return len(self.surrendered)


def reject_impossible_fixes(
    t: Any,
    x: Any,
    y: Any,
    speed: Any,
    *,
    max_ratio: float = IMPOSSIBLE_RATIO,
    min_speed: float = IMPOSSIBLE_MIN_SPEED,
    max_run: int = IMPOSSIBLE_MAX_RUN,
    min_step: float = IMPOSSIBLE_MIN_STEP_M,
) -> FixRejection:
    """
    Drop position fixes the speed channel says the car could not have reached.

    WHY THIS IS CLEANING AND NOT SMOOTHING
    --------------------------------------
    Slice 6b's rule is that POSITION supplies the shape and SPEED supplies the
    progress along it. That rule presumes the recorded polyline is ground the car
    covered. Measured on 2024 Silverstone R, VER's polyline jumps to a parallel branch
    ~88 m away, runs backwards along it and returns: 127.9 m of arclength consumed for
    40.2 m of real travel, with steps implying 1802 km/h against a channel reading a
    steady 257 km/h. That is not ground the car covered, and no amount of correct
    arclength reasoning rescues it — `resample_positions_by_travel` traverses it
    faithfully precisely BECAUSE the excursion has real arclength.

    So this removes points that are provably not on the shape, and leaves every point
    that is. The surviving polyline is still the recorded shape; speed still supplies
    progress; the existing interpolation bridges the gap, exactly as it already does
    for the dropped fix sitting beside this one. Smoothing would be the violation,
    because it would move points the data got right. The precedent is `clamp_throttle`:
    clamp what is dirty, fail loudly on what is impossible — and now, drop what is
    impossible and let the interpolation span it.

    DIMENSIONLESS, so no position unit is assumed (6b's standing rule). The test is
    each step's implied displacement rate divided by the speed channel, normalised by
    the car's OWN median of that quantity. Scaling every x/y by any factor leaves every
    decision identical, which is pinned by test.

    REACHABILITY, NOT PER-STEP THRESHOLDING. A run of consecutive bad fixes is mutually
    reachable, so a per-step test flags an excursion's entry and exit but not its
    interior. This carries the last ACCEPTED fix as an anchor and asks whether each
    candidate is reachable from it over the accumulated dt — one rule that handles an
    isolated spike, a four-point run, and a genuine data gap (which passes, because dt
    grows with it).

    SEEDING, and the boundary it creates
    ------------------------------------
    The anchor starts at fix 0, which is trusted only PROVISIONALLY. If fix 0 is itself
    wild, every genuine fix after it is unreachable from a bad anchor and the scan would
    reject the entire tail. So:

    * fix 0 is CORROBORATED the first time any candidate is reachable from it, after
      which it is trusted for good;
    * if the pending run exceeds `max_run` while fix 0 is still uncorroborated, the
      minority is the anchor rather than the run: fix 0 is RETRACTED, the pending fixes
      are restored, and the scan re-anchors on the first of them. This can happen at
      most once, which is what makes the scan terminate.
    * a run exceeding `max_run` from a CORROBORATED anchor is a surrender, not a
      retraction: the fixes are KEPT and the run is counted, because at that length the
      diagnosis is a broken channel rather than a bad cluster.

    :returns: a `FixRejection`; `keep` is a mask over the input fixes.
    """
    ts = np.asarray(t, dtype=float)
    px = np.asarray(x, dtype=float)
    py = np.asarray(y, dtype=float)
    vs = np.asarray(speed, dtype=float)
    n = len(ts)
    keep = np.ones(n, dtype=bool)
    if n < 3:
        # Nothing to compare against; two points cannot disagree about a path.
        return FixRejection(keep, (), 0.0, (), False)

    step = np.hypot(np.diff(px), np.diff(py))
    dt = np.diff(ts)
    v = vs[1:]
    usable = (dt > 0.0) & (v >= min_speed) & (step > 0.0)
    if usable.sum() < 3:
        # Too little moving data to calibrate a median against. A window that is all
        # pit lane is not evidence of anything; keep it all.
        return FixRejection(keep, (), 0.0, (), False)
    # No guard on `scale` here, and that is deliberate rather than an omission.
    # `usable` already requires `step > 0` and `dt > 0`, so the median is a median of
    # positive values and cannot be zero or negative. It cannot be NaN either: a NaN
    # coordinate makes its own steps NaN, `NaN > 0` is False, and `usable` drops them —
    # if every step were NaN the count check above would have returned already. A
    # defensive branch here would be unreachable code pretending to be care.
    scale = float(np.median((step[usable] / dt[usable]) / v[usable]))
    #: The measurability floor in position units — see `IMPOSSIBLE_MIN_STEP_M`.
    floor = min_step * KMH_S_PER_METRE * scale

    def ratio(i: int, j: int) -> float:
        """Implied rate from fix `i` to fix `j`, over the channel, over the median."""
        span = ts[j] - ts[i]
        # The faster of the two endpoints, so a car accelerating out of a corner is
        # judged against the speed it reached rather than the one it left.
        chan = max(vs[i], vs[j])
        if span <= 0.0 or chan < min_speed:
            return 0.0
        dist = np.hypot(px[j] - px[i], py[j] - py[i])
        # A fix within the channel's own noise of the anchor is where the car was, as
        # far as the data can say; dividing that noise by a small span proves nothing.
        # Deliberately AFTER the span/speed gate and BEFORE the division, and written
        # so a NaN coordinate falls through (NaN <= floor is False) and is still
        # rejected as unreachable, exactly as before the floor existed.
        if dist <= floor:
            return 0.0
        return float(dist / span / chan / scale)

    anchor = 0
    corroborated = False
    pending: "list[int]" = []
    rejected: "list[int]" = []
    surrendered: "list[tuple[float, float, float]]" = []
    worst = 0.0
    i = 1
    while i < n:
        r = ratio(anchor, i)
        worst = max(worst, r)
        if r <= max_ratio:
            # Reachable: this fix stands, and everything skipped to get here does not.
            rejected.extend(pending)
            pending = []
            anchor = i
            corroborated = True
            i += 1
            continue

        pending.append(i)
        if len(pending) <= max_run:
            i += 1
            continue

        if not corroborated:
            # The anchor is the minority. Retract it, restore the run, re-anchor.
            # At most once per call: `corroborated` is set below and never cleared.
            keep[anchor] = False
            rejected.append(anchor)
            anchor = pending[0]
            i = pending[0] + 1
            pending = []
            corroborated = True
            continue

        # Surrender: too many to be a cluster. Keep them, and record the ratio that
        # says what KIND of surrender it is (see `FixRejection.surrendered`).
        a, b = anchor, pending[-1]
        arc = float(np.hypot(np.diff(px[a : b + 1]), np.diff(py[a : b + 1])).sum())
        net = float(np.hypot(px[b] - px[a], py[b] - py[a]))
        surrendered.append((float(ts[a]), float(ts[b]), arc / net if net > 0 else 0.0))
        anchor = pending[-1]
        i = pending[-1] + 1
        pending = []

    # A trailing run never corroborated by a later fix is rejected, same as any other.
    rejected.extend(pending)
    for k in rejected:
        keep[k] = False

    return FixRejection(
        keep=keep,
        rejected_times=tuple(float(ts[k]) for k in sorted(set(rejected))),
        worst_ratio=worst,
        surrendered=tuple(surrendered),
        seed_retracted=not keep[0],
    )


#: How far the jump vectors bounding a displacement may fail to cancel, as a multiple
#: of the travel the SPEED channel allows during those jump steps themselves.
#:
#: Principled rather than fitted, and said plainly because the corpus cannot supply a
#: measured empty band here. The residual of a genuine out-and-back is the ground the
#: car really covered while the two jumps happened — nothing else is left over — so
#: the ground the channel allows over exactly those steps is the natural bound, and
#: 1.0 means "they cancel to within a distance the car could actually have moved".
#:
#: The two real bounded displacements sit three times inside it: 2024 Silverstone R,
#: HAM residual 7.6 m against 21.6 m allowed (0.35x) and VER 9.0 m against 29.5 m
#: (0.31x). The corpus's one NON-cancelling car, NOR, is not a measurement of the
#: far side of the band — its single jump never finds a partner at all, so it is
#: declined by the `< 2` test below rather than by this one. A future car that jumps
#: twice without cancelling is what would calibrate the upper side; until then this
#: constant is an argument, not a distribution, and is labelled as one.
DISPLACEMENT_TOLERANCE = 1.0

#: How closely a structurally adjudicated step time (see `admit` below) must match a
#: source row's own timestamp to name that step, seconds. Source rows are 2 ms apart
#: at their densest (the 9h-b census), so half of that both matches a cached row
#: bit-for-bit across rebuilds and can never be ambiguous between neighbours. A time
#: that matches nothing is IGNORED rather than snapped: the same session cut to a
#: different window simply does not contain the adjudicated step.
ADMIT_MATCH_S = 0.001


@dataclass(frozen=True)
class FrameDisplacement:
    """What `repair_frame_displacements` decided, and the polyline it decided on."""

    #: The repaired coordinates. Identical objects' VALUES to the input when nothing
    #: was repaired, so callers can use these unconditionally.
    x: np.ndarray
    y: np.ndarray
    #: Source times of the steps judged to be jumps.
    jump_times: "tuple[float, ...]"
    #: True when the jumps cancelled and the enclosed fixes were translated back.
    repaired: bool
    #: Fix indices bounding the translated region: the last fix before the first jump
    #: and the first fix after the last one. Empty when nothing was repaired. These
    #: are the anchors `resample_positions_by_travel` pins its map at, which is what
    #: keeps the removal of the phantom arclength from re-placing the whole window.
    anchors: "tuple[int, ...]"
    #: Largest frame offset reached, in metres.
    offset_m: float
    #: How far the jumps failed to cancel, in metres, and the travel the channel
    #: allows over the jump steps — the two sides of the `DISPLACEMENT_TOLERANCE`
    #: test, reported whether it passed or failed.
    residual_m: float
    allowed_m: float
    #: Source times bounding the translated region, for the log.
    span: "tuple[float, float] | None"
    #: Source times of steps admitted by STRUCTURAL ADJUDICATION (`admit`) rather
    #: than by the ratio gate — empty on every un-adjudicated car, so the field is
    #: also the report's evidence line. Recorded whether or not the pair then
    #: cancelled: an adjudication that was heard and still refused is a fact worth
    #: printing, not a silence.
    admitted: "tuple[float, ...]" = ()


def repair_frame_displacements(
    t: Any,
    x: Any,
    y: Any,
    speed: Any,
    *,
    max_ratio: float = IMPOSSIBLE_RATIO,
    min_speed: float = IMPOSSIBLE_MIN_SPEED,
    tolerance: float = DISPLACEMENT_TOLERANCE,
    min_step: float = IMPOSSIBLE_MIN_STEP_M,
    admit: "tuple[float, ...] | list[float]" = (),
) -> FrameDisplacement:
    """
    Translate a bounded displacement of the position channel's frame back into frame.

    THE DEFECT, as the census found it rather than as it was first described
    ---------------------------------------------------------------------------
    Slice 9g classified the Silverstone pit-entry fault as two things: an out-and-back
    EXCURSION at t=286 and, 4 s later, a STEP CHANGE that "relocates and stays". The
    census that opened this slice found they are the same event. The polyline leaves
    its frame in one impossible step and returns in another, and the jump VECTORS
    cancel: over 2024 Silverstone R the sum of every jump is 9.8 m for VER and 6.8 m
    for HAM against offsets that reach 99 m and 53 m. What sits in between is the
    recorded shape, correct in every respect except that it is somewhere else.

    So the remedy is not rejection. Rejecting the displaced run removes **0.0 m** of
    phantom arclength — the run's own length is real — and throws away 30 to 50
    genuine fixes through a pit entry, which is precisely where the interesting thing
    is happening. Translation keeps every fix and puts it back where it belongs.

    WHY THE OFFSETS ARE CUMULATIVE AND THE RESIDUAL IS SPREAD
    ---------------------------------------------------------
    The frame does not always return in one step: VER's returns in two, 2.3 s apart,
    so between them the polyline sits at an intermediate offset of 21.7 m. Tracking a
    RUNNING offset over the jumps handles that, an isolated spike, and a car with two
    separate displacements, with one rule.

    The running offset does not come back to exactly zero, because a jump step also
    contains the ground the car genuinely covered during it. That leftover is the
    `residual`, and it is distributed evenly across the jumps rather than dumped on
    the last one — which is what makes the first and last regions come out at offset
    zero exactly. **Fixes before the first jump and after the last are therefore
    untouched, bit for bit**, and a car with no displacement is untouched entirely.

    WHAT IT DECLINES, and why declining is the safe direction
    ---------------------------------------------------------
    If the jumps do not cancel, the polyline genuinely relocated and there is no
    displacement to undo; deciding which side is real would be reconstruction, which
    is 9g's argument and still stands. Nothing is translated, the fixes are left for
    `reject_impossible_fixes` to screen exactly as before, and the decision is
    REPORTED (see `frame_repair_report`). NOR's single 41.7 m jump in the rain window
    is that case on real data.

    A return jump made below `min_speed` — a frame that comes back while the car is
    stopped in its box — is invisible to the ratio test and lands in the same place:
    declined and reported, never silently half-repaired.

    STRUCTURAL ADJUDICATION (`admit`, Slice 9k) — the decline path's one extra input
    ----------------------------------------------------------------------------------
    A jump can also hide ABOVE `min_speed` but UNDER the ratio gate: NOR's rain-window
    "out" is a 30.3 m step at 1.96x its own channel allowance (~495 km/h implied, but
    the gate must sit at 3.0 because clean cars reach 2.77), so the census saw only
    the return and declined it as a relocation. `admit` names such steps by their
    source time, on evidence this module cannot see — Slice 9k convicted NOR's by
    scoring both sides of the flagged jump against the Slice 16 pit-lane geometry and
    the racing line (the recorded post-jump branch runs 0.03 m median over VER's
    independently-derived lane; the displaced-side hypothesis would put the car
    40.7 m off every road for 21 s). An admitted step joins the jump list and then
    earns NOTHING further: the cancellation test still decides, so a wrong
    adjudication is refused exactly like an uncancelled jump, and the measurability
    floor still applies. This is not a detector — a cancellation-only partner search
    was measured against the corpus and MIS-FIRES (14 sham partners for BEA alone in
    the 2026 red-flag window's low-speed chaos, all near 1.0x allowance); the
    adjudication is a named, per-step ruling that lives with its evidence in PLAN.

    DIMENSIONLESS, so no position unit is assumed (6b's standing rule). The jump test
    is `reject_impossible_fixes`'s own: implied displacement rate over the speed
    channel, normalised by the car's OWN median of that quantity, calibrated the same
    way so the two detectors cannot disagree about what "impossible" means. The
    cancellation test is a ratio of two lengths in position units. Only the REPORT
    converts to metres, through the car's own scale bridge.
    """
    ts = np.asarray(t, dtype=float)
    px = np.asarray(x, dtype=float)
    py = np.asarray(y, dtype=float)
    vs = np.asarray(speed, dtype=float)
    n = len(ts)
    if n < 3:
        return FrameDisplacement(px, py, (), False, (), 0.0, 0.0, 0.0, None)

    dxs = np.diff(px)
    dys = np.diff(py)
    step = np.hypot(dxs, dys)
    dt = np.diff(ts)
    # Two conventions, both `reject_impossible_fixes`'s: the median is calibrated on
    # the arriving sample's speed, and a single step is judged against the FASTER of
    # its two endpoints so a car accelerating out of a corner is not judged by the
    # speed it left. Sharing them is what stops the two detectors from disagreeing.
    usable = (dt > 0.0) & (vs[1:] >= min_speed) & (step > 0.0)
    if usable.sum() < 3:
        return FrameDisplacement(px, py, (), False, (), 0.0, 0.0, 0.0, None)
    scale = float(np.median((step[usable] / dt[usable]) / vs[1:][usable]))

    chan = np.maximum(vs[:-1], vs[1:])
    judged = (dt > 0.0) & (chan >= min_speed) & (step > 0.0)
    rate = np.divide(step, dt, out=np.zeros_like(step), where=judged)
    ratio = np.divide(
        rate, chan * scale, out=np.zeros_like(step), where=judged & (chan > 0.0)
    )
    # A jump must clear the measurability floor as well as the rate test: a step
    # smaller than the channel's own noise is not a frame displacement however fast
    # its dt makes it look, and letting one in does real damage — it becomes a
    # phantom seam that the residual spreading below then dumps a share of the
    # residual onto, across nearly no time. See `IMPOSSIBLE_MIN_STEP_M` for the
    # measured instance and why nothing genuine can sit under the floor.
    floor = min_step * KMH_S_PER_METRE * scale
    jump = np.flatnonzero((ratio > max_ratio) & (step > floor))

    # Structural adjudication: a named step joins the jump list on outside evidence,
    # then survives exactly the same cancellation test as a ratio-flagged one.
    admitted: "list[float]" = []
    for want in admit:
        i = int(np.argmin(np.abs(ts[:-1] - float(want))))
        if abs(float(ts[i]) - float(want)) > ADMIT_MATCH_S:
            continue  # this slice of the session does not contain the step
        if step[i] <= floor:
            continue  # the measurability floor holds, whoever vouches for the step
        admitted.append(float(ts[i]))
        if i not in jump:
            jump = np.sort(np.append(jump, i))
    admitted_t = tuple(admitted)

    #: Metres per position unit, from the car's own data: `scale` is position units
    #: per (km/h * s), so dividing by it gives travel units and by 3.6 gives metres.
    to_m = 1.0 / (scale * KMH_S_PER_METRE)
    times = tuple(float(ts[k]) for k in jump)

    if len(jump) < 2:
        # One jump is a relocation or an isolated spike; there is no pair to cancel.
        offset = float(np.hypot(dxs[jump], dys[jump]).max()) if len(jump) else 0.0
        return FrameDisplacement(
            px, py, times, False, (), offset * to_m, offset * to_m, 0.0, None,
            admitted_t,
        )

    offsets = np.cumsum(np.stack([dxs[jump], dys[jump]], axis=1), axis=0)
    residual = float(np.hypot(offsets[-1, 0], offsets[-1, 1]))
    allowed = float(scale * (chan[jump] * dt[jump]).sum())
    worst = float(np.hypot(offsets[:, 0], offsets[:, 1]).max())

    if residual > tolerance * allowed:
        return FrameDisplacement(
            px, py, times, False, (), worst * to_m, residual * to_m, allowed * to_m,
            None, admitted_t,
        )

    m = len(jump)
    corrected = offsets - np.outer(np.arange(1, m + 1) / m, offsets[-1])
    rx = px.copy()
    ry = py.copy()
    for k in range(m):
        lo = int(jump[k]) + 1
        hi = int(jump[k + 1]) + 1 if k + 1 < m else n
        rx[lo:hi] -= corrected[k, 0]
        ry[lo:hi] -= corrected[k, 1]

    first = int(jump[0])
    last = min(int(jump[-1]) + 1, n - 1)
    return FrameDisplacement(
        rx,
        ry,
        times,
        True,
        (first, last),
        worst * to_m,
        residual * to_m,
        allowed * to_m,
        (float(ts[first]), float(ts[last])),
        admitted_t,
    )


#: The reversal screen's speed floor, km/h, on the SLOWER endpoint of the pair.
#: A direction reversal between fixes ~0.1-0.2 s apart implies |delta-v| of twice the
#: car's speed over that interval: at 100 km/h that is ~28 g, five times an F1 car's
#: braking ceiling, so above this floor a reversal is impossible regardless of how
#: legal each leg looks to the ratio screen. BELOW it the floor is doing real work:
#: a spinning or recovering car's CG can genuinely hook sharply at low speed, and the
#: pit box is full of small direction changes that mean nothing.
#:
#: Calibrated as an ABSOLUTE empty band, corpus-wide (Slice 9j): with both legs over
#: `2 * IMPOSSIBLE_MIN_STEP_M`, all nine gallery car-windows contain exactly THREE
#: reversal pairs above this floor — HAM's one visible pit-entry flick (rain,
#: t=381.7, legs 21.8/5.5 m at 250 km/h) and the two known-corrupt fixes beside
#: NOR's declined relocation — and ZERO in the six clean cars. There is no
#: distribution to fit; the band is empty.
REVERSAL_MIN_SPEED = 100.0


@dataclass(frozen=True)
class ReversalRejection:
    """What `reject_reversals` decided, and enough to report it honestly."""

    #: Boolean mask over the input fixes: True = keep.
    keep: np.ndarray
    #: Source times of the rejected middle fixes, for the per-run report.
    rejected_times: "tuple[float, ...]"

    @property
    def n_rejected(self) -> int:
        return int((~self.keep).sum())


def reject_reversals(
    t: Any,
    x: Any,
    y: Any,
    speed: Any,
    *,
    min_speed: float = REVERSAL_MIN_SPEED,
    min_leg: float = 2.0 * IMPOSSIBLE_MIN_STEP_M,
) -> ReversalRejection:
    """
    Drop the middle fix of any consecutive step pair that REVERSES DIRECTION at
    speed — the defect class the ratio screen is structurally blind to (Slice 9j).

    THE BLINDNESS, measured before this existed: HAM's rain pit-entry fix at
    t=381.72 overshoots 21.8 m in 0.177 s at 250 km/h — 1.77x the channel's limit,
    ~p99 of CLEAN steps, legally under `IMPOSSIBLE_RATIO`'s 3.0 — and the next fix
    comes 5.5 m back. Each leg passes the ratio test one at a time; the corruption
    lives in the PAIR: together they turn the path through 155 degrees in 0.16 s,
    which is ~35 g and not driving. The signature is the sign of the dot product of
    consecutive steps — dimensionless, so no position unit is assumed (6b's
    standing rule), and orthogonal to the ratio screen rather than a retune of it
    (9i's "do not tune `IMPOSSIBLE_RATIO`" rule stands untouched).

    Both legs must clear `min_leg` (through the car's own scale bridge): a reversal
    between sub-noise steps is jitter, not evidence — the same reasoning as
    `IMPOSSIBLE_MIN_STEP_M`, at twice the floor because BOTH legs must be real for
    the pair to mean anything. `min_speed` gates on the slower endpoint of the
    pair; see `REVERSAL_MIN_SPEED` for the physics and the corpus band.

    The caller bridges the dropped fix by interpolation exactly as it already does
    for the ratio screen's rejects. The WINDOW builder additionally withholds this
    screen from a car carrying a DECLINED displacement (the 9i guard: no surgical
    edits inside a known-corrupt region) — that policy lives at the call site,
    where the repair verdict is in hand, not here.
    """
    ts = np.asarray(t, dtype=float)
    px = np.asarray(x, dtype=float)
    py = np.asarray(y, dtype=float)
    vs = np.asarray(speed, dtype=float)
    n = len(ts)
    keep = np.ones(n, dtype=bool)
    if n < 3:
        return ReversalRejection(keep, ())

    dxs = np.diff(px)
    dys = np.diff(py)
    step = np.hypot(dxs, dys)
    dt = np.diff(ts)
    usable = (dt > 0.0) & (vs[1:] >= IMPOSSIBLE_MIN_SPEED) & (step > 0.0)
    if usable.sum() < 3:
        # Too little moving data to calibrate the scale bridge; keep it all — the
        # same surrender the ratio screen makes on the same evidence.
        return ReversalRejection(keep, ())
    scale = float(np.median((step[usable] / dt[usable]) / vs[1:][usable]))
    floor = min_leg * KMH_S_PER_METRE * scale

    dot = dxs[:-1] * dxs[1:] + dys[:-1] * dys[1:]
    fast = np.minimum(vs[1:-1], vs[2:]) > min_speed
    big = (step[:-1] > floor) & (step[1:] > floor)
    middles = np.flatnonzero((dot < 0.0) & fast & big) + 1
    # One overshooting fix flags its own pair AND the pair it is a leg of, so a
    # genuine neighbour can be taken with it. Accepted, and plainly: the cost is one
    # bridged tenth of a second of true path, paid only ever directly beside actual
    # corruption — while any scheme that tries to restore the neighbour has to rank
    # the pair's two fixes against each other, and a wrong ranking KEEPS the corrupt
    # one. Dropping both is the version that cannot be wrong about which fix lies.
    keep[middles] = False
    return ReversalRejection(
        keep, tuple(float(ts[m]) for m in middles)
    )
