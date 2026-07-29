"""
Unit tests for the pure transform.

The bar here is the app's bar: `app/vite.config.ts` gates `src/engine/**` at 90%
lines/branches/functions per file, and `replay_transform.py` is the pipeline's
engine, so `pytest.ini` gates it the same way rather than trusting a promise.

Every assertion traces to a rule in `app/src/engine/schema.ts`. Where a test pins
something that used to be wrong, it says so — those are regression tests, not
descriptions.
"""

from __future__ import annotations

import json
import math

import numpy as np
import pytest

import synthetic
from replay_transform import (
    DEFAULT_COLOR,
    SAMPLE_RATE_HZ,
    SCHEMA_VERSION,
    SPEED_UNIT,
    MissingColumnsError,
    TelemetryShapeError,
    build_corners,
    build_replay_dict,
    build_samples,
    check_columns,
    clamp_throttle,
    closing_time,
    cumulative_arclength,
    cumulative_travel,
    dump_json,
    forward_fill,
    interp_continuous,
    normalise_brake,
    normalise_color,
    resample_positions_by_travel,
    source_times,
    time_base_stretch,
    uniform_grid,
)


# --- columns ----------------------------------------------------------------------


def test_check_columns_accepts_a_complete_frame():
    check_columns(synthetic.telemetry().keys())


def test_check_columns_names_every_missing_channel():
    columns = ["Time", "X", "Speed"]
    with pytest.raises(MissingColumnsError) as excinfo:
        check_columns(columns)
    message = str(excinfo.value)
    for missing in ("Y", "Throttle", "Brake", "nGear"):
        assert missing in message
    # It also says what DID arrive; a rename is only diagnosable with both halves.
    assert "Speed" in message


def test_check_columns_does_not_require_drs():
    """DRS is season-dependent and never a core field (CLAUDE.md rule 8)."""
    channels = synthetic.telemetry()
    del channels["DRS"]
    check_columns(channels.keys())


# --- value hygiene ----------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        ("#3671C6", "#3671C6"),
        ("#abc", "#abc"),
        ("3671C6", "#3671C6"),  # FastF1 has returned bare hex
        ("  #3671C6  ", "#3671C6"),
        ("rebeccapurple", DEFAULT_COLOR),
        ("#12345", DEFAULT_COLOR),
        ("", DEFAULT_COLOR),
        (None, DEFAULT_COLOR),
        (0x3671C6, DEFAULT_COLOR),
    ],
)
def test_normalise_color(value, expected):
    assert normalise_color(value) == expected


def test_clamp_throttle_pulls_both_ends_into_range():
    """The schema rejects >100; real FastF1 throttle occasionally reads above it."""
    clamped = clamp_throttle([-2.0, 0.0, 55.5, 100.0, 105.0])
    assert list(clamped) == [0.0, 0.0, 55.5, 100.0, 100.0]


@pytest.mark.parametrize(
    "raw", [[True, False], [1, 0], [1.0, 0.0]], ids=["bool", "int", "float"]
)
def test_normalise_brake_yields_literal_zero_or_one(raw):
    assert list(normalise_brake(raw)) == [1, 0]


# --- the uniform grid -------------------------------------------------------------


def test_uniform_grid_lands_exactly_on_k_over_rate():
    grid = uniform_grid(2.0, 10)
    assert len(grid) == 21
    for k, value in enumerate(grid):
        assert value == k / 10


def test_uniform_grid_never_extrapolates_past_the_lap():
    """`floor(lap_time * rate) + 1` puts the last point at or before the lap end."""
    for lap_time in (2.0, 2.04, 2.09, 58.5):
        grid = uniform_grid(lap_time, SAMPLE_RATE_HZ)
        assert grid[-1] <= lap_time + 1e-9


def test_uniform_grid_absorbs_binary_float_error():
    """58.5 * 10 evaluates below 585 in binary; flooring it would drop a sample."""
    assert len(uniform_grid(58.5, 10)) == 586
    assert uniform_grid(58.5, 10)[-1] == pytest.approx(58.5)


def test_uniform_grid_span_matches_meta_duration_exactly():
    """The schema compares `len(samples)` against `round(duration * sampleRateHz)`."""
    for lap_time in (1.0, 3.3, 87.42):
        grid = uniform_grid(lap_time, SAMPLE_RATE_HZ)
        duration = round(len(grid) / SAMPLE_RATE_HZ, 3)
        assert round(duration * SAMPLE_RATE_HZ) == len(grid)


@pytest.mark.parametrize("rate", [0, -10])
def test_uniform_grid_rejects_a_non_positive_rate(rate):
    with pytest.raises(ValueError):
        uniform_grid(10.0, rate)


@pytest.mark.parametrize("lap_time", [0.0, -1.0])
def test_uniform_grid_rejects_a_non_positive_lap_time(lap_time):
    with pytest.raises(TelemetryShapeError):
        uniform_grid(lap_time, SAMPLE_RATE_HZ)


def test_uniform_grid_rejects_a_lap_too_short_to_interpolate():
    """The schema needs >= 2 samples per car to have a segment to interpolate."""
    with pytest.raises(TelemetryShapeError, match="at least 2"):
        uniform_grid(0.05, 10)


