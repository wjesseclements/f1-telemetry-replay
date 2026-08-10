"""
replay_transform.py — the pure half of the pipeline.

Everything here is a function from arrays to arrays (or to plain Python data). No
network, no file I/O, no FastF1, no pandas — `numpy` and the standard library only.
That is deliberate and it is the Python mirror of CLAUDE.md architecture rule 4: the
app keeps its time/geometry/interpolation logic in a headless `src/engine/` so it can
be unit-tested, and the pipeline's resampling logic earns the same treatment. The
FastF1 fetch lives in `build_replay.py`, which is the only module that needs a
network connection, and therefore the only module that cannot be tested.

The requirements document for this file is `app/src/engine/schema.ts`. Every rule
below exists because the Zod schema enforces it at load:

* `meta.schemaVersion` must be exactly 1.
* Samples lie on a UNIFORM grid — each `t` within 2 ms of `k / sampleRateHz`. The
  app's O(1) lookup is `index = clock * sampleRateHz` and never reads `t` again, so
  an irregular grid would silently put the car in the wrong place.
* Every car's `len(samples)` must equal `round(duration * sampleRateHz)` to within
  one step, and `t` must be strictly increasing.
* `throttle` is 0-100. Real FastF1 throttle occasionally reads above 100; the
  PIPELINE clamps, because the app deliberately does not widen its contract to
  absorb dirty upstream data.
* `drs` is optional and all-or-nothing per car: present on every sample, or on none.
  It carries the RAW FastF1 code — `app/src/engine/drs.ts` owns the undocumented
  10/12/14 mapping, and decoding here as well would duplicate that guess across two
  languages (CLAUDE.md rule 8).

WHY POSITIONS ARE NOT INTERPOLATED IN TIME
------------------------------------------
Position and car telemetry are independent FastF1 channels, each around 4.2 Hz and
IRREGULARLY spaced (p10 160 ms, p90 400 ms). The position channel's shape is good and
its timestamps are not: interpolating x/y against time therefore placed each 10 Hz
sample at the wrong distance along an otherwise correct path, and the car marker
surged and eased on the straights, disagreeing with the speed the HUD showed. Measured
on 2024 Monza Q VER, the implied velocity `|dxy|/dt` correlated with the speed channel
at only r = 0.70, reaching 740 km/h against a true maximum of 348.

So the two channels are used for what each is good at: POSITION SUPPLIES THE PATH
SHAPE, SPEED SUPPLIES THE PROGRESS ALONG IT. `resample_positions_by_travel` places
grid sample k at the point on the recorded polyline that the cumulative speed integral
says the car had reached. See `PLAN.md` §Slice 6b for the full diagnosis.

WHY THE EMITTED GRID IS NOT THE SOURCE GRID
-------------------------------------------
`meta.duration` is `n / rate`, which rounds the lap UP to a whole grid step, and the
app closes the loop by wrapping the last sample round to the first across one full
step. Reading every channel at `k / rate` therefore left that wrap step covering only
the sub-step REMAINDER of real travel — the car crossed the start/finish line at
`r x` its true speed for a tenth of a second, where `r` is the fractional part of the
lap in grid steps and is uniform on [0, 1). Measured before the fix: Monza VER drew
r = 0.70 (6.17 m of chord where its neighbours are 8.8 m, 222 km/h against a true
319) and Monza LEC drew r = 0.85. A lap that draws r near 0 parks the car at the line.

The fix has two halves, because the wrap step was short for two independent reasons.

`source_times` is the first: emit `t = k / rate` exactly as the schema requires, but
READ each sample from source instant `k * lap / n`. The whole lap is then laid down
over the whole grid, so every step — the wrap step included — covers the same
`lap / n` seconds of real motion. The cost is a uniform time base stretch of
`duration / lap`, under 0.125% for a ~80 s lap at 10 Hz (Monza VER: 1.00039x), which
`build_replay.py` prints on every run so it is never a surprise.

`closing_time` is the second, and was found by measuring the first: a lap's recorded
fixes stop a metre or two SHORT of the fix they started from (Monza Q: 0.67 m for VER,
2.12 m for LEC), yet the app loops the last sample straight back to the first. That
ground is inside the wrap step too, so `lap` above is the recorded time PLUS the time
to cover it — otherwise the wrap step overshoots by exactly the shortfall, which on
LEC was a bigger error than the one being fixed.

Nothing about the CONTRACT moves: `t`, `meta.duration`, both schema refinements and
the whole of `app/src/engine/` are untouched. See `PLAN.md` §Slice 7.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

# --- contract constants (mirrored from app/src/engine/schema.ts) -------------------

#: Bump only for a BREAKING contract change. Must match `SCHEMA_VERSION` in schema.ts.
SCHEMA_VERSION = 1

#: The engine's thermal colour stops are calibrated in km/h; the schema pins the unit.
SPEED_UNIT = "km/h"

#: `meta.loop` — whether the samples form a CYCLE or an open segment. Mirrored from
#: `LOOP_MODES` in schema.ts, which rejects anything else.
#:
#: A lap closes: the segment leaving the last sample runs back to the first, because
#: that is where the car went. A session-time WINDOW does not, and cannot — several
#: cars do not simultaneously return to their starting positions — so the app holds
#: the last sample for the final grid step instead of gliding back to the start.
#:
#: This single fact is what separates the two builders below. It also decides, on its
#: own, that a window needs neither `closing_time` nor `source_times`: both exist only
#: to give the app's cyclic wrap step a full step of travel, and an open window has no
#: cyclic wrap step. See `build_window_replay_dict`.
LOOP_CLOSED = "closed"
LOOP_OPEN = "open"

#: FastF1's merged telemetry lands at roughly 4-10 Hz, so 10 Hz is the finest grid
#: that does not invent resolution. It also matches the committed app fixture, which
#: keeps "what the app was built against" and "what the pipeline emits" the same shape.
SAMPLE_RATE_HZ = 10

#: Used when a team colour is missing or malformed — the schema's hex regex rejects
#: anything else, and a colour lookup is not worth failing a fetch over.
#:
#: ACHROMATIC ON PURPOSE, and this is the whole point of the constant. It was
#: `#3671C6` — the hex widely published as Red Bull's brand blue — so a failed lookup
#: rendered as a plausible Red Bull lap, and that is precisely why the always-failing
#: `fastf1.plotting` lookup (one missing import, fixed in PR #31) survived a whole
#: slice unnoticed: the wrong output looked right.
#:
#: The replacement has to clear two bars at once, which exclude different things.
#: It must not read as a LIVERY: every F1 team colour is a saturated hue, and no
#: current livery occupies mid-grey (silver and white are high-value, near-white).
#: And it must not read as a DELIBERATE CHOICE either, which is what rules out the
#: loud alternatives — a magenta is unmistakably not a livery, but sat on a dark
#: canvas beside three team colours it reads as "selected". A desaturated mid grey is
#: what every UI already means by "no value". Pinned by test, r == g == b.
DEFAULT_COLOR = "#888888"

_HEX_COLOR = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

#: Channels the replay cannot be built without.
REQUIRED_COLUMNS = ("Time", "X", "Y", "Speed", "Throttle", "Brake", "nGear")

#: Season-dependent indicator channels. Absent is not an error: DRS is removed in
#: 2026 with no published replacement, and CLAUDE.md rule 8 forbids treating it as a
#: core field or branching on the year. A missing DRS column and an all-zero one are
#: handled identically — the `drs` key is simply omitted from the output.
OPTIONAL_COLUMNS = ("DRS",)


class TelemetryShapeError(ValueError):
    """Raised when source telemetry cannot produce a schema-conforming replay."""


class MissingColumnsError(TelemetryShapeError):
    """Raised when the loaded session lacks channels the replay needs."""


@dataclass(frozen=True)
class ReplayMeta:
    """The non-telemetry facts about a lap, gathered by the fetch layer."""

    year: int
    event: str
    session: str
    track: str
    driver: str
    team: str
    color: str
    #: Degrees, from FastF1 `circuit_info`. Applied by the app at render time; stored
    #: x/y are never rotated here (schema.ts documents this split).
    rotation: float


# --- column and value hygiene -----------------------------------------------------


def check_columns(columns: Iterable[str]) -> None:
    """
    Verify the loaded telemetry carries every required channel.

    Called before any channel is read, so a FastF1 upgrade that renames a column
    produces a named list rather than a `KeyError` from the middle of the maths.
    """
    present = set(columns)
    missing = [name for name in REQUIRED_COLUMNS if name not in present]
    if missing:
        raise MissingColumnsError(
            "telemetry is missing required channel(s): "
            + ", ".join(missing)
            + f"; got: {', '.join(sorted(present))}"
        )


def normalise_color(value: Any, fallback: str = DEFAULT_COLOR) -> str:
    """Coerce a team colour to the `#rgb`/`#rrggbb` the schema accepts."""
    if not isinstance(value, str):
        return fallback
    candidate = value.strip()
    if not candidate.startswith("#"):
        candidate = "#" + candidate
    return candidate if _HEX_COLOR.match(candidate) else fallback


def color_lookup_warning(driver: str, err: BaseException) -> str:
    """
    The line printed when a team-colour lookup fails, in the house tripwire format.

    LOUD, NOT FATAL — the volume moved, the handling did not. A colour is still not
    worth failing a fetch over, so the `except` in `build_replay.py` stays broad and
    stays non-fatal. What changed is the conditions: before PR #31 this fired on every
    single run, where a banner would have been pure noise and a quiet line was right.
    It should now never fire, so if it does it is NEW — either FastF1 moved its API
    again (the defect PR #31 fixed, returning) or a team is missing from the colour
    map. Both silently paint every car in the file `DEFAULT_COLOR`.

    The exception TYPE is reported alongside its message because `AttributeError` and
    `KeyError` are those two different diagnoses, and they have different fixes.

    It lives in this module, not next to the `except` that uses it, for the reason
    Slice 8 recorded when it moved `parse_lap_range`: `build_replay.py` imports FastF1,
    which CI does not install, so nothing in it can be tested — and a warning whose
    text is wrong is itself a quiet failure.
    """
    return (
        f"\nWARNING: {driver}: team colour lookup failed "
        f"({type(err).__name__}: {err}); "
        f"falling back to {DEFAULT_COLOR}, which is not a livery.\n"
    )


def clamp_throttle(values: Any) -> np.ndarray:
    """
    Clamp throttle into the schema's 0-100.

    The one channel clamped on purpose. Speed and gear are NOT clamped: an
    out-of-range value there is impossible rather than merely dirty, so the right
    outcome is the schema rejecting it loudly, not the pipeline hiding it.
    """
    return np.clip(np.asarray(values, dtype=float), 0.0, 100.0)


def normalise_brake(values: Any) -> np.ndarray:
    """FastF1 Brake arrives as bool, int or float; the schema wants literal 0 or 1."""
    return (np.asarray(values, dtype=float) > 0).astype(int)


# --- the uniform grid -------------------------------------------------------------


def uniform_grid(lap_time: float, rate: int = SAMPLE_RATE_HZ) -> np.ndarray:
    """
    The EMITTED sample times of the replay: exactly `k / rate` for k in 0..n-1.

    `n = floor(lap_time * rate) + 1` covers the lap from 0 up to the last grid point
    at or before its end. Because the step is exactly `1 / rate`, `meta.duration =
    n / rate` satisfies `round(duration * rate) == n` with no slack at all, which is
    what the schema's span-agreement refinement compares.

    This is the PLAYBACK clock, not the source clock: the instants each sample is
    actually read from are `source_times(grid, lap_time, rate)`, which lays the whole
    lap over the whole grid so the app's wrap step is as long as every other step.

    The epsilon absorbs binary float error in the multiply — a 58.5 s lap at 10 Hz
    can evaluate to 584.9999999999999, and flooring that would drop a whole sample.
    """
    if rate <= 0:
        raise ValueError(f"sample rate must be positive, got {rate}")
    if lap_time <= 0:
        raise TelemetryShapeError(f"lap_time must be positive, got {lap_time}")
    n = int(math.floor(lap_time * rate + 1e-9)) + 1
    if n < 2:
        raise TelemetryShapeError(
            f"lap_time {lap_time}s at {rate} Hz yields {n} sample(s); the schema "
            "needs at least 2 to interpolate between"
        )
    return np.arange(n, dtype=float) / rate


def time_base_stretch(
    n_samples: int, lap_time: float, rate: int = SAMPLE_RATE_HZ
) -> float:
    """
    `meta.duration / lap_time` — how much the emitted time base stretches the lap.

    Always >= 1, and never more than `1 + 1 / (rate * lap_time)`: the grid rounds the
    lap up by less than one step, so an 80 s lap at 10 Hz stretches by at most 0.125%.
    A three-second test lap stretches by 3.3%, which is why this is a named,
    printed number rather than an implementation detail — the bias is negligible on
    real data and only stays negligible on real data.

    `build_replay.py` prints it on every run. See the module docstring for why the
    stretch is worth having at all.
    """
    if lap_time <= 0:
        raise TelemetryShapeError(f"lap_time must be positive, got {lap_time}")
    return (n_samples / rate) / lap_time


def source_times(
    grid: np.ndarray, lap_time: float, rate: int = SAMPLE_RATE_HZ
) -> np.ndarray:
    """
    The SOURCE instants that the emitted grid samples are read from: `k * lap / n`.

    Every channel is resampled at these times while `build_samples` emits `k / rate`,
    which is the whole of the wrap-step fix. Two properties do the work:

    * the spacing is `lap / n`, so the n-th step — the one the app takes wrapping the
      last sample round to the first — covers exactly as much real time, and
      therefore as much ground, as the n-1 steps before it;
    * the last value is `lap * (n-1) / n`, strictly inside the source data, so
      nothing here ever extrapolates past the final telemetry row.

    Applied to EVERY channel, not just position: the alternative leaves x/y reading
    one instant and speed reading another, which is the class of bug Slice 6b existed
    to remove. A uniform stretch keeps the channels mutually consistent, and the app
    has no clock outside the file to disagree with.
    """
    return np.asarray(grid, dtype=float) / time_base_stretch(
        len(grid), lap_time, rate
    )


def interp_continuous(grid: np.ndarray, t: np.ndarray, values: Any) -> np.ndarray:
    """
    Resample a CONTINUOUS channel (x, y, speed, throttle) by linear interpolation.

    CLAUDE.md rule 6: continuous channels interpolate, discrete ones forward-fill.
    """
    return np.interp(grid, t, np.asarray(values, dtype=float))


def forward_fill(grid: np.ndarray, t: np.ndarray, values: Any) -> np.ndarray:
    """
    Resample a DISCRETE channel (gear, brake, drs) by forward-fill: each grid point
    carries the value of the last real sample at or before it.

    `side="right"` then `- 1` is what makes it a forward fill. The previous
    implementation used `np.searchsorted(t, grid)` — side="left" — which returns the
    first sample at or AFTER the grid point, so every gearshift and brake
    application landed up to one grid step early. Interpolating instead would be
    worse still: a half-open DRS flap, or gear 4.5.
    """
    t = np.asarray(t, dtype=float)
    idx = np.searchsorted(t, np.asarray(grid, dtype=float), side="right") - 1
    np.clip(idx, 0, len(t) - 1, out=idx)
    return np.asarray(values)[idx]


def has_drs(values: Any) -> bool:
    """
    True when a DRS channel is present AND carries a non-zero code.

    An absent channel and an all-zero one are the same thing to the schema: `drs` is
    omitted from every sample. All-zero is what a 2026+ session looks like, and what
    a driver who never opened it looks like over a short window — which is why the
    WINDOW builder decides this once for the whole replay rather than per car. See
    `build_samples`.
    """
    return values is not None and bool(np.any(np.asarray(values) != 0))


def resample_channels(
    src: np.ndarray, t: np.ndarray, telemetry: Mapping[str, Any]
) -> "dict[str, np.ndarray | None]":
    """
    Resample every channel EXCEPT position onto the source instants `src`.

    Position is deliberately absent: it is the one channel the two builders treat
    differently (a lap always places samples by travelled distance and fails loudly
    on data that covers no ground; a window has to tolerate a parked car), so it
    stays at the call sites where that difference is visible. Everything here is
    identical for a lap and for a window, and shared so it can only be got wrong
    once.

    Resampling is by channel TYPE, per CLAUDE.md rule 6: continuous channels
    interpolate, discrete ones forward-fill.
    """
    raw_drs = telemetry.get("DRS")
    return {
        "speed": interp_continuous(src, t, telemetry["Speed"]),
        "throttle": clamp_throttle(interp_continuous(src, t, telemetry["Throttle"])),
        "brake": forward_fill(src, t, normalise_brake(telemetry["Brake"])),
        "gear": forward_fill(src, t, np.asarray(telemetry["nGear"]).astype(int)),
        "drs": (
            None
            if raw_drs is None
            else forward_fill(src, t, np.asarray(raw_drs).astype(int))
        ),
    }


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

    def ratio(i: int, j: int) -> float:
        """Implied rate from fix `i` to fix `j`, over the channel, over the median."""
        span = ts[j] - ts[i]
        # The faster of the two endpoints, so a car accelerating out of a corner is
        # judged against the speed it reached rather than the one it left.
        chan = max(vs[i], vs[j])
        if span <= 0.0 or chan < min_speed:
            return 0.0
        reach = np.hypot(px[j] - px[i], py[j] - py[i]) / span
        return float(reach / chan / scale)

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
    target = np.clip(travelled / d[-1] * s[-1], 0.0, s[-1])

    return (
        interp_continuous(target, s[moved], kx[moved]),
        interp_continuous(target, s[moved], ky[moved]),
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
) -> "dict[str, Any]":
    """
    Build a complete, schema-conforming replay from one lap of telemetry.

    `telemetry` maps FastF1 channel names to arrays — `Time` in seconds, and the
    channels named in `REQUIRED_COLUMNS`/`OPTIONAL_COLUMNS`. Taking a plain mapping
    rather than a DataFrame is what keeps this module free of pandas and testable
    against three-row synthetic frames.
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

    # The lap the app LOOPS is the recorded path plus the chord back to its start, so
    # that is the lap the grid has to cover. See `closing_time`.
    # Impossible fixes are dropped BEFORE anything measures the path: `closing_time`
    # reads the last recorded fix, and an excursion sitting on it would set the whole
    # lap's time base from a point the car was never at.
    rejection = reject_impossible_fixes(
        t, telemetry["X"], telemetry["Y"], telemetry["Speed"]
    )
    kx = np.asarray(telemetry["X"], dtype=float)[rejection.keep]
    ky = np.asarray(telemetry["Y"], dtype=float)[rejection.keep]
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
        src, t, telemetry["X"], telemetry["Y"], telemetry["Speed"], rejection.keep
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
        x, y = car.telemetry["X"], car.telemetry["Y"]
        rejection = reject_impossible_fixes(t, x, y, car.telemetry["Speed"])
        rejections.append((str(car.driver), rejection))
        # Parked or moving — the one place a window differs from a lap in how
        # positions are placed. See `covers_ground`.
        if covers_ground(t, x, y, car.telemetry["Speed"]):
            gx, gy = resample_positions_by_travel(
                src, t, x, y, car.telemetry["Speed"], rejection.keep
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
            }
            for car, _, _, samples in built
        ],
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


