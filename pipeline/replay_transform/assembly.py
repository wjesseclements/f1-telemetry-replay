"""
assembly.py — the two builders: a closed LAP, and an open session-time WINDOW (v2).

Everything upstream (grid, placement, repair) meets here and becomes the schema's
emitted dict. The one fact separating the builders is `meta.loop` — see
`contract.LOOP_CLOSED`. Split verbatim from `replay_transform.py` in Slice 9i
Phase 0; no behaviour change.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from .contract import (
    LOOP_CLOSED,
    LOOP_OPEN,
    SAMPLE_RATE_HZ,
    SCHEMA_VERSION,
    SPEED_UNIT,
    ReplayMeta,
    TelemetryShapeError,
    check_columns,
    normalise_color,
)
from .grid import has_drs, resample_channels, source_times, uniform_grid
from .placement import (
    closing_time,
    covers_ground,
    hold_positions,
    lap_start_anchors,
    resample_positions_by_travel,
    slow_span_anchors,
)
from .repair import (
    IMPOSSIBLE_MIN_SPEED,
    FixRejection,
    FrameDisplacement,
    ReversalRejection,
    reject_impossible_fixes,
    reject_reversals,
    repair_frame_displacements,
)

# --- assembly ---------------------------------------------------------------------


def build_samples(
    grid: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
    speed: np.ndarray,
    throttle: np.ndarray,
    brake: np.ndarray,
    gear: np.ndarray,
    drs: "np.ndarray | None" = None,
    include_drs: "bool | None" = None,
) -> "list[dict[str, Any]]":
    """
    Turn resampled channels into the schema's `samples` array.

    Rounding is part of the contract, not cosmetics: `t` to 3 dp is exactly what the
    schema's 2 ms grid tolerance was sized for, and rounding every emitted number
    also makes the pipeline's output reproducible across numpy versions (see
    `tests/test_golden.py`).

    `drs` is omitted from EVERY sample when the channel is absent or all-zero — the
    schema treats a partially-present channel as pipeline drift and rejects it, and
    an all-zero channel is what a 2026+ session looks like.

    `include_drs` OVERRIDES that per-car decision, and the window builder always
    passes it, because DRS inclusion is a property of the replay rather than of one
    driver. Over a three-lap window a driver who never opened DRS has an all-zero
    channel and would silently lose the HUD indicator while their team-mate kept it —
    two cars in one file disagreeing about whether the season has DRS at all. `None`
    (the default) means "decide from this car's own channel", which is the right
    answer for a single lap, where the car IS the replay.
    """
    if include_drs is None:
        include_drs = has_drs(drs)
    if include_drs and drs is None:
        # Only reachable by asking for DRS on a car that has no DRS channel. The
        # window builder never does — it requires the channel on EVERY car before
        # including it — but silently emitting the car without the key would produce
        # exactly the incoherent file the override exists to prevent, so say so.
        raise TelemetryShapeError(
            "include_drs=True but this car carries no DRS channel; a replay cannot "
            "have some cars with the indicator and some without"
        )
    drs_values = np.asarray(drs).astype(int) if include_drs else None

    samples = []
    for i in range(len(grid)):
        sample = {
            "t": round(float(grid[i]), 3),
            "x": round(float(x[i]), 1),
            "y": round(float(y[i]), 1),
            "speed": int(round(float(speed[i]))),
            "throttle": int(round(float(throttle[i]))),
            "brake": int(brake[i]),
            "gear": int(gear[i]),
        }
        if drs_values is not None:
            sample["drs"] = int(drs_values[i])
        samples.append(sample)
    return samples


def build_corners(rows: Iterable[Mapping[str, Any]]) -> "list[dict[str, Any]]":
    """Map FastF1 circuit-info corner rows onto the schema's corner shape."""
    corners = []
    for row in rows:
        corners.append(
            {
                "number": int(row["Number"]),
                "letter": _clean_letter(row.get("Letter")),
                "x": round(float(row["X"]), 1),
                "y": round(float(row["Y"]), 1),
            }
        )
    return corners


def _clean_letter(value: Any) -> str:
    """FastF1 leaves the corner letter as NaN or None when there isn't one."""
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value)