# --- the time base ----------------------------------------------------------------


def test_time_base_stretch_is_duration_over_lap_time():
    """The number `build_replay.py` prints: how much longer the replay is than the lap."""
    grid = uniform_grid(79.67, SAMPLE_RATE_HZ)
    assert len(grid) == 797
    assert time_base_stretch(len(grid), 79.67, SAMPLE_RATE_HZ) == pytest.approx(
        79.7 / 79.67
    )


def test_time_base_stretch_stays_under_one_grid_step_of_the_lap():
    """
    It is bounded by `1 + 1/(rate*lap)`, so it shrinks as laps get longer: negligible
    on a real 80 s lap (< 0.13%), noticeable on a 3 s synthetic one. The bound is the
    reason the bias is acceptable, so it is pinned rather than assumed.
    """
    for lap_time in (3.0, 58.5, 79.67, 87.42):
        n = len(uniform_grid(lap_time, SAMPLE_RATE_HZ))
        stretch = time_base_stretch(n, lap_time, SAMPLE_RATE_HZ)
        assert 1.0 <= stretch <= 1.0 + 1.0 / (SAMPLE_RATE_HZ * lap_time) + 1e-12
    assert time_base_stretch(797, 79.67, SAMPLE_RATE_HZ) < 1.0013


@pytest.mark.parametrize("lap_time", [0.0, -1.0])
def test_time_base_stretch_rejects_a_non_positive_lap_time(lap_time):
    with pytest.raises(TelemetryShapeError):
        time_base_stretch(10, lap_time, SAMPLE_RATE_HZ)


def test_source_times_are_evenly_spaced_and_close_the_lap():
    """
    The whole wrap-step fix in two assertions: the source instants are spaced
    `lap / n`, and the last one is exactly one such step short of the lap end — so the
    step the app takes wrapping the last sample round to the first covers the same
    span of real time as every step before it.
    """
    lap_time = 2.05
    grid = uniform_grid(lap_time, 10)  # 21 points, 0.0 .. 2.0; duration 2.1
    src = source_times(grid, lap_time, 10)

    step = lap_time / len(grid)
    assert np.allclose(np.diff(src), step)
    assert src[0] == 0.0
    assert src[-1] == pytest.approx(lap_time - step)
    # Reading at the emitted grid instead is what left the wrap short: the last
    # sample sat 0.05 s from the lap end where the wrap step is 0.1 s long.
    assert grid[-1] == pytest.approx(lap_time - 0.05)


def test_source_times_never_reach_past_the_last_telemetry_row():
    """No extrapolation: `src[-1] < lap_time` strictly, for any lap length."""
    for lap_time in (0.35, 3.0, 58.5, 79.67):
        grid = uniform_grid(lap_time, SAMPLE_RATE_HZ)
        assert source_times(grid, lap_time, SAMPLE_RATE_HZ)[-1] < lap_time


# --- resampling -------------------------------------------------------------------


def test_interp_continuous_lerps_between_source_samples():
    t = np.array([0.0, 1.0, 2.0])
    values = interp_continuous(np.array([0.0, 0.5, 1.0, 1.25, 2.0]), t, [0.0, 10.0, 30.0])
    assert list(values) == [0.0, 5.0, 10.0, 15.0, 30.0]


def test_forward_fill_holds_the_previous_value_across_a_gearshift():
    """
    Regression test. The old implementation used `np.searchsorted(t, grid)` —
    side="left" — which returns the first sample at or AFTER the grid point, so it
    reported the NEXT gear. Every shift and brake application landed up to one grid
    step early.
    """
    t = np.array([0.0, 1.0, 2.0])
    gear = np.array([4, 5, 6])
    filled = forward_fill(np.array([0.0, 0.5, 0.99, 1.0, 1.5, 2.0]), t, gear)
    assert list(filled) == [4, 4, 4, 5, 5, 6]


def test_forward_fill_takes_the_sample_exactly_on_a_boundary():
    t = np.array([0.0, 1.0])
    assert list(forward_fill(np.array([1.0]), t, np.array([7, 9]))) == [9]


def test_forward_fill_clamps_before_the_first_sample():
    """A grid point before the first source sample carries the first value."""
    t = np.array([0.5, 1.5])
    assert list(forward_fill(np.array([0.0, 0.25]), t, np.array([3, 4]))) == [3, 3]


# --- arc-length reparameterization ------------------------------------------------
#
# Positions are placed by TRAVELLED DISTANCE, not by time: the position channel's
# shape is trustworthy and its timestamps are not. Everything below works on paths
# with a closed-form answer, so the assertions are exact values rather than
# descriptions of whatever the code happens to do.


def test_cumulative_arclength_measures_a_known_polyline():
    """A 3-4 leg and a 3 back: 0, 3, 7, 10."""
    s = cumulative_arclength([0.0, 3.0, 3.0, 0.0], [0.0, 0.0, 4.0, 4.0])
    assert list(s) == [0.0, 3.0, 7.0, 10.0]


