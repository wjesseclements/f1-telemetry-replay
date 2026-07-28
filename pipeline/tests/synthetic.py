"""
synthetic.py — deterministic fake telemetry for the pipeline's tests and goldens.

Fixture/dev material, not production code — the same status the prototype's
generator has. Nothing here imports FastF1 or touches the network, which is what
lets the pipeline be tested (and its goldens regenerated) in CI with no network at
all.

Determinism is load-bearing: `test_golden.py` compares regenerated output against
committed files, so there is no RNG here and every value is a closed-form function
of the sample index.
"""

from __future__ import annotations

import math

import numpy as np

from replay_transform import ReplayMeta

#: Source telemetry is generated at an uneven ~7 Hz so the tests exercise real
#: resampling rather than an identity transform onto the 10 Hz grid.
SOURCE_RATE_HZ = 7.0

CORNERS = [
    {"Number": 1, "Letter": "", "X": 620.0, "Y": 140.0},
    {"Number": 2, "Letter": "A", "X": -410.0, "Y": 305.0},
    {"Number": 3, "Letter": None, "X": -180.0, "Y": -470.0},
]

META = ReplayMeta(
    year=2024,
    event="Synthetic GP",
    session="Q",
    track="Synthetic Circuit",
    driver="SYN",
    team="Synthetic Racing",
    color="#3671C6",
    rotation=-14.0,
)

#: A 2026-shaped meta: same lap, a season with no DRS channel.
META_NO_DRS = ReplayMeta(
    year=2026,
    event="Synthetic GP",
    session="Q",
    track="Synthetic Circuit",
    driver="SYN",
    team="Synthetic Racing",
    color="#3671C6",
    rotation=-14.0,
)


def telemetry(duration_s: float = 3.0, drs: bool = True) -> "dict[str, np.ndarray]":
    """
    One short lap of plausible-looking telemetry on an oval.

    :param duration_s: length of the source data, in seconds.
    :param drs:        when False, the DRS channel is all-zero — what a 2026+
                       session looks like, and what makes the pipeline omit the key.
    """
    n = int(round(duration_s * SOURCE_RATE_HZ)) + 1
    t = np.arange(n, dtype=float) / SOURCE_RATE_HZ

    # A closed oval, so x/y are smooth and interpolation has something to do.
    angle = 2.0 * math.pi * t / max(duration_s, 1e-9)
    x = 800.0 * np.cos(angle)
    y = 450.0 * np.sin(angle)

    # Speed dips in the middle of the lap (a corner) and recovers.
    speed = 250.0 - 90.0 * np.sin(angle) ** 2

    # Throttle deliberately overshoots 100: real FastF1 does this, and the schema
    # rejects it, so the clamp has to be exercised by the golden path too.
    throttle = np.clip(105.0 - 60.0 * np.sin(angle) ** 2, 0.0, None)

    brake = (np.sin(angle) ** 2 > 0.75).astype(int)
    gear = np.clip(np.round(2 + 6 * (speed - 160.0) / 90.0), 1, 8).astype(int)

    channels = {
        "Time": t,
        "X": x,
        "Y": y,
        "Speed": speed,
        "Throttle": throttle,
        "Brake": brake,
        "nGear": gear,
    }
    # RAW FastF1 DRS codes: 0/1/8 closed, 10/12/14 open. The pipeline forward-fills
    # the raw value and never decodes it — `app/src/engine/drs.ts` owns that mapping.
    channels["DRS"] = (
        np.where(np.cos(angle) > 0.5, 12, 0).astype(int)
        if drs
        else np.zeros(n, dtype=int)
    )
    return channels