def build_replay_dict(
    telemetry: Mapping[str, Any],
    meta: ReplayMeta,
    corners: Sequence[Mapping[str, Any]] = (),
    rate: int = SAMPLE_RATE_HZ,
    laps: "Sequence[Mapping[str, Any]]" = (),
    stints: "Sequence[Mapping[str, Any]]" = (),
) -> "dict[str, Any]":
    """
    Build a complete, schema-conforming replay from one lap of telemetry.

    `telemetry` maps FastF1 channel names to arrays — `Time` in seconds, and the
    channels named in `REQUIRED_COLUMNS`/`OPTIONAL_COLUMNS`. Taking a plain mapping
    rather than a DataFrame is what keeps this module free of pandas and testable
    against three-row synthetic frames.

    `laps`/`stints` are the car's lap context in the schema's emitted form (see
    `lap_context`); for a single closed lap that is one lap at `startT` 0.0 and
    one single-lap stint. Default empty — a replay without them means "no lap
    data", exactly as the app's `.default([])` reads it.
    """
    check_columns(telemetry.keys())

    t = np.asarray(telemetry["Time"], dtype=float)
    if t.ndim != 1 or len(t) < 2:
        raise TelemetryShapeError(
            f"telemetry needs at least 2 rows to interpolate between, got {len(t)}"
        )
    # Zero-base within the lap: the schema's `t` starts at 0.
    t = t - t[0]
    # `np.interp` requires an increasing xp and gives silently wrong answers
    # otherwise, and `searchsorted` assumes the same. Duplicate timestamps are
    # tolerable (the later sample wins); going backwards is corruption.
    if np.any(np.diff(t) < 0):
        raise TelemetryShapeError(
            "telemetry Time must be non-decreasing; the source rows are out of order"
        )

    # Two screens, in this order, and the order is the point. A frame displacement is
    # made of steps that are individually impossible, so if the fix screen ran first it
    # would reject the very jumps whose cancellation proves the displacement bounded —
    # and rejecting them removes no phantom arclength at all. Repair first; whatever
    # the repair declines is then screened exactly as it was before this existed.
    repair = repair_frame_displacements(
        t, telemetry["X"], telemetry["Y"], telemetry["Speed"]
    )
    # The lap the app LOOPS is the recorded path plus the chord back to its start, so
    # that is the lap the grid has to cover. See `closing_time`.
    # Impossible fixes are dropped BEFORE anything measures the path: `closing_time`
    # reads the last recorded fix, and an excursion sitting on it would set the whole
    # lap's time base from a point the car was never at.
    rejection = reject_impossible_fixes(t, repair.x, repair.y, telemetry["Speed"])
    kx = repair.x[rejection.keep]
    ky = repair.y[rejection.keep]
    kt = t[rejection.keep]
    kv = np.asarray(telemetry["Speed"], dtype=float)[rejection.keep]

    lap_time = float(t[-1]) + closing_time(kt, kx, ky, kv)
    grid = uniform_grid(lap_time, rate)
    # Sample times are EMITTED as `grid` (k / rate, what the schema requires) but READ
    # at `src` (k * lap / n), which lays the whole lap over the whole grid so the app's
    # wrap step is as long as every other step. Every channel uses the same `src`, so
    # they stay mutually consistent. See the module docstring and `source_times`.
    src = source_times(grid, lap_time, rate)

    # x/y come from the path, parameterised by travelled distance rather than by time
    # (see the module docstring); every other channel is a plain resample. A lap that
    # covers no ground is corrupt, so this is the call that RAISES rather than
    # tolerating it — the window builder is where a car legitimately sits still.
    gx, gy = resample_positions_by_travel(
        src,
        t,
        repair.x,
        repair.y,
        telemetry["Speed"],
        rejection.keep,
        repair.anchors,
    )
    ch = resample_channels(src, t, telemetry)

    samples = build_samples(
        grid, gx, gy, ch["speed"], ch["throttle"], ch["brake"], ch["gear"], ch["drs"]
    )
    n = len(samples)

    return {
        "meta": {
            "schemaVersion": SCHEMA_VERSION,
            "year": int(meta.year),
            "event": str(meta.event),
            "session": str(meta.session),
            "track": str(meta.track),
            "rotation": float(meta.rotation),
            "sampleRateHz": rate,
            "duration": round(n / rate, 3),
            # A lap closes, so the app runs the segment leaving the last sample back
            # to the first. See LOOP_CLOSED.
            "loop": LOOP_CLOSED,
            "units": {"speed": SPEED_UNIT},
        },
        "track": {
            "startFinish": {
                "x": samples[0]["x"],
                "y": samples[0]["y"],
                # RADIANS, matching the atan2 heading convention the engine uses.
                # A hard-coded 0.0 (what this used to emit) draws the start/finish
                # line across the track at the wrong angle without failing anything.
                "angle": round(
                    float(math.atan2(gy[1] - gy[0], gx[1] - gx[0])), 6
                ),
            },
            "corners": build_corners(corners),
        },
        # Always an array: v1 emits one car, v2 emits twenty, and nothing on either
        # side of the contract branches on the count (CLAUDE.md rule 2).
        "cars": [
            {
                "driver": str(meta.driver),
                "team": str(meta.team),
                "color": normalise_color(meta.color),
                "samples": samples,
                # Always emitted, empty when the lap carries none — same contract
                # as the window builder's.
                "laps": [dict(lap) for lap in laps],
                "stints": [dict(stint) for stint in stints],
            }
        ],
    }