def test_cumulative_arclength_starts_at_zero_and_never_decreases():
    """It is used as `xp` for an interpolation, which requires exactly this."""
    s = cumulative_arclength([0.0, 1.0, 1.0, -5.0], [0.0, 0.0, 0.0, 2.0])
    assert s[0] == 0.0
    assert all(b >= a for a, b in zip(s, s[1:]))


def test_cumulative_travel_of_a_constant_speed_is_a_linear_ramp():
    d = cumulative_travel([0.0, 1.0, 2.0, 3.0], [10.0, 10.0, 10.0, 10.0])
    assert list(d) == [0.0, 10.0, 20.0, 30.0]


def test_cumulative_travel_is_exact_under_constant_acceleration():
    """
    The trapezoid rule is EXACT on a linear integrand, so `v = a*t` integrates to
    `a*t^2/2` with no error to hide behind a tolerance. With a = 2 that is t^2.
    """
    t = np.array([0.0, 1.0, 2.0, 3.0])
    d = cumulative_travel(t, 2.0 * t)
    assert list(d) == list(t**2)


def test_positions_are_evenly_spaced_at_constant_speed_on_a_straight():
    """The defining case: equal time steps at one speed must cover equal ground."""
    t = np.array([0.0, 1.0, 2.0])
    x = np.array([0.0, 50.0, 100.0])
    y = np.zeros(3)
    grid = uniform_grid(2.0, 10)

    gx, gy = resample_positions_by_travel(grid, t, x, y, np.full(3, 40.0))

    assert gx == pytest.approx(np.arange(21) * 5.0)
    assert gy == pytest.approx(np.zeros(21))


def test_a_jittered_position_clock_no_longer_moves_the_car_unevenly():
    """
    THE BUG, pinned. The recorded positions here are correct in SHAPE and wrong in
    TIMING — the middle fix is timestamped as if the car had covered a tenth of the
    straight in half the lap, which is what an independent ~4 Hz position channel
    looks like. Time interpolation faithfully reproduces the lie and the car crawls
    then leaps; travelled distance ignores the position clock entirely and reads the
    truthful, constant speed channel instead.
    """
    t = np.array([0.0, 1.0, 2.0])
    x = np.array([0.0, 10.0, 100.0])
    y = np.zeros(3)
    grid = uniform_grid(2.0, 10)

    gx, _ = resample_positions_by_travel(grid, t, x, y, np.full(3, 40.0))
    steps = np.diff(gx)
    assert steps == pytest.approx(np.full(20, 5.0))

    # The negative control: what the pipeline used to emit from the same frame.
    old = np.diff(interp_continuous(grid, t, x))
    assert old.max() / old.min() == pytest.approx(9.0)


def test_positions_follow_a_known_acceleration_profile():
    """
    `v = a*t` on a straight line puts sample k at `(t_k/T)^2` of the way along, and
    the recorded vertices are deliberately spaced EVENLY — proof that the emitted
    position comes from the speed integral and not from where the fixes happen to sit.
    """
    t = np.arange(21) / 10.0
    x = np.linspace(0.0, 100.0, 21)
    grid = uniform_grid(2.0, 10)

    gx, _ = resample_positions_by_travel(grid, t, x, np.zeros(21), 5.0 * t)

    assert gx == pytest.approx(100.0 * (t / 2.0) ** 2)


def test_positions_do_not_depend_on_the_unit_speed_is_measured_in():
    """
    The whole reason progress is normalised onto path length rather than carried
    across as a metric distance. FastF1's X/Y are in 1/10 m and Speed in km/h, both
    undocumented; scaling one must not be able to move the car.
    """
    t = np.arange(11) / 10.0
    x = np.linspace(0.0, 300.0, 11)
    y = np.linspace(0.0, 40.0, 11)
    speed = 100.0 + 30.0 * np.sin(t)
    grid = uniform_grid(1.0, 10)

    kmh = resample_positions_by_travel(grid, t, x, y, speed)
    mph = resample_positions_by_travel(grid, t, x, y, speed / 1.609344)

    # Tight on purpose: the unit factor cancels algebraically, so all that should
    # survive is the last-bit noise of dividing and re-multiplying by it.
    assert kmh[0] == pytest.approx(mph[0], rel=1e-12, abs=1e-12)
    assert kmh[1] == pytest.approx(mph[1], rel=1e-12, abs=1e-12)


def test_a_stopped_car_holds_its_position():
    """
    Zero speed over part of the lap is ordinary data (a red flag, a pit box), not a
    degenerate case: the travel integral goes flat, so the car stays put and then
    moves off again. Only an ENTIRELY zero channel is unusable.
    """
    t = np.arange(31) / 10.0
    speed = np.full(31, 10.0)
    speed[11:20] = 0.0  # stationary from t=1.1 to t=1.9 inclusive
    grid = uniform_grid(3.0, 10)

    gx, _ = resample_positions_by_travel(
        grid, t, np.linspace(0.0, 100.0, 31), np.zeros(31), speed
    )

    stopped = gx[11:20]
    assert stopped == pytest.approx(np.full(9, stopped[0]))
    assert gx[10] < stopped[0] < gx[20]


