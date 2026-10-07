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
failure is the reason the report prints). The order runs from the lap table, through
the grid, to the emitted samples, so the most specific timing reason wins — FastF1
also marks every in/out lap and every lap with no LapTime `IsAccurate=False`, and
"in-lap" says more than "not accurate":

1. it is not the race's lap 1 — a standing start begins on the grid, not on the line;
2. its LapTime is recorded — FastF1 leaves NaT on red-flagged laps and some in/out
   laps, and a lap with no time has no defined end;
3. it is not an in-lap (PitInTime set) and 4. not an out-lap (PitOutTime set) — a lap
   through the pit lane is not the circuit;
5. FastF1 calls its timing ACCURATE (`IsAccurate`) — whether the lap's start and end
   are synchronised with the timing line, which is exactly what `fromT`, `toT` and
   the start/finish line are read from. Only a real True passes; an unknown is not
   accurate (review of the contract half: a recorded LapTime is not the same claim).
   FastF1 (3.8, `Session._check_lap_accuracy`) also requires the lap's own status to
   be green or yellow and the previous lap not to have run wholly under the Safety
   Car, so a lap touched by SC, VSC or red never reaches the tiers below at all;
6. it lies wholly inside the window ON THE EMITTED GRID (see `_grid_span`);
7. it spans at least `REFERENCE_LAP_MIN_S` — the schema's floor, mirrored, so the
   selector refuses by name what the loader would refuse anyway;
8. no emitted sample inside it is below `PIT_STOP_MAX_KMH` — the pit-lane detector's
   stop threshold, REUSED rather than re-invented: a span holding a stop (a grid hold,
   a pit box, a car parked under red) is not a racing lap, whatever the timing says;
9. it overlaps none of the car's stuck-channel `dropouts` (Slice 9m) — across one,
   the emitted positions are a BRIDGE the screen laid, not fixes the car reported,
   and the reference lap becomes the ribbon and the gap circuit;