# --- the session-time window (v2) -------------------------------------------------


@dataclass(frozen=True)
class SessionMeta:
    """
    The non-telemetry facts about a SESSION — shared by every car in a window.

    Deliberately not `ReplayMeta`: that carries `driver`, `team` and `color`, which
    for a window are per-car facts and live on `WindowCar`. Handing the window
    builder a `ReplayMeta` would mean passing three fields it must ignore, and one
    day someone would read `meta.driver` and get whichever driver happened to be
    typed first.
    """

    year: int
    event: str
    session: str
    track: str
    #: Degrees, from FastF1 `circuit_info`. Applied by the app at render time.
    rotation: float


@dataclass(frozen=True)
class WindowCar:
    """One driver's contribution to a window: who they are, and their telemetry.

    `telemetry` is keyed exactly like `build_replay_dict`'s, with one difference that
    is the whole point of v2: `Time` is on a SHARED axis (session seconds), not
    rebased to this driver's own start. See `build_window_replay_dict`.
    """

    driver: str
    team: str
    color: str
    telemetry: Mapping[str, Any]
    #: `laps` and `stints` in the schema's emitted form, from `lap_context`.
    #: Default empty — a car can genuinely carry none, and the emitted `[]`
    #: means exactly that (the app's `.default([])` reads absence the same way).
    laps: "Sequence[Mapping[str, Any]]" = ()
    stints: "Sequence[Mapping[str, Any]]" = ()


def parse_lap_range(text: str) -> "tuple[int, int]":
    """
    `"12-14"` -> `(12, 14)`; a bare `"12"` is the single lap `(12, 12)`.

    Lives here rather than next to the argument parser because it is pure logic with
    a quiet failure mode — a mis-parsed range is a different window, silently — and
    `build_replay.py` cannot be tested at all (it imports FastF1, which CI does not
    install). Anything worth a test belongs on this side of that seam.
    """
    try:
        bounds = [int(part) for part in str(text).split("-")]
    except ValueError:
        bounds = []
    if len(bounds) == 1:
        return bounds[0], bounds[0]
    if len(bounds) != 2 or bounds[0] > bounds[1]:
        raise TelemetryShapeError(
            f"lap range must be a lap number or A-B with A <= B, got {text!r}"
        )
    return bounds[0], bounds[1]


def window_grid(
    t0: float, t1: float, rate: int = SAMPLE_RATE_HZ
) -> "tuple[np.ndarray, np.ndarray]":
    """
    The emitted grid and the source instants for a session-time window `[t0, t1)`.

    Returns `(grid, src)` where `grid` is `k / rate` — what the schema requires as
    `t` — and `src` is `t0 + k / rate`, the instant on the shared session axis that
    sample k is read from. Every car reads the same `src`, which is what makes
    sample k of every car the same moment (CLAUDE.md rule 5).

    NO TIME-BASE STRETCH, AND NO CLOSING CHORD
    ------------------------------------------
    `source_times` and `closing_time` are absent here, and their absence is a
    decision rather than an oversight. Both exist for exactly one reason: to give the
    app's CYCLIC wrap step a full step of travel, because a lap loops sample n-1 back
    to sample 0 (see the module docstring and `LOOP_CLOSED`). A window is open — the
    app holds its last sample instead — so there is no wrap step to feed, nothing to
    stretch onto, and no fix to close back to. `src` is therefore `t0 + k / rate`
    exactly, and the emitted time base is the session's own, scaled by 1.0.

    THE LAST STEP IS A HOLD, WHICH IS WHY `duration` CAN EXCEED THE WINDOW
    ---------------------------------------------------------------------
    `n = floor((t1 - t0) * rate) + 1` puts the last sample at or before `t1`, and
    `meta.duration = n / rate` therefore runs up to one grid step PAST it. That
    surplus is the holding step at the end of the window, not missing data.
    """
    span = float(t1) - float(t0)
    if span <= 0:
        raise TelemetryShapeError(
            f"window must run forwards: t0={t0} is not before t1={t1}"
        )
    grid = uniform_grid(span, rate)
    return grid, float(t0) + grid


