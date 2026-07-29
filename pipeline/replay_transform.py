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

#: FastF1's merged telemetry lands at roughly 4-10 Hz, so 10 Hz is the finest grid
#: that does not invent resolution. It also matches the committed app fixture, which
#: keeps "what the app was built against" and "what the pipeline emits" the same shape.
SAMPLE_RATE_HZ = 10

#: Used when a team colour is missing or malformed — the schema's hex regex rejects
#: anything else, and a colour lookup is not worth failing a fetch over.
DEFAULT_COLOR = "#3671C6"

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


def resample_positions_by_travel(
    times: np.ndarray, t: np.ndarray, x: Any, y: Any, speed: Any
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
    s = cumulative_arclength(x, y)
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

    px = np.asarray(x, dtype=float)[moved]
    py = np.asarray(y, dtype=float)[moved]
    return (
        interp_continuous(target, s[moved], px),
        interp_continuous(target, s[moved], py),
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
    """
    include_drs = drs is not None and bool(np.any(np.asarray(drs) != 0))
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
    lap_time = float(t[-1]) + closing_time(
        t, telemetry["X"], telemetry["Y"], telemetry["Speed"]
    )
    grid = uniform_grid(lap_time, rate)
    # Sample times are EMITTED as `grid` (k / rate, what the schema requires) but READ
    # at `src` (k * lap / n), which lays the whole lap over the whole grid so the app's
    # wrap step is as long as every other step. Every channel uses the same `src`, so
    # they stay mutually consistent. See the module docstring and `source_times`.
    src = source_times(grid, lap_time, rate)

    # x/y come from the path, parameterised by travelled distance rather than by time
    # (see the module docstring); every other channel is a plain resample.
    gx, gy = resample_positions_by_travel(
        src, t, telemetry["X"], telemetry["Y"], telemetry["Speed"]
    )
    gspeed = interp_continuous(src, t, telemetry["Speed"])
    gthrottle = clamp_throttle(interp_continuous(src, t, telemetry["Throttle"]))
    gbrake = forward_fill(src, t, normalise_brake(telemetry["Brake"]))
    ggear = forward_fill(src, t, np.asarray(telemetry["nGear"]).astype(int))

    raw_drs = telemetry.get("DRS")
    gdrs = (
        None
        if raw_drs is None
        else forward_fill(src, t, np.asarray(raw_drs).astype(int))
    )

    samples = build_samples(grid, gx, gy, gspeed, gthrottle, gbrake, ggear, gdrs)
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


def dump_json(replay: Mapping[str, Any]) -> str:
    """
    Serialise a replay canonically: sorted keys, 2-space indent, trailing newline.

    Formatting is for HUMANS — a regenerated golden file diffs line by line instead
    of as one enormous line. It is explicitly NOT what `tests/test_golden.py`
    asserts; that compares parsed structures, so key order and float repr cannot
    turn a formatting change into a phantom behaviour change.
    """
    return json.dumps(replay, indent=2, sort_keys=True) + "\n"
