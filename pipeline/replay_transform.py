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
    The sample times of the replay: exactly `k / rate` for k in 0..n-1.

    `n = floor(lap_time * rate) + 1` covers the lap from 0 up to the last grid point
    at or before its end. Because the step is exactly `1 / rate`, `meta.duration =
    n / rate` satisfies `round(duration * rate) == n` with no slack at all, which is
    what the schema's span-agreement refinement compares.

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

    grid = uniform_grid(float(t[-1]), rate)

    gx = interp_continuous(grid, t, telemetry["X"])
    gy = interp_continuous(grid, t, telemetry["Y"])
    gspeed = interp_continuous(grid, t, telemetry["Speed"])
    gthrottle = clamp_throttle(interp_continuous(grid, t, telemetry["Throttle"]))
    gbrake = forward_fill(grid, t, normalise_brake(telemetry["Brake"]))
    ggear = forward_fill(grid, t, np.asarray(telemetry["nGear"]).astype(int))

    raw_drs = telemetry.get("DRS")
    gdrs = (
        None
        if raw_drs is None
        else forward_fill(grid, t, np.asarray(raw_drs).astype(int))
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
