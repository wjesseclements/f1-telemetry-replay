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

from replay_transform import ReplayMeta, SessionMeta, WindowCar

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


# --- a synthetic RACE session (v2 windows) ----------------------------------------
#
# The lap generator above is one car with `Time` rebased to zero. A window needs the
# opposite: several cars on a SHARED session axis that deliberately does not start at
# zero, so a test can catch anyone rebasing it (which would destroy the alignment
# that is the whole point of v2 — CLAUDE.md rule 5).
#
# The track is a circle traversed at constant speed. That is chosen so the alignment
# is checkable in CLOSED FORM: a car's position is an exact function of session time,
# so two cars generated with a known time offset must come out of the pipeline still
# carrying it, and any single car's emitted position can be compared against the
# formula rather than against another run of the same code.

#: Session seconds at which the synthetic race window opens. Not zero, and not round:
#: a rebasing bug that divided by the first timestamp would still look plausible at 0.
SESSION_T0 = 1042.5
#: One lap of the synthetic circle, in seconds.
SESSION_LAP_S = 20.0
SESSION_RADIUS = 800.0
#: MEAN speed. The profile below oscillates around it, so a lap still covers the same
#: ground in the same time.
SESSION_SPEED_KMH = 210.0
#: Amplitude and period of the speed oscillation, as a fraction of the mean. Speed is
#: deliberately NOT constant: a constant-speed car has no variance to correlate, so
#: `motion_fidelity` — 6b's r-and-spread metric — cannot be measured on one at all.
#: Positions are driven by the INTEGRAL of this profile (see `session_position`), so
#: the fixture is a car whose marker genuinely moves at the speed it reports.
SESSION_SPEED_WAVE = 0.35
SESSION_SPEED_PERIOD_S = 8.0

SESSION_META = SessionMeta(
    year=2024,
    event="Synthetic GP",
    session="R",
    track="Synthetic Circuit",
    rotation=-14.0,
)

TEAMS = {
    "AAA": ("Alpha Racing", "#3671C6"),
    "BBB": ("Beta Racing", "#F91536"),
    "CCC": ("Gamma Racing", "#FF8000"),
}


def session_speed(t, offset_s: float = 0.0) -> np.ndarray:
    """Closed-form speed, in km/h, at session time(s) `t`."""
    tau = np.asarray(t, dtype=float) - offset_s
    wave = np.sin(2.0 * math.pi * tau / SESSION_SPEED_PERIOD_S)
    return SESSION_SPEED_KMH * (1.0 + SESSION_SPEED_WAVE * wave)


def _session_distance(tau: np.ndarray) -> np.ndarray:
    """Analytic integral of `session_speed` — distance covered by time `tau`."""
    swing = SESSION_SPEED_WAVE * SESSION_SPEED_PERIOD_S / (2.0 * math.pi)
    return SESSION_SPEED_KMH * (
        tau + swing * (1.0 - np.cos(2.0 * math.pi * tau / SESSION_SPEED_PERIOD_S))
    )


def session_position(t, offset_s: float = 0.0) -> "tuple[np.ndarray, np.ndarray]":
    """
    Closed-form position on the synthetic circle at session time(s) `t`.

    The angle is driven by the INTEGRAL of the speed profile, not by elapsed time, so
    the car is genuinely where its own speed channel says it is. That is what makes
    the fixture a fair test of `resample_positions_by_travel` (which reconstructs
    exactly this relationship) and of `motion_fidelity` (which measures it).

    `offset_s` shifts the car along the track in time: two cars differing only by an
    offset are at the same points in the same order, a fixed interval apart. That is
    what a test asserts the pipeline preserves.
    """
    tau = np.asarray(t, dtype=float) - offset_s
    # One nominal lap is the ground the MEAN speed covers in `SESSION_LAP_S`.
    angle = 2.0 * math.pi * _session_distance(tau) / (SESSION_SPEED_KMH * SESSION_LAP_S)
    return SESSION_RADIUS * np.cos(angle), SESSION_RADIUS * np.sin(angle)


def session_telemetry(
    start: float,
    end: float,
    *,
    offset_s: float = 0.0,
    rate: float = SOURCE_RATE_HZ,
    drs: bool = True,
    stopped_from: "float | None" = None,
) -> "dict[str, np.ndarray]":
    """
    One car's telemetry over `[start, end]` SESSION seconds.

    :param offset_s:     shifts the car around the circle — see `session_position`.
    :param rate:         source sample rate; pass a different one per car to make the
                         cars unequal in data quality, which is what a race actually
                         serves.
    :param stopped_from: session time at which the car stops dead and stays put — a
                         retirement. Speed goes to zero and the position holds, which
                         is the partially-zero-speed case the travel integral already
                         handles.
    """
    n = int(round((end - start) * rate)) + 1
    t = start + np.arange(n, dtype=float) / rate

    moving = t if stopped_from is None else np.minimum(t, stopped_from)
    x, y = session_position(moving, offset_s)
    speed = session_speed(moving, offset_s)
    if stopped_from is not None:
        speed = np.where(t <= stopped_from, speed, 0.0)

    channels = {
        "Time": t,
        "X": x,
        "Y": y,
        "Speed": speed,
        "Throttle": np.full(n, 90.0),
        "Brake": np.zeros(n, dtype=int),
        "nGear": np.full(n, 7, dtype=int),
    }
    channels["DRS"] = (
        np.where(np.cos(2.0 * math.pi * t / SESSION_LAP_S) > 0.5, 12, 0).astype(int)
        if drs
        else np.zeros(n, dtype=int)
    )
    return channels


def parked_telemetry(
    start: float, end: float, at: "tuple[float, float]" = (600.0, -200.0)
) -> "dict[str, np.ndarray]":
    """
    A car that never moves: speed reads a flat zero and the position fixes wander by
    a metre or two, exactly as a real GPS trace does in a pit box.

    This is the case `covers_ground` exists for. The jitter is deliberately LARGE
    enough to accumulate real arc length, so a predicate that only tested the path
    would call this car "moving".
    """
    n = int(round((end - start) * SOURCE_RATE_HZ)) + 1
    t = start + np.arange(n, dtype=float) / SOURCE_RATE_HZ
    # Deterministic, closed-form jitter — no RNG, so the goldens stay reproducible.
    jitter_x = 18.0 * np.sin(3.1 * np.arange(n))
    jitter_y = 18.0 * np.cos(2.3 * np.arange(n))
    return {
        "Time": t,
        "X": at[0] + jitter_x,
        "Y": at[1] + jitter_y,
        "Speed": np.zeros(n),
        "Throttle": np.zeros(n),
        "Brake": np.ones(n, dtype=int),
        "nGear": np.zeros(n, dtype=int),
        "DRS": np.zeros(n, dtype=int),
    }


def window_car(driver: str, telemetry: "dict[str, np.ndarray]") -> WindowCar:
    """Wrap telemetry with a driver's identity, using the fixed synthetic teams."""
    team, color = TEAMS[driver]
    return WindowCar(driver=driver, team=team, color=color, telemetry=telemetry)


def session_distance_m(start: float, end: float, offset_s: float = 0.0) -> float:
    """
    Ground a car covers between two SESSION times, in METRES.

    Both endpoints are needed rather than just the span: the speed profile's phase is
    a function of absolute session time, so the same span covers different distances
    depending on where in the oscillation it falls.
    """
    edges = _session_distance(np.array([start, end], dtype=float) - offset_s)
    return float(edges[1] - edges[0]) / 3.6