def test_a_repeated_position_fix_changes_nothing():
    """
    A duplicated point is a zero-length segment with no direction of its own. It is
    dropped before the lookup, so the emitted path is identical to the one recorded
    without it — rather than the lookup landing on a zero-width interval.
    """
    grid = uniform_grid(3.0, 10)
    speed = np.full(4, 20.0)
    plain = resample_positions_by_travel(
        grid,
        np.array([0.0, 1.0, 2.0, 3.0]),
        np.array([0.0, 1.0, 2.0, 3.0]),
        np.array([0.0, 0.0, 5.0, 5.0]),
        speed,
    )
    # The same lap, with the fix at (1, 0) reported twice on the same timestamp.
    doubled = resample_positions_by_travel(
        grid,
        np.array([0.0, 1.0, 1.0, 2.0, 3.0]),
        np.array([0.0, 1.0, 1.0, 2.0, 3.0]),
        np.array([0.0, 0.0, 0.0, 5.0, 5.0]),
        np.full(5, 20.0),
    )

    assert np.array_equal(plain[0], doubled[0])
    assert np.array_equal(plain[1], doubled[1])
    assert not np.any(np.isnan(doubled[0]))


def test_a_speed_channel_that_never_leaves_zero_is_rejected():
    """
    Unusable, and quietly falling back to time interpolation would ship exactly the
    bug this module removes. The pipeline's standing rule applies: impossible data
    fails loudly rather than being hidden (compare `clamp_throttle`, which does not
    clamp speed for the same reason).
    """
    grid = uniform_grid(2.0, 10)
    with pytest.raises(TelemetryShapeError, match="integrates to zero"):
        resample_positions_by_travel(
            grid,
            np.array([0.0, 1.0, 2.0]),
            np.array([0.0, 50.0, 100.0]),
            np.zeros(3),
            np.zeros(3),
        )


def test_a_path_that_covers_no_distance_is_rejected():
    grid = uniform_grid(2.0, 10)
    with pytest.raises(TelemetryShapeError, match="covers no distance"):
        resample_positions_by_travel(
            grid,
            np.array([0.0, 1.0, 2.0]),
            np.full(3, 7.0),
            np.full(3, 9.0),
            np.full(3, 200.0),
        )


def test_the_last_sample_lands_at_the_path_end_when_the_grid_covers_the_lap():
    t = np.arange(21) / 10.0
    x = 100.0 * np.cos(t)
    y = 100.0 * np.sin(t)
    gx, gy = resample_positions_by_travel(
        uniform_grid(2.0, 10), t, x, y, 150.0 + 20.0 * t
    )
    assert (gx[0], gy[0]) == pytest.approx((x[0], y[0]))
    assert (gx[-1], gy[-1]) == pytest.approx((x[-1], y[-1]))


def test_the_last_sample_stops_exactly_one_step_short_however_the_lap_divides():
    """
    The app wraps the last sample round to the first across one full grid step, so the
    last sample belongs exactly one step of travel before the line. Through
    `source_times` that holds for ANY lap length; reading at the emitted grid instead
    left it short by only the sub-step remainder, which is what made the car slow at
    the start/finish line. Both laps below are the same 210-unit path at constant
    speed, so one step of travel is 10 units.
    """
    def straight_lap(lap_time: float):
        """A 100-unit/s straight line, sampled to exactly `lap_time`."""
        t = np.append(np.arange(0.0, lap_time - 1e-9, 0.1), lap_time)
        return t, t * 100.0

    # 2.1 divides the grid exactly; 2.05 and 2.01 leave a remainder of most and
    # almost none of a step. Before the fix these three behaved completely
    # differently at the line; the point of the fix is that they no longer do.
    for lap_time in (2.1, 2.05, 2.01):
        t, x = straight_lap(lap_time)
        grid = uniform_grid(lap_time, 10)
        src = source_times(grid, lap_time, 10)
        gx, _ = resample_positions_by_travel(
            src, t, x, np.zeros_like(t), np.full(len(t), 100.0)
        )
        path = float(x[-1])
        step = path / len(grid)
        assert gx[0] == pytest.approx(0.0)
        assert gx[-1] == pytest.approx(path - step)
        assert gx[-1] < path

    # The negative control: reading at the EMITTED grid, the same three laps leave
    # the wrap step anywhere between a full step of ground and none at all.
    for lap_time, expected_wrap in ((2.1, 0.0), (2.05, 5.0), (2.01, 1.0)):
        t, x = straight_lap(lap_time)
        grid = uniform_grid(lap_time, 10)
        gx, _ = resample_positions_by_travel(
            grid, t, x, np.zeros_like(t), np.full(len(t), 100.0)
        )
        assert float(x[-1]) - gx[-1] == pytest.approx(expected_wrap, abs=1e-6)


def _true_position(t: np.ndarray, period: float) -> np.ndarray:
    """Position of a car whose speed is `100 + 50*sin(2*pi*t/period)`, from t=0."""
    w = 2.0 * math.pi / period
    return 100.0 * t + (50.0 / w) * (1.0 - np.cos(w * t))