def fix_rejection_report(
    driver: str, r: "FixRejection", offset: float = 0.0
) -> str:
    """
    One line per car, in the same family as the time-base stretch and motion fidelity.

    A clean car prints `0 rejected` rather than nothing: silence is indistinguishable
    from a detector that never ran.

    A SURRENDER carries its arc-over-net ratio, because that ratio is what says which
    KIND of problem was declined. ~1.0 is a step change — the polyline relocates and
    stays, and bridging it would mean deciding which side is real, which is
    reconstruction rather than cleaning. Much greater than 1 is an excursion that
    doubles back but ran longer than the bound. Measured on 2024 Silverstone R VER:
    2.56 for the out-and-back, 1.00 for the pit-entry step.
    """
    if r.n_rejected == 0 and not r.surrendered:
        return f"  {driver}: 0 position fixes rejected"
    at = ", ".join(f"{t - offset:.1f}" for t in r.rejected_times[:6])
    more = "..." if len(r.rejected_times) > 6 else ""
    line = (
        f"  {driver}: {r.n_rejected} position fix(es) rejected "
        f"(worst {r.worst_ratio:.1f}x implied vs channel)"
    )
    if at:
        line += f" at t={at}{more}"
    if r.seed_retracted:
        line += "\n      first fix was itself wild; anchor retracted and re-seeded"
    for a, b, ratio in r.surrendered:
        kind = "step change: relocates and stays" if ratio < 1.8 else "excursion"
        line += (
            f"\n      SURRENDERED t={a - offset:.1f}-{b - offset:.1f}s arc/net={ratio:.2f} ({kind}) "
            f"- kept, not bridged"
        )
    return line


