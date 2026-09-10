"""
stuck_channel.py — detect a frozen-feed DROPOUT and bridge the placement across it
(Slice 9m).

THE DEFECT THIS SCREENS FOR
---------------------------
F1's telemetry feed drops per car for a couple of seconds — once a lap at a fixed
track position in both 2026 Monza windows — and while it is out the SPEED channel
freezes at its last value (constant to the km/h, at racing pace) while F1's tracker
DEAD-RECKONS the position stream forward. Both channels are corrupt in the same
direction, so the three existing position screens are blind to it: `reject_reversals`
and the ratio screen test the polyline against the speed channel, and a frozen speed
agrees with a dead-reckoned polyline. The dead-feed screen (Slice 9l) declines it on
purpose — the feed RESUMES, so it is a dropout, not a death.

The visible damage is placement, amplified: `resample_positions_by_travel` integrates
the stuck speed into hundreds of phantom metres and holds them until the next timing
anchor reels the car in. On the 2026 restart this surged Colapinto from ~100 m behind
the leader to 76 m AHEAD into della Roggia at 1:52 — a phantom P1 — then snapped him
back. Measured, PLAN Slice 9m.

THE SIGNATURE, AND WHY THESE EXACT SIGNALS
------------------------------------------
A stuck-speed run is only a defect when the feed is FABRICATING, and three signatures
say so — each a physical impossibility, none of which a live car at pace produces:

* SATURATION — throttle above 100 % AND brake on, at the same sample, held for
  `STUCK_SAT_S`. The human's HUD observation: full throttle and full brake together.
  A live car never does it; it appears because the pedals froze mid-transition and
  then drift (FastF1's raw throttle reads slightly over 100).
* POSITION FREEZE — the x/y fixes stop moving (< one position-unit per step) for
  `STUCK_POS_FREEZE_S` while the speed channel still claims `STUCK_MIN_SPEED`+.
  Moving-but-not-moving: the dead-reckon ran out and pinned the marker.
* IMPOSSIBLE EXIT — the speed step LEAVING the run implies a deceleration past
  `STUCK_EXIT_DECEL_G`. Five times an F1 car's braking ceiling is a resume snap, not
  driving — the feed comes back and the channel jumps to the real speed in one step.

Any one fires. They overlap heavily (35 of 37 corpus dropouts carry saturation, 33 the
exit snap, 23 the position freeze), so the union is robust to which signature a
particular dropout happens to show.

WHY NOT A DURATION THRESHOLD
----------------------------
Because duration does not separate the populations and the signature does. The longest
INNOCENT constant-speed run in the corpus is the pit-lane limiter at ~80 km/h, held for
9.08 s (2024 Silverstone) — LONGER than every real dropout, the shortest of which is
1.20 s. A run-length rule would flag the limiter and miss the short dropouts. Measured
over the whole corpus (all three 2024 windows, both 2026 windows): this screen fires on
37 runs, ALL in the two 2026 windows, and ZERO in 2024 — the pit limiter, flat-out
top-speed running, and every clean lap stay silent. PLAN Slice 9m carries the table.

THE BRIDGE — FIX THE PROGRESS, KEEP THE SHAPE (Slice 6b's own rule)
------------------------------------------------------------------
The defect is entirely in the SPEED channel. F1's tracker dead-reckons the dropped
transponder ALONG THE RACING LINE — measured on the 2026 restart, COL's recorded
polyline through the della Roggia dropout sits <= 0.8 m off the reference line the
whole way, including through its frozen tail (0.2 m off). So the recorded polyline's
SHAPE is good; only the stuck speed integrates into phantom TRAVEL, which
travel-driven placement then reads as a surge along that good line. This is exactly
Slice 6b's split — position supplies the shape, speed supplies the progress — so the
bridge fixes only the progress and leaves the shape alone:

* SPEED is linearly bridged `i -> k`, so `cumulative_travel` no longer integrates the
  stuck value; the car then moves along its own recorded (on-line) polyline at a sane
  pace instead of surging along it.
* the pedals are neutralised to a coast (throttle 0, brake 0) over `[i, k)`, so no
  emitted sample carries the impossible throttle-and-brake readout; the honest "no
  signal" is the emitted `dropouts` interval, which the HUD greys out.
* the span's edges are handed back as ANCHORS, pinning the travel->path map to `i` and
  `k` so the repair is confined and the car re-syncs at RESUME, not at the next timing
  loop (the second half of the defect).

The X/Y polyline is DELIBERATELY untouched — an earlier draft replaced it with the
straight chord `i -> k` to "remove phantom arclength", but there is no phantom
arclength (the shape is real), and the chord CUT the corner: on the curved della
Roggia approach it sat >10 m off the racing line, tripping the app's off-line
classifier so the car was mislabelled PIT and its gaps blanked. Keeping the recorded
line holds the whole affected field within 7.2 m of the reference through every
dropout — on the line, correctly placed, no misclassification.

WHAT IT CANNOT DO, stated rather than hidden. A car whose feed drops is a car with no
data, so two residues remain and are OWNED by the emitted `dropouts` interval (the app
renders the span as "no signal") rather than papered over:

* The resume fix `k` is where F1's dead-reckon FROZE — for a hard-braking car a little
  ahead of where it was — and the position never snaps back. Anchoring to `k` is right
  for a car genuinely far back (Colapinto: the phantom P1 is fully removed, gap to the
  leader stays negative) and leaves a small bounded residue for one genuinely at the
  front (Gasly, P2 on the road).
* A car whose dead-reckon OVERSHOT and retraced within the span (PIA, ALO) keeps that
  on-line back-and-forth: its position stays within a metre of the racing line but its
  arc-progress briefly wobbles. Reconstructing the true progress would mean inventing
  the unrecorded braking curve — the surrender doctrine's line (9g) — so instead the
  span is flagged as a dropout and shown as no signal, and the car is exempt from the
  off-line/PIT classification while it is in one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

#: Standard gravity, m/s^2 — the unit the exit-snap bound is argued in.
_G = 9.81

#: A candidate run is a maximal stretch of EXACTLY-constant speed. It must be at least
#: this many samples and this many seconds, at or above this speed, to be considered.
#: `STUCK_MIN_ROWS` keeps a two-sample coincidence from qualifying; `STUCK_MIN_DUR_S`
#: and `STUCK_MIN_SPEED` are the floor of "a car at pace holding one value", below which
#: a constant reading is ordinary (a slow corner apex, a couple of merged samples).
STUCK_MIN_ROWS = 4
STUCK_MIN_DUR_S = 0.8
STUCK_MIN_SPEED = 50.0

#: SATURATION — seconds of throttle-over-100 AND brake-on that a run must carry to
#: fire on this signature. The corpus's longest saturation stretch on an engine that is
#: demonstrably still alive (RPM varying) is 0.92 s; the shortest on a frozen feed is
#: 1.04 s. 1.0 s sits in that band. PLAN Slice 9m.
STUCK_SAT_S = 1.0

#: POSITION FREEZE — seconds the x/y fixes may sit still (below `STUCK_POS_STEP`
#: position-units per step) at pace before the run fires on this signature. A moving
#: car cannot hold one position while its speed channel claims `STUCK_MIN_SPEED`+.
STUCK_POS_FREEZE_S = 0.5
STUCK_POS_STEP = 1.0

#: IMPOSSIBLE EXIT — the deceleration, in g, that the speed step leaving a run must
#: imply to fire on this signature. An F1 car brakes at ~5-6 g; 8 g is a resume snap.
#: The corpus's largest run-exit deceleration on clean 2024 data is 2.4 g, so the
#: margin under this bound is vast. PLAN Slice 9m.
STUCK_EXIT_DECEL_G = 8.0

#: Merged rows this close after a run carry FastF1's interpolated transition values
#: rather than the resumed feed, so the resume edge is taken as the first row strictly
#: beyond this gap. Matches the position channel's sub-native-period dilution the ratio
#: screen already reasons about (`IMPOSSIBLE_MIN_STEP_M`).
_MERGE_PAD_S = 0.02


@dataclass(frozen=True)
class StuckSpan:
    """One detected dropout, in source-row indices and on the session axis."""

    #: Last trusted fix before the run: the run's first sample, whose value is the last
    #: real reading before the freeze. Anchored, kept.
    start_i: int
    #: First trusted fix after the run: the resume. Anchored, kept.
    resume_i: int
    #: Session seconds of `start_i` and `resume_i`, for the report and the interval.
    start_t: float
    resume_t: float
    #: The frozen speed, km/h.
    speed: float
    #: Which signature(s) fired, e.g. "sat,pos,exit" — for the silent-never report.
    reason: str


@dataclass(frozen=True)
class StuckResult:
    """What the screen decided for one car."""

    #: Every detected dropout, in order.
    spans: "tuple[StuckSpan, ...]"

    @property
    def n(self) -> int:
        return len(self.spans)

    @property
    def worst_duration(self) -> float:
        return max((s.resume_t - s.start_t for s in self.spans), default=0.0)


#: The no-op result for a car with no dropout.
NO_STUCK = StuckResult(spans=())


def _constant_runs(t: np.ndarray, v: np.ndarray) -> "list[tuple[int, int]]":
    """Maximal (i, j) inclusive spans where `v` is exactly constant, len >= 2."""
    runs: "list[tuple[int, int]]" = []
    n = len(v)
    i = 0
    while i < n - 1:
        j = i
        while j + 1 < n and v[j + 1] == v[i]:
            j += 1
        if j > i:
            runs.append((i, j))
        i = max(j, i + 1)
    return runs


def _longest_true_run(mask: np.ndarray, t: np.ndarray, base: int) -> float:
    """Seconds of the longest contiguous True stretch in `mask` (indexed from `base`)."""
    best = 0.0
    k0 = None
    for k, on in enumerate(mask):
        if on and k0 is None:
            k0 = k
        if (not on or k == len(mask) - 1) and k0 is not None:
            end = k if on else k - 1
            best = max(best, float(t[base + end] - t[base + k0]))
            k0 = None
    return best


def detect_stuck_channels(
    times: Any,
    speed: Any,
    throttle: Any,
    brake: Any,
    x: Any,
    y: Any,
) -> StuckResult:
    """
    Find every frozen-feed dropout in a car's SOURCE rows.

    A candidate is a maximal run of exactly-constant speed meeting the size floors;
    it fires when it carries ANY of the three impossible signatures (see the module
    docstring). Inputs are the raw irregular-cadence rows, exactly as the window
    builder receives them.
    """
    t = np.asarray(times, dtype=float)
    v = np.asarray(speed, dtype=float)
    th = np.asarray(throttle, dtype=float)
    br = np.asarray(brake, dtype=float) > 0
    px = np.asarray(x, dtype=float)
    py = np.asarray(y, dtype=float)
    n = len(t)
    if n < STUCK_MIN_ROWS:
        return NO_STUCK

    sat = (th > 100.0) & br
    spans: "list[StuckSpan]" = []
    for i, j in _constant_runs(t, v):
        if j - i + 1 < STUCK_MIN_ROWS:
            continue
        if t[j] - t[i] < STUCK_MIN_DUR_S or v[i] < STUCK_MIN_SPEED:
            continue

        reasons: "list[str]" = []

        # SATURATION: longest stretch of throttle>100 AND brake, inside the run.
        if _longest_true_run(sat[i : j + 1], t, i) >= STUCK_SAT_S:
            reasons.append("sat")

        # POSITION FREEZE: longest stretch of near-zero steps, inside the run.
        step = np.hypot(np.diff(px[i : j + 1]), np.diff(py[i : j + 1]))
        if _longest_true_run(step < STUCK_POS_STEP, t, i) >= STUCK_POS_FREEZE_S:
            reasons.append("pos")

        # IMPOSSIBLE EXIT: the deceleration of the step leaving the run, skipping the
        # merge-pad transition rows so the snap is measured against the resumed feed.
        k = j + 1
        while k < n - 1 and t[k] - t[j] <= _MERGE_PAD_S:
            k += 1
        if k < n:
            dv = v[k] - v[j]
            if dv < 0 and (-dv / 3.6) / (t[k] - t[j]) / _G >= STUCK_EXIT_DECEL_G:
                reasons.append("exit")

        if not reasons or k >= n:
            continue
        spans.append(
            StuckSpan(
                start_i=i,
                resume_i=int(k),
                start_t=float(t[i]),
                resume_t=float(t[k]),
                speed=float(v[i]),
                reason=",".join(reasons),
            )
        )

    return StuckResult(spans=tuple(spans))


def bridge_stuck_channels(
    telemetry: Mapping[str, Any], result: StuckResult
) -> "tuple[dict[str, Any], list[int]]":
    """
    Bridge every detected span and return `(telemetry, anchor_indices)`.

    Between each span's trusted edges `start_i -> resume_i`, the SPEED is linearly
    bridged (killing the phantom travel) and the pedals are neutralised to a coast.
    The X/Y polyline is NOT touched — it already traces the racing line, and keeping it
    is what places the car on the line rather than across the corner (see the module
    docstring). The edge indices come back as anchors for `resample_positions_by_travel`,
    which confines the repair and re-syncs the car at resume. A car with no spans comes
    back unchanged with no anchors, so callers can apply this unconditionally.

    The returned telemetry is a fresh dict of fresh arrays — the input is never mutated,
    because the report recomputes the screen on the ORIGINAL rows and the two must not
    alias.
    """
    out = {name: np.asarray(col).copy() for name, col in telemetry.items()}
    if result.n == 0:
        return out, []

    t = np.asarray(out["Time"], dtype=float)
    anchors: "list[int]" = []
    for span in result.spans:
        i, k = span.start_i, span.resume_i
        interior = slice(i + 1, k)  # rows i+1 .. k-1 carry the stuck value
        out["Speed"][interior] = np.interp(
            t[interior], [t[i], t[k]], [out["Speed"][i], out["Speed"][k]]
        )
        # Neutralise the pedals to a coast: honest "no input", never the impossible
        # throttle-and-brake readout. The dropout interval carries the real "no
        # signal". This covers the run's OWN start row (`i` inclusive) as well as the
        # interior, because the freeze can catch the feed mid-transition — throttle
        # already drifting over 100 with the brake on — so `i`'s pedals are themselves
        # a fabrication even though its POSITION (the anchor) is the last real fix.
        # `k` is the resume and keeps its real resumed pedals.
        pedals = slice(i, k)
        out["Throttle"][pedals] = 0
        out["Brake"][pedals] = False if out["Brake"].dtype == bool else 0
        # Gear holds its last real value rather than being invented (the DRS precedent
        # from `freeze_telemetry`: a discrete channel is not this screen's to fabricate).
        out["nGear"][interior] = out["nGear"][i]
        anchors.extend([i, k])

    return out, sorted(set(anchors))


def dropout_intervals(
    result: StuckResult, window_start: float, duration: float
) -> "list[dict[str, float]]":
    """
    The emitted `dropouts` intervals for one car: `{fromT, toT}` in WINDOW-relative
    seconds, clipped to `[0, duration]`, sorted and non-overlapping.

    Additive schema (the `retiredAt`/`trackStatus` doctrine): the app can later show
    "no signal" on the HUD across these instead of the bridged coast. Clipping and the
    non-overlap guarantee come from `detect_stuck_channels` already returning ordered,
    disjoint spans; this only rebases and bounds them.
    """
    out: "list[dict[str, float]]" = []
    for span in result.spans:
        lo = max(round(span.start_t - window_start, 3), 0.0)
        hi = min(round(span.resume_t - window_start, 3), duration)
        if hi > lo:
            out.append({"fromT": lo, "toT": hi})
    return out