def _jittered_frame() -> "dict[str, np.ndarray]":
    """
    A straight-line lap sampled the way FastF1 delivers one: position and speed are
    independent channels, so the position fixes carry a timing error the speed
    channel does not share. No RNG — the jitter is a closed-form function of the
    index, because `test_golden.py` needs this module to be deterministic.
    """
    t = np.arange(0.0, 8.0001, 0.25)
    jitter = 0.09 * np.sin(4.0 * np.arange(len(t)))
    return {
        "t": t,
        # Recorded WHERE the car was at `t + jitter`, but labelled `t`.
        "x": _true_position(t + jitter, 8.0),
        "y": np.zeros(len(t)),
        "speed": 100.0 + 50.0 * np.sin(2.0 * math.pi * t / 8.0),
    }


def _implied_vs_actual(gx, gy, speed_on_grid, rate) -> "tuple[float, float]":
    """
    Single-step implied velocity against the speed channel: (correlation, the sd of
    the implied/actual ratio). The same two numbers PLAN.md §Slice 6b measures on the
    real lap, so the unit test and the acceptance check are the same metric.
    """
    implied = np.hypot(np.diff(gx), np.diff(gy)) * rate
    actual = 0.5 * (speed_on_grid[:-1] + speed_on_grid[1:])
    return float(np.corrcoef(implied, actual)[0, 1]), float((implied / actual).std())


def test_single_step_motion_agrees_with_the_speed_channel():
    """
    The slice's acceptance bar, at unit scale: implied velocity over ONE grid step —
    no smoothing window — must correlate with the speed channel at r > 0.97. The
    negative control is the same frame through the old time interpolation, which is
    where the surging came from.
    """
    frame = _jittered_frame()
    grid = uniform_grid(float(frame["t"][-1]), SAMPLE_RATE_HZ)
    speed_on_grid = interp_continuous(grid, frame["t"], frame["speed"])

    gx, gy = resample_positions_by_travel(
        grid, frame["t"], frame["x"], frame["y"], frame["speed"]
    )
    fixed_r, fixed_sd = _implied_vs_actual(gx, gy, speed_on_grid, SAMPLE_RATE_HZ)

    old_x = interp_continuous(grid, frame["t"], frame["x"])
    old_r, old_sd = _implied_vs_actual(
        old_x, np.zeros_like(old_x), speed_on_grid, SAMPLE_RATE_HZ
    )

    assert fixed_r > 0.97
    assert fixed_sd < 0.05
    assert old_r < 0.70
    assert old_sd > 0.25


def _project_onto_polyline(px, py, xs, ys) -> "tuple[float, float]":
    """
    Project one point onto a polyline: (distance to it, arc length at the foot).

    Deliberately a brute-force scan of every segment, unrelated to the production
    lookup — a test that reimplemented the transform's own indexing would agree with
    it by construction and prove nothing.
    """
    xs = np.asarray(xs, dtype=float)
    ys = np.asarray(ys, dtype=float)
    ax, ay = xs[:-1], ys[:-1]
    dx, dy = np.diff(xs), np.diff(ys)
    length_sq = dx**2 + dy**2
    safe = np.where(length_sq > 0.0, length_sq, 1.0)
    f = np.where(
        length_sq > 0.0,
        np.clip(((px - ax) * dx + (py - ay) * dy) / safe, 0.0, 1.0),
        0.0,
    )
    dist = np.hypot(px - (ax + f * dx), py - (ay + f * dy))
    j = int(np.argmin(dist))
    return float(dist[j]), float(
        cumulative_arclength(xs, ys)[j] + f[j] * math.sqrt(length_sq[j])
    )


def test_every_emitted_point_lies_on_the_recorded_path():
    """
    Reparameterisation moves samples ALONG the path; it must not move them off it.
    The ribbon, the trail and the corner geometry all depend on this — the circuit
    the app draws is still the circuit the position channel recorded.
    """
    channels = synthetic.telemetry()
    samples = build_replay_dict(channels, synthetic.META)["cars"][0]["samples"]

    for sample in samples:
        distance, _ = _project_onto_polyline(
            sample["x"], sample["y"], channels["X"], channels["Y"]
        )
        # The tolerance is the schema's own 1 dp rounding on x/y, not slack.
        assert distance < 0.15


def test_emitted_samples_advance_monotonically_along_the_path():
    """The car never reverses: travelled distance never decreases, so nor does arc."""
    channels = synthetic.telemetry()
    samples = build_replay_dict(channels, synthetic.META)["cars"][0]["samples"]

    arcs = [
        _project_onto_polyline(s["x"], s["y"], channels["X"], channels["Y"])[1]
        for s in samples
    ]
    total = cumulative_arclength(channels["X"], channels["Y"])[-1]
    assert total > 0.0
    assert all(b >= a - 0.01 for a, b in zip(arcs, arcs[1:]))
    # Every sample lies strictly inside the path: the last one is a step short of the
    # end, which is the room the app's wrap step needs. Before the fix it landed ON
    # the end (this lap divides the grid exactly), so the wrap covered no ground.
    assert 0.0 <= arcs[-1] < total