def build_window_replay_dict(
    cars: Sequence[WindowCar],
    meta: SessionMeta,
    window: "tuple[float, float]",
    corners: Sequence[Mapping[str, Any]] = (),
    rate: int = SAMPLE_RATE_HZ,
    status: "Sequence[Mapping[str, Any]]" = (),
) -> "dict[str, Any]":
    """
    Build a schema-conforming MULTI-CAR replay from one session-time window.

    This is the v2 shape: not a per-car lap, but a shared stretch of a session with
    every driver resampled onto one grid, so `cars[k]` of every car is the same
    instant. `cars[0]` is the REFERENCE driver — the window is expected to span a
    whole number of their laps, which is what puts `track.startFinish` on the actual
    line and lets the renderer's ribbon close (see PLAN.md Slice 8).

    THE ONE LINE THAT MATTERS MOST: no car's time axis is rebased.
    `build_replay_dict` starts with `t = t - t[0]`, which is a LAP operation — it
    makes each lap start at zero. Doing it here would destroy the alignment that is
    the entire purpose of v2, and it is what CLAUDE.md rule 5 forbids: alignment is
    on SessionTime, not on per-lap Time. Every car is read at the same `src`.

    Cars whose telemetry does not cover the whole window are not an error and are not
    dropped. `np.interp` and `forward_fill` both clamp, so a car that retires mid-way
    holds its last fix for the rest of the window and a car that joins late holds its
    first — which is what actually happened. Nothing extrapolates.
    """
    if len(cars) == 0:
        raise TelemetryShapeError("a window needs at least one car")

    grid, src = window_grid(window[0], window[1], rate)

    # DRS is decided ONCE for the replay, not per car: over a short window a driver
    # who never opened it looks identical to a 2026 season, and two cars in one file
    # disagreeing about whether DRS exists is incoherent. Requiring the channel on
    # every car (rather than raising when one lacks it) degrades in the safe
    # direction — the indicator disappears for everybody instead of the build failing.
    per_car = []
    for car in cars:
        check_columns(car.telemetry.keys())
        t = _window_time_axis(car)
        per_car.append((car, t, resample_channels(src, t, car.telemetry)))

    include_drs = all(ch["drs"] is not None for _, _, ch in per_car) and any(
        has_drs(ch["drs"]) for _, _, ch in per_car
    )

    built = []
    rejections: "list[tuple[str, FixRejection]]" = []
    for car, t, ch in per_car:
        speed = car.telemetry["Speed"]
        # Repair before screening, and screen the repaired polyline — see the same
        # note in `build_replay_dict` for why that order is load-bearing.
        repair = repair_frame_displacements(t, car.telemetry["X"], car.telemetry["Y"], speed)
        x, y = repair.x, repair.y
        rejection = reject_impossible_fixes(t, x, y, speed)
        rejections.append((str(car.driver), rejection))
        plan = window_anchor_plan(t, speed, repair, car, window[0])
        # The reversal screen (Slice 9j), under the same guard as the anchors: a car
        # with a DECLINED displacement is a known-corrupt region and gets no
        # surgical edits — its fixes ship exactly as the ratio screen left them.
        keep = rejection.keep
        if not plan.declined:
            keep = keep & reject_reversals(t, x, y, speed).keep
        # Parked or moving — the one place a window differs from a lap in how
        # positions are placed. See `covers_ground`.
        if covers_ground(t, x, y, speed):
            gx, gy = resample_positions_by_travel(
                src, t, x, y, speed, keep,
                sorted(set(list(repair.anchors) + plan.extra())),
            )
        else:
            gx, gy = hold_positions(src, t, x, y)
        built.append(
            (
                car,
                gx,
                gy,
                build_samples(
                    grid,
                    gx,
                    gy,
                    ch["speed"],
                    ch["throttle"],
                    ch["brake"],
                    ch["gear"],
                    ch["drs"],
                    include_drs=include_drs,
                ),
            )
        )

    n = len(grid)
    _, ref_x, ref_y, ref_samples = built[0]

    return {
        "meta": {
            "schemaVersion": SCHEMA_VERSION,
            "year": int(meta.year),
            "event": str(meta.event),
            "session": str(meta.session),
            "track": str(meta.track),
            "rotation": float(meta.rotation),
            "sampleRateHz": rate,
            "duration": round(n / rate, 3),
            # A window does not close — the app holds the last sample rather than
            # gliding every car back to where it started. See LOOP_OPEN.
            "loop": LOOP_OPEN,
            "units": {"speed": SPEED_UNIT},
        },
        "track": {
            # From the REFERENCE car, exactly as a lap takes it from its only car. A
            # whole-lap window starts on the line, so this is the line.
            "startFinish": {
                "x": ref_samples[0]["x"],
                "y": ref_samples[0]["y"],
                "angle": round(
                    float(math.atan2(ref_y[1] - ref_y[0], ref_x[1] - ref_x[0])), 6
                ),
            },
            "corners": build_corners(corners),
        },
        "cars": [
            {
                "driver": str(car.driver),
                "team": str(car.team),
                "color": normalise_color(car.color),
                "samples": samples,
                # Always emitted, empty when the car carries none — the goldens
                # then show the shape explicitly rather than by omission.
                "laps": [dict(lap) for lap in car.laps],
                "stints": [dict(stint) for stint in car.stints],
            }
            for car, _, _, samples in built
        ],
        # Same "always emitted" doctrine as laps: an empty list is the explicit
        # spelling of "this window carries no status data". Rows come pre-clipped
        # and pre-rebased from `status.window_status_intervals` — the builder does
        # not re-derive them, so the caller's report and the file cannot disagree.
        "trackStatus": [dict(row) for row in status],
    }


