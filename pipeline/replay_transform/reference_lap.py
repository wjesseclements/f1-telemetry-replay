"""
reference_lap.py — which lap of which car is the replay's REFERENCE (Slice 24).

`track.referenceLap = {car, fromT, toT}` names a span of window seconds during which
`cars[car]` drives exactly ONE clean racing lap, timing line to timing line. Before
this module that fact was implicit: `cars[0]` — whoever was typed first in
`--drivers` — and its FIRST in-window lap, taken with no check. Four things rest on
it (the start/finish line, the track ribbon, the gap reference circuit, and the pace
that scales gaps and orders the tower), and the shipped assets show what an unchecked
first lap does to them:

* the red-flag window (RUS laps 1-3) opens on the race's standing start, so its
  `startFinish` is RUS's POLE SLOT — ~290 m up the straight from the line — at angle
  0.0, the heading of two identical grid fixes (`atan2(0, 0)`);
* the restart window (laps 6-9) opens on a lap that holds the formation lap and a
  55.7 s grid hold: 166.1 s against ~85 s racing laps.

So the reference is now CHOSEN, by a rule, and written into the file.

WHAT QUALIFIES
--------------
A lap is a candidate when every one of these holds, checked in this order (the first
failure is the reason the report prints):

1. it is not the race's lap 1 — a standing start begins on the grid, not on the line;
2. its LapTime is recorded — FastF1 leaves NaT on red-flagged laps and some in/out
   laps, and a lap with no time has no defined end;
3. it is not an in-lap (PitInTime set) and 4. not an out-lap (PitOutTime set) — a lap
   through the pit lane is not the circuit;
5. it lies wholly inside the window ON THE EMITTED GRID (see `_grid_span`);
6. it spans at least `REFERENCE_LAP_MIN_S` — the schema's floor, mirrored, so the
   selector refuses by name what the loader would refuse anyway;
7. no emitted sample inside it is below `PIT_STOP_MAX_KMH` — the pit-lane detector's
   stop threshold, REUSED rather than re-invented: a span holding a stop (a grid hold,
   a pit box, a car parked under red) is not a racing lap, whatever the timing says.

Speeds are read from the EMITTED samples, not the source rows, for the reason
`pit_lane` gives: the report recomputes the choice from the written file alone and
agrees with the builder by construction.

WHICH CANDIDATE
---------------
Laps GREEN THROUGHOUT — one green `trackStatus` interval covering the whole span —
are preferred, because pace is one of the four things the reference sets and a
Safety-Car lap is ~40% slow. Within a tier the order is the human's: the first listed
car's earliest lap, then the next car's. Two passes over the same walk, green-only
first, then any qualifying lap; the second pass is a FALLBACK the report names (a
window with no status data — the finale asset — lands there by construction).

If nothing qualifies anywhere the build FAILS (`NoReferenceLapError`, a
`TelemetryShapeError`), naming every candidate's reason and the two ways out: a wider
`--laps`, or a different first driver. Never a silent fallback to `cars[0]`'s first
sample — that fallback is exactly the defect this module exists to remove.

THE START/FINISH LINE
---------------------
`start_finish_at` places the line at `cars[car]`'s position at `fromT` — the timing
line, because the lap starts there — and takes its heading towards the first later
sample at least `START_FINISH_HEADING_M` away rather than towards the very next one,
so a slow or stationary sample cannot hand it a zero-length chord.

numpy and the standard library only, like every module in this package.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import numpy as np

from .contract import REFERENCE_LAP_MIN_S, TelemetryShapeError
from .lap_context import in_window_laps
from .pit_lane import PIT_STOP_MAX_KMH, units_per_metre

#: The start/finish heading's chord, metres. At racing speed one 10 Hz grid step is
#: already longer (180 km/h covers exactly 5 m per step; the line is crossed at 250+),
#: so on any lap that starts at speed this picks the NEXT sample — the same two-sample
#: heading both builders always used, byte-identical. It reaches further only when the
#: car crosses slowly, which is exactly when consecutive fixes stop meaning a direction:
#: FastF1 positions carry ~1 m of noise, and a stationary car's two fixes are
#: identical (the red-flag asset's 0.0). 5 m is five times that noise and still well
#: inside a straight — a 5 m chord on a 50 m-radius corner turns only 2.9 degrees.
START_FINISH_HEADING_M = 5.0


class NoReferenceLapError(TelemetryShapeError):
    """No lap in the window qualifies as the reference lap. Loud by design."""


@dataclass(frozen=True)
class LapFacts:
    """One in-window lap of one car, as the selector needs it: plain data only."""

    number: int
    #: Window seconds at which the lap began; negative when it began before t0.
    start_s: float
    #: Window seconds at which it ended (start + LapTime); NaN when LapTime is missing.
    end_s: float
    #: PitInTime present — the lap ends in the pit lane.
    pit_in: bool = False
    #: PitOutTime present — the lap starts in the pit lane.
    pit_out: bool = False
    #: The race's (or sprint's) lap 1: a standing start, which begins off the line.
    race_lap_one: bool = False


@dataclass(frozen=True)
class Rejection:
    """Why one candidate lap was passed over, for the run report."""

    driver: str
    number: int
    reason: str


@dataclass(frozen=True)
class ReferenceLap:
    """The chosen lap, on the emitted grid (inclusive sample indices)."""

    car: int
    driver: str
    number: int
    from_i: int
    to_i: int
    rate: float
    #: True when one green interval covers the whole span; False is the fallback tier.
    green: bool
    #: Every candidate walked before this one, with its reason, in walk order.
    rejected: "tuple[Rejection, ...]" = ()

    @property
    def from_t(self) -> float:
        return round(self.from_i / self.rate, 3)

    @property
    def to_t(self) -> float:
        return round(self.to_i / self.rate, 3)

    def field(self) -> "dict[str, Any]":
        """The schema's `track.referenceLap`, JSON-ready."""
        return {"car": self.car, "fromT": self.from_t, "toT": self.to_t}