def _loop_frame(shortfall: float = 0.01, duration_s: float = 3.0, rows: int = 64):
    """
    A circular lap at constant speed whose telemetry stops `shortfall` of a turn short
    of closing — the shape of a real lap, whose recorded fixes end a metre or two
    before the fix they started from. Constant speed makes every step the same length,
    so the wrap step has an exact expectation rather than a tolerance band.
    """
    span = 2.0 * math.pi * (1.0 - shortfall)
    angle = np.linspace(0.0, span, rows)
    radius = 500.0
    return {
        "Time": np.linspace(0.0, duration_s, rows),
        "X": radius * np.cos(angle),
        "Y": radius * np.sin(angle),
        "Speed": np.full(rows, 100.0),
        "Throttle": np.full(rows, 50.0),
        "Brake": np.zeros(rows, dtype=int),
        "nGear": np.full(rows, 6, dtype=int),
    }


def test_closing_time_is_zero_for_a_lap_that_already_closes():
    """The synthetic oval ends on the fix it started from, so there is nothing to add."""
    channels = synthetic.telemetry()
    assert closing_time(
        channels["Time"], channels["X"], channels["Y"], channels["Speed"]
    ) == pytest.approx(0.0, abs=1e-9)


def test_closing_time_measures_the_gap_the_telemetry_leaves():
    """
    A hundredth of a turn missing from a 3 s lap is a hundredth of a lap of travel, so
    at constant speed it is 30 ms of driving. Real laps leave a comparable slice —
    Monza's worst is 24 ms of 79.5 s — and the arithmetic is the same one.
    """
    frame = _loop_frame(shortfall=0.01)
    seconds = closing_time(frame["Time"], frame["X"], frame["Y"], frame["Speed"])
    assert seconds == pytest.approx(0.03, rel=0.01)


def test_closing_time_is_negative_when_the_telemetry_runs_past_the_line():
    """
    Signed along the direction of travel: a lap cut slightly LATE has already covered
    the ground the wrap step would otherwise be given, so it shortens the lap. Both
    real laps measured stop short, but the sign is FastF1's choice, not ours.
    """
    frame = _loop_frame(shortfall=-0.05)
    assert closing_time(frame["Time"], frame["X"], frame["Y"], frame["Speed"]) < 0.0


@pytest.mark.parametrize(
    "channel, value",
    [("Speed", 0.0), ("X", 7.0)],
)
def test_closing_time_returns_zero_for_data_with_nothing_to_close(channel, value):
    """
    A stationary car, or a path that covers no ground, has no closing chord. This
    returns 0.0 rather than raising because `resample_positions_by_travel` is where
    that data gets its named error — two error messages for one fault helps nobody.
    """
    frame = _loop_frame()
    frame[channel] = np.full(len(frame["Time"]), value)
    if channel == "X":
        frame["Y"] = np.full(len(frame["Time"]), value)
    assert closing_time(
        frame["Time"], frame["X"], frame["Y"], frame["Speed"]
    ) == pytest.approx(0.0)


def _chords(samples) -> "list[float]":
    """Ground covered per grid step, with the WRAP step (last -> first) appended."""
    points = [(s["x"], s["y"]) for s in samples]
    steps = [
        math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:])
    ]
    steps.append(math.hypot(points[0][0] - points[-1][0], points[0][1] - points[-1][1]))
    return steps


def test_the_wrap_step_covers_as_much_ground_as_the_steps_around_it():
    """
    The Slice 7 regression test, and the reason `source_times` exists.

    `meta.duration` is `n / rate`, so the app closes the lap by wrapping the last
    sample round to the first across one full grid step. That step therefore has to
    carry one full step of travel. Before the fix it carried only the sub-step
    remainder of the lap — on this synthetic lap, which divides the 10 Hz grid
    exactly, that remainder is ZERO and the car stood still at the start/finish line
    for a tenth of a second on every lap.
    """
    channels = synthetic.telemetry()
    samples = build_replay_dict(channels, synthetic.META)["cars"][0]["samples"]

    steps = _chords(samples)
    wrap, previous = steps[-1], steps[-2]
    # The synthetic car is accelerating out of the last corner, so the wrap step is
    # legitimately a little longer than the one before it — but the same order, not a
    # different one.
    assert wrap == pytest.approx(previous, rel=0.1)
    assert wrap > 0.5 * max(steps)

    # The negative control: the same lap with every channel read at the EMITTED grid,
    # which is what the pipeline did before this slice.
    lap_time = float(channels["Time"][-1])
    grid = uniform_grid(lap_time, SAMPLE_RATE_HZ)
    ox, oy = resample_positions_by_travel(
        grid, channels["Time"], channels["X"], channels["Y"], channels["Speed"]
    )
    old = _chords([{"x": x, "y": y} for x, y in zip(ox, oy)])
    assert old[-1] == pytest.approx(0.0, abs=0.01)