def window_car_report(
    cars: Sequence[WindowCar],
) -> "list[tuple[str, bool, float]]":
    """
    Per car: `(driver, moved, distance travelled in metres)`.

    The distance is converted from the travel integral by the one contract-backed
    conversion this module has (`KMH_S_PER_METRE`). It is deliberately NOT derived
    from the position channel, whose scale is the undocumented unknown.

    WHAT THIS DELIBERATELY DOES NOT REPORT, and why
    -----------------------------------------------
    An earlier version of this function also reported each car's `path / travel`
    ratio, on the theory that it was a per-car "unit bridge" whose spread across cars
    would bound how far two cars' along-track positions could disagree — a number
    Slice 9's relative gaps would rest on. Measured on 2024 Monza R it came out at
    24 m across VER/LEC/NOR, which looked alarming.

    IT WAS MEASURING NOTHING. `resample_positions_by_travel` places sample k at
    `(d_k / d_total) * s_total` — a FRACTION of the car's own path — so the ratio
    cancels out of the emitted positions entirely. That is 6b's unit-agnosticism,
    and it is pinned by a test: multiplying one car's speed channel by 1.5 moves its
    ratio by 33% and leaves every emitted coordinate byte-identical.

    So there is no cross-car bridge drift to bound, and "fix" it by sharing one
    bridge between cars would be a regression — it would reintroduce the scale
    dependence 6b removed, unpin each car's endpoint from its own last recorded fix,
    and reopen the overrun 6b rejected. The honest per-car quality metric is
    `motion_fidelity`, which measures something the output actually carries.
    """
    report = []
    for car in cars:
        t = np.asarray(car.telemetry["Time"], dtype=float)
        moved = covers_ground(
            t, car.telemetry["X"], car.telemetry["Y"], car.telemetry["Speed"]
        )
        travel = float(cumulative_travel(t, car.telemetry["Speed"])[-1])
        report.append((str(car.driver), moved, travel / KMH_S_PER_METRE))
    return report