10. its car's anchor plan was not DECLINED (Slice 24, consumer half) — a car carrying
   a frame displacement the repair could not cancel has positions KNOWN to be
   corrupt somewhere (`AnchorPlan.declined`, the 41.7 m guard), and they are
   inadmissible as the track for the same reason `pit_lane` already excludes that
   car from the lane geometry (`detect_pit_lane`'s `declined` flag). The whole car,
   not a lap: a declined relocation is not localised, which is why the anchor plan
   withholds every loop and pit anchor too. Checked last — the most specific reason
   a lap fails is still its own, and this one is the car's.

Speeds and dropouts are read from the EMITTED file, not the source rows, for the
reason `pit_lane` gives: the report recomputes the choice from the written file alone
and agrees with the builder by construction. The declined flag is not in the file;
the report recomputes it from the source rows exactly as the builder did, and hands
it over the way `pit_lane_report` is handed its declined drivers.

WHICH CANDIDATE
---------------
Laps GREEN THROUGHOUT — one green `trackStatus` interval covering the whole span —
are preferred, because pace is one of the four things the reference sets and a
Safety-Car lap is ~40% slow. Within a tier the order is the human's: the first listed
car's earliest lap, then the next car's. Two passes over the same walk, green-only
first, then any qualifying lap; the second pass is a FALLBACK the report names (a
window with no status data — the finale asset — lands there by construction).

The tier is applied FIELD-WIDE, BEFORE car order: a green clean lap on `cars[1]`
beats a clean lap on `cars[0]` that is not green throughout. That is a ruling (the
review of the contract half put both readings to the coordinator), and the reason is
that the four things the reference sets do not care equally about WHO drove it: the
line, the ribbon and the gap circuit are the same circuit whichever car traced it,
but the pace is the one quantity a slow lap gets wrong, and only the tier protects
it. Moving the reference to another car costs nothing the file cannot say — `car` is
in the field, and the report names the passed-over lap with its flag. Car order
still decides within a tier, so the human's `--drivers` order is honoured whenever
it can be without a slow lap. On all five gallery windows the two readings choose
the same lap (checked offline). Since check 5 removes SC, VSC and red laps outright,
what the tier now separates in a real build is a lap under a YELLOW (the emitted
`yellow` status) from a green one, and a status-less window lands in the fallback.

If nothing qualifies anywhere the build FAILS (`NoReferenceLapError`, a
`TelemetryShapeError`), naming every candidate's reason and the two ways out: a wider
`--laps`, or a different first driver. Never a silent fallback to `cars[0]`'s first
sample — that fallback is exactly the defect this module exists to remove.

THE LEGACY LINE IS AN OPT-IN, NEVER A DEFAULT
---------------------------------------------
The pre-Slice-24 shape — no `referenceLap` key, `startFinish` from `cars[0]`'s first
sample — survives for one kind of caller: the synthetic windows SHORTER THAN A LAP
that the screen tests build, which cannot hold a reference lap at all. They ask for
it by name, `reference_laps=LEGACY_REFERENCE`, and `build_window_replay_dict` has no
default for the argument, so a caller that forgets the lap facts gets a TypeError
rather than the pole slot at angle 0.0 (review of the contract half: a `None`
default reproduced the defect by omission).

THE START/FINISH LINE
---------------------
`start_finish_at` places the line at `cars[car]`'s position at `fromT` — the timing
line, because the lap starts there — and takes its heading towards the first later
sample at least `START_FINISH_HEADING_M` away rather than towards the very next one,
so a slow or stationary sample cannot hand it a zero-length chord.

numpy and the standard library only, like every module in this package.
"""

from __future__ import annotations

import enum
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


class LegacyReference(enum.Enum):
    """The explicit opt-in to the pre-Slice-24 line (module docstring). One member."""

    LEGACY = "legacy"


#: Pass as `build_window_replay_dict(..., reference_laps=LEGACY_REFERENCE)` to build a
#: window WITHOUT a reference lap: no `referenceLap` key (the loader synthesizes the
#: legacy one) and `startFinish` from `cars[0]`'s first sample. For synthetic windows
#: shorter than a lap only; `build_replay.py` never passes it.
LEGACY_REFERENCE = LegacyReference.LEGACY


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
    #: FastF1 `IsAccurate`: the lap's start and end are synchronised with the timing
    #: line. `lap_facts` always sets it from the table (an unknown reads False); the
    #: default serves hand-built facts, like the three flags above.
    accurate: bool = True


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


def _is_true(value: Any) -> bool:
    """A real boolean True. FastF1 leaves `IsAccurate` unset on some rows, and
    `bool(nan)` is True — an unknown must read as NOT accurate."""
    return isinstance(value, (bool, np.bool_)) and bool(value)


def lap_facts(
    numbers: "Sequence[Any]",
    starts_s: "Sequence[float]",
    lap_times_s: "Sequence[float]",
    pit_in_s: "Sequence[float]",
    pit_out_s: "Sequence[float]",
    accurate: "Sequence[Any]",
    standing_start: bool,
    window: "tuple[float, float]",
) -> "tuple[LapFacts, ...]":
    """
    One car's lap table, as columns in SESSION seconds (NaN for NaT), to the facts the
    selector reads, in WINDOW seconds — for exactly the laps the file's `laps` carries
    (`in_window_laps`, the rule `lap_context` uses).

    `accurate` is FastF1's `IsAccurate` column as it comes; only a real True counts
    (`_is_true`). `standing_start` is True for a session that starts from the grid (a
    race or a sprint); its lap 1 is then flagged. The fetch layer decides it from the
    session, so this module never learns what a session type is. Every column is
    required — there is no default that would wave a lap through unchecked.
    """
    t0 = float(window[0])
    times = np.asarray(lap_times_s, dtype=float)
    pit_in = np.asarray(pit_in_s, dtype=float)
    pit_out = np.asarray(pit_out_s, dtype=float)
    if not (len(numbers) == len(pit_in) == len(pit_out) == len(accurate)):
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
                accurate=_is_true(accurate[i]),
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
    lap: LapFacts,
    speed: np.ndarray,
    dropouts: "Sequence[Mapping[str, float]]",
    declined: bool,
    rate: float,
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
    if not lap.accurate:
        return "lap timing not accurate (IsAccurate=False)"
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
    # Overlap in seconds: dropouts are emitted to the millisecond, off the grid. A
    # dropout that ends exactly where the lap starts (or starts where it ends)
    # bridges none of the lap's samples.
    lo, hi = from_i / rate, to_i / rate
    for drop in dropouts:
        if drop["fromT"] < hi and drop["toT"] > lo:
            return (
                f"overlaps a stuck-channel dropout at t={drop['fromT']:g}-"
                f"{drop['toT']:g} s - positions there are bridged, not measured"
            )
    if declined:
        return (
            "car carries a declined frame displacement - its positions are known "
            "corrupt, inadmissible as the track (as for the pit-lane geometry)"
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
    dropouts: "Sequence[Sequence[Mapping[str, float]]]",
    status: "Sequence[Mapping[str, Any]]",
    rate: float,
    *,
    declined: "Sequence[bool]",
) -> ReferenceLap:
    """
    The window's reference lap — see the module docstring for the rule.

    `drivers`, `laps`, `speeds`, `dropouts` and `declined` are parallel, in `cars`
    order: each car's in-window `LapFacts` (`lap_facts`), its EMITTED grid speeds, its
    emitted `dropouts` intervals (empty for a car whose feed never dropped), and
    whether its anchor plan was declined (`AnchorPlan.declined`). `status` is the
    window's emitted `trackStatus` rows. Raises `NoReferenceLapError` when nothing
    qualifies.

    `declined` is keyword-only with no default, the `reference_laps` doctrine: a
    caller that forgot it would otherwise admit every corrupt car by omission.
    """
    if not (
        len(drivers) == len(laps) == len(speeds) == len(dropouts) == len(declined)
    ):
        raise TelemetryShapeError(
            f"reference-lap selection needs one lap table, one speed channel, one "
            f"dropout list and one declined flag per car: got {len(drivers)} drivers, "
            f"{len(laps)} lap tables, {len(speeds)} speed channels, {len(dropouts)} "
            f"dropout lists, {len(declined)} declined flags"
        )
    walk = []
    for c, car_laps in enumerate(laps):
        speed = np.asarray(speeds[c], dtype=float)
        for lap in car_laps:
            walk.append(
                (c, lap, _disqualify(lap, speed, dropouts[c], bool(declined[c]), rate))
            )

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