def test_the_wrap_step_is_right_on_a_lap_whose_telemetry_stops_short():
    """
    The real-data case, and the reason `closing_time` exists. The recorded fixes end
    before the fix they started from, so the wrap step has to carry that shortfall as
    well as its own step of travel. Constant speed on a circle means every step is the
    same length, so the wrap step has an exact target rather than a range.
    """
    frame = _loop_frame(shortfall=0.01)
    samples = build_replay_dict(frame, synthetic.META)["cars"][0]["samples"]
    steps = _chords(samples)
    assert steps[-1] == pytest.approx(steps[-2], rel=0.01)
    assert max(steps) / min(steps) < 1.02

    # The negative control: the same lap with the closing chord ignored, which is what
    # `source_times` alone produced. The wrap step overshoots by the whole shortfall.
    lap_time = float(frame["Time"][-1])
    grid = uniform_grid(lap_time, SAMPLE_RATE_HZ)
    ox, oy = resample_positions_by_travel(
        source_times(grid, lap_time, SAMPLE_RATE_HZ),
        frame["Time"],
        frame["X"],
        frame["Y"],
        frame["Speed"],
    )
    open_steps = _chords([{"x": x, "y": y} for x, y in zip(ox, oy)])
    assert open_steps[-1] > 1.25 * open_steps[-2]


def test_the_first_emitted_sample_is_still_the_start_finish_point():
    """
    Arc zero is the first recorded fix, so sample 0 is unmoved by this change — which
    is what keeps `track.startFinish` (built from sample 0) pointing at the line.
    """
    channels = synthetic.telemetry()
    replay = build_replay_dict(channels, synthetic.META)
    first = replay["cars"][0]["samples"][0]
    assert first["x"] == round(float(channels["X"][0]), 1)
    assert first["y"] == round(float(channels["Y"][0]), 1)
    assert replay["track"]["startFinish"]["x"] == first["x"]


# --- samples ----------------------------------------------------------------------


def _sample_args(n=3, drs=None):
    grid = np.arange(n, dtype=float) / 10
    ramp = np.arange(n, dtype=float)
    return dict(
        grid=grid,
        x=ramp * 1.5,
        y=-ramp,
        speed=200.0 + ramp,
        throttle=np.full(n, 99.6),
        brake=np.zeros(n, dtype=int),
        gear=np.full(n, 7),
        drs=drs,
    )


def test_build_samples_rounds_to_the_schema_s_precision():
    sample = build_samples(**_sample_args(n=2))[1]
    assert sample == {
        "t": 0.1,
        "x": 1.5,
        "y": -1.0,
        "speed": 201,
        "throttle": 100,
        "gear": 7,
        "brake": 0,
    }


def test_build_samples_omits_drs_when_the_channel_is_absent():
    for sample in build_samples(**_sample_args(drs=None)):
        assert "drs" not in sample


def test_build_samples_omits_drs_when_the_channel_is_all_zero():
    """What a 2026+ session looks like: DRS removed, no published replacement."""
    for sample in build_samples(**_sample_args(drs=np.zeros(3, dtype=int))):
        assert "drs" not in sample


def test_build_samples_emits_drs_on_every_sample_when_any_is_nonzero():
    """
    All-or-nothing. The schema rejects a partially-present channel, because that
    would otherwise silently disable the HUD indicator instead of failing loudly.
    """
    samples = build_samples(**_sample_args(drs=np.array([0, 12, 0])))
    assert [s["drs"] for s in samples] == [0, 12, 0]


def test_build_samples_emits_the_raw_drs_code_not_a_decoded_flag():
    """`app/src/engine/drs.ts` owns the undocumented 10/12/14 mapping — not this."""
    samples = build_samples(**_sample_args(drs=np.array([8, 12, 14])))
    assert [s["drs"] for s in samples] == [8, 12, 14]


# --- corners ----------------------------------------------------------------------


def test_build_corners_maps_fastf1_rows_onto_the_schema_shape():
    corners = build_corners(synthetic.CORNERS)
    assert corners[0] == {"number": 1, "letter": "", "x": 620.0, "y": 140.0}
    assert corners[1]["letter"] == "A"


@pytest.mark.parametrize("letter", [None, float("nan")])
def test_build_corners_treats_a_missing_letter_as_empty(letter):
    """FastF1 leaves it NaN or None; `str(nan)` would put "nan" on the badge."""
    corners = build_corners([{"Number": 4, "Letter": letter, "X": 1.0, "Y": 2.0}])
    assert corners[0]["letter"] == ""


# --- the whole replay -------------------------------------------------------------


def test_build_replay_dict_conforms_to_the_schema_s_meta_contract():
    replay = build_replay_dict(
        synthetic.telemetry(), synthetic.META, corners=synthetic.CORNERS
    )
    meta = replay["meta"]
    assert meta["schemaVersion"] == SCHEMA_VERSION
    assert meta["units"] == {"speed": SPEED_UNIT}
    assert meta["sampleRateHz"] == SAMPLE_RATE_HZ
    assert meta["year"] == 2024
    assert meta["rotation"] == -14.0