def motion_fidelity(
    samples: Sequence[Mapping[str, Any]], rate: int = SAMPLE_RATE_HZ
) -> "tuple[float, float] | None":
    """
    Does this car's marker move at the speed the HUD shows? `(r, cv)`, or `None` for
    a car that never moved.

    This is Slice 6b's verification metric, computed on the emitted samples instead
    of by hand: the implied velocity `|dxy| * rate` between consecutive samples,
    against the speed channel over the same step, at k = 1 (the single-step window,
    no smoothing).

    * `r` — correlation. 6b's target was **> 0.97**; before the arc-length fix a real
      lap scored 0.70 and after it 0.9998.
    * `cv` — the implied/actual ratio's coefficient of variation, `sd / mean`. 6b's
      headline number: 0.2717 before, 0.0070 after.

    BOTH ARE SCALE-FREE, which is what makes them usable here at all. The implied
    velocity is in position-units per second and the speed channel is in km/h, and
    this module does not know the conversion between them — but a correlation is
    invariant under scaling either axis, and dividing the ratio's sd by its own mean
    cancels the same unknown. No hard-coded 0.1 or 1/3.6, exactly as 6b requires.

    Every step here is a real step: an open window has no cyclic wrap step to
    exclude, unlike a lap. Steps where the car is stationary are dropped — a zero
    denominator carries no information about fidelity — and `None` comes back when
    too few remain to correlate.
    """
    x = np.array([float(s["x"]) for s in samples])
    y = np.array([float(s["y"]) for s in samples])
    v = np.array([float(s["speed"]) for s in samples])

    implied = np.hypot(np.diff(x), np.diff(y)) * rate
    actual = 0.5 * (v[:-1] + v[1:])
    moving = actual > 0.0
    if int(np.count_nonzero(moving)) < 2:
        return None

    implied, actual = implied[moving], actual[moving]
    if implied.std() == 0.0 or actual.std() == 0.0:
        return None

    ratio = implied / actual
    return float(np.corrcoef(implied, actual)[0, 1]), float(ratio.std() / ratio.mean())


def dump_json(replay: Mapping[str, Any], compact: bool = False) -> str:
    """
    Serialise a replay canonically: sorted keys, 2-space indent, trailing newline.

    Formatting is for HUMANS — a regenerated golden file diffs line by line instead
    of as one enormous line. It is explicitly NOT what `tests/test_golden.py`
    asserts; that compares parsed structures, so key order and float repr cannot
    turn a formatting change into a phantom behaviour change.

    :param compact: drop the indentation and inter-token spaces. For files that are
        DEPLOYED rather than reviewed — the gallery assets in `app/public/gallery/`,
        which no human reads as a diff. Measured on real output it is a 2.3x saving
        (3.74 MB -> 1.62 MB for a 3-car, 7-lap window), which is worth having in a
        repo and on the wire but worth nothing in a golden.

        Keys stay SORTED either way, so the two forms differ only in whitespace and
        `json.loads` cannot tell them apart. The default is False so every existing
        caller — every golden, every `--out` without `--compact` — emits exactly the
        bytes it emitted before this parameter existed.
    """
    if compact:
        return json.dumps(replay, separators=(",", ":"), sort_keys=True) + "\n"
    return json.dumps(replay, indent=2, sort_keys=True) + "\n"