def lap_facts(
    numbers: "Sequence[Any]",
    starts_s: "Sequence[float]",
    lap_times_s: "Sequence[float]",
    pit_in_s: "Sequence[float]",
    pit_out_s: "Sequence[float]",
    standing_start: bool,
    window: "tuple[float, float]",
) -> "tuple[LapFacts, ...]":
    """
    One car's lap table, as columns in SESSION seconds (NaN for NaT), to the facts the
    selector reads, in WINDOW seconds — for exactly the laps the file's `laps` carries
    (`in_window_laps`, the rule `lap_context` uses).

    `standing_start` is True for a session that starts from the grid (a race or a
    sprint); its lap 1 is then flagged. The fetch layer decides it from the session,
    so this module never learns what a session type is.
    """
    t0 = float(window[0])
    times = np.asarray(lap_times_s, dtype=float)
    pit_in = np.asarray(pit_in_s, dtype=float)
    pit_out = np.asarray(pit_out_s, dtype=float)
    if not (len(numbers) == len(pit_in) == len(pit_out)):
        raise TelemetryShapeError(
            "lap table columns disagree about the number of laps"
        )
    starts = np.asarray(starts_s, dtype=float)
    out = []
    for i in in_window_laps(numbers, starts_s, lap_times_s, window):
        start = float(starts[i]) - t0
        out.append(
            LapFacts(
                number=int(numbers[i]),
                start_s=start,
                end_s=start + float(times[i]),
                pit_in=bool(np.isfinite(pit_in[i])),
                pit_out=bool(np.isfinite(pit_out[i])),
                race_lap_one=bool(standing_start) and int(numbers[i]) == 1,
            )
        )
    return tuple(out)


def _grid_span(lap: LapFacts, n: int, rate: float) -> "tuple[int, int] | str":
    """
    The lap's inclusive sample span on an `n`-sample grid, or why it has none.

    The start rounds to the nearest sample, so a lap that began within half a step
    before t0 starts at sample 0. The end may fall in the window's HOLDING step — the
    last step before `duration = n / rate`, past the last sample (`window_grid`) —
    and the first driver's last lap ends there by construction, because the window
    ends where that lap does; such an end snaps to the last sample. An end at or past
    `duration` is outside the window.
    """
    from_i = int(round(lap.start_s * rate))
    if from_i < 0:
        return f"began before the window (t={lap.start_s:.1f} s)"
    if lap.end_s * rate >= n:
        return f"runs past the window's end (t={lap.end_s:.1f} s of {n / rate:g} s)"
    return from_i, min(int(round(lap.end_s * rate)), n - 1)


def _disqualify(
    lap: LapFacts, speed: np.ndarray, rate: float
) -> "tuple[int, int] | str":
    """The lap's grid span when it qualifies, else the FIRST reason it does not."""
    if lap.race_lap_one:
        return "race lap 1 - a standing start begins on the grid, off the line"
    if not math.isfinite(lap.end_s) or lap.end_s <= lap.start_s:
        return "no LapTime recorded"
    if lap.pit_in:
        return "in-lap (PitInTime set)"
    if lap.pit_out:
        return "out-lap (PitOutTime set)"
    span = _grid_span(lap, len(speed), rate)
    if isinstance(span, str):
        return span
    from_i, to_i = span
    if to_i - from_i < round(REFERENCE_LAP_MIN_S * rate):
        return (
            f"spans {(to_i - from_i) / rate:g} s, under the "
            f"{REFERENCE_LAP_MIN_S:g} s minimum"
        )
    slow = np.flatnonzero(speed[from_i : to_i + 1] < PIT_STOP_MAX_KMH)
    if len(slow):
        return (
            f"contains a stop - {len(slow)} sample(s) below {PIT_STOP_MAX_KMH:g} km/h "
            f"from t={(from_i + int(slow[0])) / rate:.1f} s"
        )
    return from_i, to_i


