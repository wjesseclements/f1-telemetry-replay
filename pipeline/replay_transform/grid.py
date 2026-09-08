"""
grid.py — the uniform emitted grid, and per-channel resampling onto it.

Owns the playback clock (`uniform_grid`), the source-instant mapping that feeds the
app's cyclic wrap step (`source_times`, `time_base_stretch`), and resampling by
channel type (CLAUDE.md rule 6). Split verbatim from `replay_transform.py` in
Slice 9i Phase 0; no behaviour change.
"""

from __future__ import annotations

import math
from typing import Any, Mapping

import numpy as np

from .contract import (
    SAMPLE_RATE_HZ,
    TelemetryShapeError,
    clamp_throttle,
    normalise_brake,
    normalise_gear,
)

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
        # Normalised BEFORE the fill, so a garbage reading is zeroed rather than
        # forward-filled over real neutral samples. See `normalise_gear`.
        "gear": forward_fill(src, t, normalise_gear(telemetry["nGear"])),
        "drs": (
            None
            if raw_drs is None
            else forward_fill(src, t, np.asarray(raw_drs).astype(int))
        ),
    }