def test_build_replay_dict_puts_samples_on_the_uniform_grid():
    """
    The app's O(1) lookup is `index = clock * sampleRateHz` and never reads `t`, so
    an off-grid sample would silently misplace the car. The schema guards this with
    a 2 ms tolerance; the pipeline lands exactly.
    """
    replay = build_replay_dict(synthetic.telemetry(), synthetic.META)
    rate = replay["meta"]["sampleRateHz"]
    samples = replay["cars"][0]["samples"]
    for k, sample in enumerate(samples):
        assert sample["t"] == round(k / rate, 3)


def test_build_replay_dict_span_agrees_with_meta_duration():
    replay = build_replay_dict(synthetic.telemetry(), synthetic.META)
    meta = replay["meta"]
    samples = replay["cars"][0]["samples"]
    assert round(meta["duration"] * meta["sampleRateHz"]) == len(samples)


def test_build_replay_dict_emits_strictly_increasing_t():
    samples = build_replay_dict(synthetic.telemetry(), synthetic.META)["cars"][0][
        "samples"
    ]
    times = [s["t"] for s in samples]
    assert all(b > a for a, b in zip(times, times[1:]))


def test_build_replay_dict_clamps_throttle_into_range():
    """The synthetic frames overshoot 100 on purpose — real FastF1 does too."""
    assert max(synthetic.telemetry()["Throttle"]) > 100
    samples = build_replay_dict(synthetic.telemetry(), synthetic.META)["cars"][0][
        "samples"
    ]
    assert max(s["throttle"] for s in samples) == 100
    assert min(s["throttle"] for s in samples) >= 0


def test_build_replay_dict_keeps_brake_and_gear_in_the_schema_s_domain():
    samples = build_replay_dict(synthetic.telemetry(), synthetic.META)["cars"][0][
        "samples"
    ]
    assert {s["brake"] for s in samples} <= {0, 1}
    assert all(0 <= s["gear"] <= 8 for s in samples)


def test_build_replay_dict_computes_the_start_finish_angle_in_radians():
    """
    It used to emit a hard-coded 0.0, which draws the start/finish line across the
    track at the wrong angle without failing anything.
    """
    channels = synthetic.telemetry()
    replay = build_replay_dict(channels, synthetic.META)
    samples = replay["cars"][0]["samples"]
    expected = math.atan2(
        samples[1]["y"] - samples[0]["y"], samples[1]["x"] - samples[0]["x"]
    )
    angle = replay["track"]["startFinish"]["angle"]
    assert angle == pytest.approx(expected, abs=1e-3)
    assert angle != 0.0
    assert replay["track"]["startFinish"]["x"] == samples[0]["x"]
    assert replay["track"]["startFinish"]["y"] == samples[0]["y"]


def test_build_replay_dict_always_emits_cars_as_an_array():
    """CLAUDE.md rule 2: nothing on either side of the contract branches on count."""
    replay = build_replay_dict(synthetic.telemetry(), synthetic.META)
    assert isinstance(replay["cars"], list)
    assert len(replay["cars"]) == 1
    assert replay["cars"][0]["driver"] == "SYN"
    assert replay["cars"][0]["color"] == "#3671C6"


def test_build_replay_dict_omits_drs_for_a_season_without_it():
    replay = build_replay_dict(synthetic.telemetry(drs=False), synthetic.META_NO_DRS)
    assert all("drs" not in s for s in replay["cars"][0]["samples"])


def test_build_replay_dict_carries_drs_when_the_season_has_it():
    replay = build_replay_dict(synthetic.telemetry(drs=True), synthetic.META)
    samples = replay["cars"][0]["samples"]
    assert all("drs" in s for s in samples)
    assert any(s["drs"] != 0 for s in samples)


def test_build_replay_dict_rejects_a_frame_missing_a_core_channel():
    channels = synthetic.telemetry()
    del channels["Speed"]
    with pytest.raises(MissingColumnsError):
        build_replay_dict(channels, synthetic.META)


def test_build_replay_dict_rejects_a_frame_too_short_to_interpolate():
    channels = {name: values[:1] for name, values in synthetic.telemetry().items()}
    with pytest.raises(TelemetryShapeError, match="at least 2 rows"):
        build_replay_dict(channels, synthetic.META)


def test_build_replay_dict_rejects_time_that_goes_backwards():
    """`np.interp` gives silently wrong answers on a non-increasing xp."""
    channels = synthetic.telemetry()
    channels["Time"] = channels["Time"][::-1].copy()
    with pytest.raises(TelemetryShapeError, match="non-decreasing"):
        build_replay_dict(channels, synthetic.META)


def test_build_replay_dict_zero_bases_time_within_the_lap():
    channels = synthetic.telemetry()
    channels["Time"] = channels["Time"] + 1234.5
    samples = build_replay_dict(channels, synthetic.META)["cars"][0]["samples"]
    assert samples[0]["t"] == 0.0


# --- serialisation ----------------------------------------------------------------


def test_dump_json_is_canonical_and_round_trips():
    replay = build_replay_dict(synthetic.telemetry(), synthetic.META)
    text = dump_json(replay)
    assert text.endswith("\n")
    assert json.loads(text) == replay
    # Sorted keys and an indent are what make a regenerated golden reviewable.
    assert text.startswith("{\n  ")
    assert text.index('"cars"') < text.index('"meta"') < text.index('"track"')