def _green_throughout(
    from_t: float, to_t: float, status: "Sequence[Mapping[str, Any]]"
) -> "str | None":
    """None when one green interval covers `[from_t, to_t]`, else what does not."""
    for row in status:
        if row["status"] == "green" and row["fromT"] <= from_t and row["toT"] >= to_t:
            return None
    flags = [
        f"{row['status']} {max(row['fromT'], from_t):g}-{min(row['toT'], to_t):g} s"
        for row in status
        if row["status"] != "green" and row["fromT"] < to_t and row["toT"] > from_t
    ]
    if flags:
        return "not green throughout - " + ", ".join(flags)
    return "not green throughout - track status does not cover all of it"


def select_reference_lap(
    drivers: "Sequence[str]",
    laps: "Sequence[Sequence[LapFacts]]",
    speeds: "Sequence[Sequence[float]]",
    status: "Sequence[Mapping[str, Any]]",
    rate: float,
) -> ReferenceLap:
    """
    The window's reference lap — see the module docstring for the rule.

    `drivers`, `laps` and `speeds` are parallel, in `cars` order: each car's in-window
    `LapFacts` (`lap_facts`) and its EMITTED grid speeds. `status` is the window's
    emitted `trackStatus` rows. Raises `NoReferenceLapError` when nothing qualifies.
    """
    if not (len(drivers) == len(laps) == len(speeds)):
        raise TelemetryShapeError(
            f"reference-lap selection needs one lap table and one speed channel per "
            f"car: got {len(drivers)} drivers, {len(laps)} lap tables, "
            f"{len(speeds)} speed channels"
        )
    walk = []
    for c, car_laps in enumerate(laps):
        speed = np.asarray(speeds[c], dtype=float)
        for lap in car_laps:
            walk.append((c, lap, _disqualify(lap, speed, rate)))

    for green_only in (True, False):
        rejected: "list[Rejection]" = []
        for c, lap, verdict in walk:
            if not isinstance(verdict, str):
                from_i, to_i = verdict
                not_green = _green_throughout(
                    round(from_i / rate, 3), round(to_i / rate, 3), status
                )
                if not_green is None or not green_only:
                    return ReferenceLap(
                        car=c,
                        driver=str(drivers[c]),
                        number=lap.number,
                        from_i=from_i,
                        to_i=to_i,
                        rate=rate,
                        green=not_green is None,
                        rejected=tuple(rejected),
                    )
                verdict = not_green
            rejected.append(Rejection(str(drivers[c]), lap.number, verdict))

    raise NoReferenceLapError(_no_lap_message(drivers, walk))


def _no_lap_message(drivers: "Sequence[str]", walk: "list[tuple]") -> str:
    """Every candidate and its reason, then the two ways out."""
    if walk:
        why = "; ".join(
            f"{drivers[c]} lap {lap.number}: {verdict}" for c, lap, verdict in walk
        )
    else:
        why = "no car carries a lap table for this window"
    return (
        "no lap in this window qualifies as the reference lap (one clean racing lap, "
        f"timing line to timing line, wholly inside the window): {why}. Widen the "
        "window with --laps so it holds a whole clean lap, or list first a driver who "
        "ran one."
    )


def start_finish_at(
    x: Any, y: Any, speed: Any, ref: ReferenceLap
) -> "dict[str, float]":
    """
    `track.startFinish` from the chosen lap: `cars[ref.car]`'s position at `fromT`,
    headed towards the first later in-lap sample at least `START_FINISH_HEADING_M`
    away. `x`/`y` are that car's grid positions BEFORE rounding (the arrays
    `build_samples` rounds), so x/y here equal the emitted sample's exactly and the
    angle keeps the builders' full-precision convention. Metres go through the car's
    own bridge over the lap (`units_per_metre`), never a constant.

    Raises when the lap covers no ground or never gets that far from its start —
    a frozen position channel under a moving speed channel, which no racing lap is.
    """
    xs = np.asarray(x, dtype=float)
    ys = np.asarray(y, dtype=float)
    a, b = ref.from_i, ref.to_i
    upm = units_per_metre(xs[a : b + 1], ys[a : b + 1], np.asarray(speed)[a : b + 1], ref.rate)
    reach = np.hypot(xs[a + 1 : b + 1] - xs[a], ys[a + 1 : b + 1] - ys[a])
    far = np.flatnonzero(reach >= START_FINISH_HEADING_M * upm) if upm > 0 else []
    if len(far) == 0:
        raise TelemetryShapeError(
            f"{ref.driver} lap {ref.number}: the reference lap never moves "
            f"{START_FINISH_HEADING_M:g} m from its start, so the start/finish line "
            "has no heading; the position channel is frozen under a moving car"
        )
    k = a + 1 + int(far[0])
    return {
        "x": round(float(xs[a]), 1),
        "y": round(float(ys[a]), 1),
        # RADIANS, the atan2 heading convention the engine uses.
        "angle": round(float(math.atan2(ys[k] - ys[a], xs[k] - xs[a])), 6),
    }