def _window_time_axis(car: WindowCar) -> np.ndarray:
    """The car's shared-axis time column, validated but deliberately NOT rebased."""
    t = np.asarray(car.telemetry["Time"], dtype=float)
    if t.ndim != 1 or len(t) < 2:
        raise TelemetryShapeError(
            f"{car.driver}: telemetry needs at least 2 rows to interpolate "
            f"between, got {len(t)}"
        )
    if np.any(np.diff(t) < 0):
        raise TelemetryShapeError(
            f"{car.driver}: telemetry Time must be non-decreasing; the source rows "
            "are out of order"
        )
    return t


@dataclass(frozen=True)
class AnchorPlan:
    """The extra anchors a window car earns (Slice 9i), and why any were withheld."""

    #: Anchors at the car's own S/F timing-loop crossings (`lap_start_anchors`).
    loop: "tuple[int, ...]"
    #: Anchors bracketing below-`IMPOSSIBLE_MIN_SPEED` spans (`slow_span_anchors`).
    pit: "tuple[int, ...]"
    #: True when the car carries a DECLINED frame displacement, which withholds
    #: every extra anchor: anchoring asserts the path between anchors is ground the
    #: car covered, and a declined relocation is known-unreal path. The 41.7 m
    #: guard — measured, not stylistic: anchoring rain NOR moved his held-out
    #: sector2 error from 47.6 m to 60.2 m (PLAN.md Slice 9i, candidate table).
    declined: bool

    def extra(self) -> "list[int]":
        return [] if self.declined else sorted(set(self.loop + self.pit))


def window_anchor_plan(
    t: Any,
    speed: Any,
    repair: FrameDisplacement,
    car: WindowCar,
    t0: float,
) -> AnchorPlan:
    """
    The anchor plan for one window car: S/F loop crossings UNION pit-span brackets,
    all withheld for a car with a declined displacement.

    The union, chosen by simulation rather than argument (PLAN.md Slice 9i Phase 2
    table): the two families fix different things — loop anchors carry the timing
    loops' authority once per lap, pit brackets confine the path/travel break to the
    span it happens in — and the union's worst held-out sector cell improves or ties
    in every window.

    Called by `build_window_replay_dict` AND recomputed by `build_replay.py`'s
    report, same inputs, so the file and the log cannot disagree.

    The crossings are `t0 + lap.startT` — the lap table the pipeline already
    receives (Slice 14); no new inputs. A lap in progress at the window start
    (negative `startT`) falls outside the coverage margin and contributes nothing.
    """
    ts = np.asarray(t, dtype=float)
    crossings = [float(t0) + float(lap["startT"]) for lap in car.laps]
    return AnchorPlan(
        loop=tuple(lap_start_anchors(ts, crossings)),
        pit=tuple(slow_span_anchors(ts, speed, IMPOSSIBLE_MIN_SPEED)),
        declined=bool(repair.jump_times) and not repair.repaired,
    )
