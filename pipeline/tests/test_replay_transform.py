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

import dataclasses
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
    color_lookup_warning,
    cumulative_arclength,
    cumulative_travel,
    dump_json,
    forward_fill,
    interp_continuous,
    normalise_brake,
    normalise_color,
    parse_lap_range,
    resample_positions_by_travel,
    source_times,
    time_base_stretch,
    uniform_grid,
    LOOP_CLOSED,
    LOOP_OPEN,
    KMH_S_PER_METRE,
    PARKED_TRAVEL_M,
    build_window_replay_dict,
    covers_ground,
    has_drs,
    hold_positions,
    resample_channels,
    motion_fidelity,
    window_car_report,
    window_grid,
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


def test_default_color_cannot_be_mistaken_for_a_livery():
    """
    The fallback must read as "no data", never as a plausible team colour.

    A regression test, not a description. `DEFAULT_COLOR` was `#3671C6` — the hex
    widely published as Red Bull's — so a failed lookup rendered as a plausible Red
    Bull lap, which is exactly how the always-failing `fastf1.plotting` lookup
    survived a whole slice unnoticed. The invariant is ACHROMATIC: every F1 livery is
    a saturated hue, so r == g == b is the property that makes the value unmistakable,
    and the literal is pinned alongside it so a "neutral-ish" brand hex cannot slip in
    under a passing equality.
    """
    assert DEFAULT_COLOR == "#888888"
    r, g, b = (int(DEFAULT_COLOR[i : i + 2], 16) for i in (1, 3, 5))
    assert r == g == b


@pytest.mark.parametrize(
    "value,expected",
    [
        # Valid input is passed THROUGH. These four are only meaningful because they
        # differ from `DEFAULT_COLOR`: while the fallback was itself `#3671C6`, a
        # pass-through and a fallback were indistinguishable here.
        ("#3671C6", "#3671C6"),
        ("#abc", "#abc"),
        ("3671C6", "#3671C6"),  # FastF1 has returned bare hex
        ("  #3671C6  ", "#3671C6"),
        # Everything the schema's hex regex would reject falls back instead.
        ("rebeccapurple", DEFAULT_COLOR),
        ("#12345", DEFAULT_COLOR),
        ("", DEFAULT_COLOR),
        (None, DEFAULT_COLOR),
        # An int, so → fallback. This row is the one that changed meaning: with the
        # old fallback it passed both if the fallback fired AND if `normalise_color`
        # had coerced the int to that same hex string. It now discriminates.
        (0x3671C6, DEFAULT_COLOR),
    ],
)
def test_normalise_color(value, expected):
    assert normalise_color(value) == expected


def test_color_lookup_warning_says_who_failed_and_what_went_wrong():
    """
    Loud, not fatal — and actionable, which needs three things in the line.

    The driver, because in a multi-car build it is what says whether one seat or the
    whole field went grey; the exception TYPE, because `AttributeError` (FastF1 moved
    its API) and `KeyError` (the team is not in the colour map) are different fixes;
    and the `WARNING:` marker, because this prints into the middle of FastF1's own
    INFO log, where an unadorned line is invisible.
    """
    line = color_lookup_warning("LEC", KeyError("Ferrari"))

    assert "WARNING" in line
    assert "LEC" in line
    assert "KeyError" in line
    assert "Ferrari" in line
    assert DEFAULT_COLOR in line


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
    # A genuine PASS-THROUGH assertion: `synthetic.META` supplies this explicitly and
    # it is not `DEFAULT_COLOR`, so a fallback here would fail the equality.
    assert replay["cars"][0]["color"] == "#3671C6"


def test_build_replay_dict_emits_the_neutral_when_the_colour_lookup_failed():
    """
    What a failed lookup looks like in the FILE, end to end.

    `build_replay.py`'s `except` hands back an empty team and colour, and the
    resolution happens in exactly one place — `normalise_color` — so this is the whole
    of the fallback path as an emitted replay. Asserting the neutral rather than
    merely "it did not crash" is the point of the slice: the old value made a failed
    lookup indistinguishable from a Red Bull lap.
    """
    meta = dataclasses.replace(synthetic.META, team="", color="")
    replay = build_replay_dict(synthetic.telemetry(), meta)

    assert replay["cars"][0]["color"] == "#888888"
    assert replay["cars"][0]["color"] != "#3671C6"


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


# --- covers_ground: parked vs corrupt, and the unit argument ----------------------
#
# The predicate that separates "a car sat in its pit box" (ordinary data in a window)
# from "this lap covers no ground" (impossible data). Its threshold lives on the
# SPEED channel because that unit is pinned by the schema; the position channel's
# unit is FastF1's undocumented 1/10 m and is never assumed. These tests pin both
# halves of that argument.


def _straight_line(travel_m: float, *, n: int = 8, rate: float = 4.0):
    """
    Telemetry for a car creeping `travel_m` metres in a straight line.

    Speed is derived so the travel integral lands exactly on the requested distance:
    `sum(v*dt)` is km/h*s, and one metre is `KMH_S_PER_METRE` of them.
    """
    t = np.arange(n, dtype=float) / rate
    duration = t[-1]
    speed = np.full(n, travel_m * KMH_S_PER_METRE / duration)
    # Position units are arbitrary on purpose — the predicate must not read a scale
    # out of them.
    x = np.linspace(0.0, 137.0, n)
    return t, x, np.zeros(n), speed


def test_covers_ground_calls_one_car_length_of_creep_moving():
    # Exactly at the bound, which is inclusive: a car that has moved its own length
    # has moved.
    t, x, y, speed = _straight_line(PARKED_TRAVEL_M)
    assert cumulative_travel(t, speed)[-1] == pytest.approx(
        PARKED_TRAVEL_M * KMH_S_PER_METRE
    )
    assert covers_ground(t, x, y, speed) is True


def test_covers_ground_calls_just_under_a_car_length_parked():
    t, x, y, speed = _straight_line(PARKED_TRAVEL_M - 0.1)
    assert covers_ground(t, x, y, speed) is False


def test_covers_ground_calls_pure_gps_jitter_parked():
    """
    The case the predicate exists for. The speed channel reads a flat zero while the
    position fixes wander, so the PATH is long and the TRAVEL is nil. A predicate
    that tested only the path — the obvious one — would call this car moving and
    then smear its jitter along an imaginary racing line.
    """
    tel = synthetic.parked_telemetry(100.0, 130.0)
    path = cumulative_arclength(tel["X"], tel["Y"])[-1]
    assert path > 100.0, "the jitter must be big enough to fool a path-only test"
    assert covers_ground(tel["Time"], tel["X"], tel["Y"], tel["Speed"]) is False


def test_covers_ground_calls_identical_fixes_parked_even_at_speed():
    """A degenerate path fails dimensionlessly — no threshold, no unit."""
    t = np.arange(6, dtype=float)
    x = np.full(6, 42.0)
    speed = np.full(6, 300.0)
    assert covers_ground(t, x, x, speed) is False


@pytest.mark.parametrize("scale", [0.1, 1.0, 10.0, 1000.0])
def test_covers_ground_answer_does_not_depend_on_position_units(scale):
    """
    The executable form of "no position-unit assumption". FastF1's X/Y convention is
    undocumented 1/10 m; if the threshold had been written in position units instead,
    rescaling here would flip the answer and every one of these would disagree.
    """
    moving = _straight_line(PARKED_TRAVEL_M * 4)
    parked = _straight_line(PARKED_TRAVEL_M / 4)
    for tel, expected in ((moving, True), (parked, False)):
        t, x, y, speed = tel
        assert covers_ground(t, x * scale, y * scale, speed) is expected


def test_hold_positions_forward_fills_rather_than_interpolating():
    """
    A parked car's positions are held, not lerped. Interpolating between two fixes
    that differ only by noise would animate a stationary car.
    """
    t = np.array([0.0, 1.0, 2.0])
    x = np.array([10.0, 20.0, 30.0])
    y = np.array([-1.0, -2.0, -3.0])
    gx, gy = hold_positions(np.array([0.0, 0.5, 1.0, 1.9]), t, x, y)
    assert list(gx) == [10.0, 10.0, 20.0, 20.0]
    assert list(gy) == [-1.0, -1.0, -2.0, -2.0]


# --- window_grid ------------------------------------------------------------------


def test_window_grid_emits_k_over_rate_and_reads_from_the_session_axis():
    grid, src = window_grid(synthetic.SESSION_T0, synthetic.SESSION_T0 + 3.0, 10)
    assert grid[0] == 0.0
    assert grid[1] == pytest.approx(0.1)
    # The source instants keep the session's own origin — that is the alignment.
    assert src[0] == pytest.approx(synthetic.SESSION_T0)
    assert src[-1] == pytest.approx(synthetic.SESSION_T0 + grid[-1])


def test_window_grid_applies_no_time_base_stretch():
    """
    `source_times` stretches a LAP onto the grid so the app's cyclic wrap step gets a
    full step of travel. A window is open — the app holds its last sample — so there
    is no wrap step to feed and the source spacing is exactly the grid spacing.
    """
    _, src = window_grid(500.0, 530.0, 10)
    steps = np.diff(src)
    assert np.allclose(steps, 0.1)


def test_window_grid_duration_exceeds_the_window_by_less_than_one_step():
    # The surplus is the holding step at the end, not missing data.
    grid, _ = window_grid(0.0, 3.04, 10)
    duration = len(grid) / 10
    assert 3.04 < duration <= 3.04 + 0.1


def test_window_grid_rejects_a_window_that_does_not_run_forwards():
    for t0, t1 in ((10.0, 10.0), (10.0, 9.0)):
        with pytest.raises(TelemetryShapeError, match="must run forwards"):
            window_grid(t0, t1)


def test_window_grid_rejects_a_window_too_short_to_interpolate_across():
    with pytest.raises(TelemetryShapeError, match="at least 2"):
        window_grid(0.0, 0.05, 10)


# --- build_window_replay_dict: the v2 shape ---------------------------------------


WINDOW_END = synthetic.SESSION_T0 + 12.0
WINDOW = (synthetic.SESSION_T0, WINDOW_END)


def _two_car_window(**kwargs):
    """Two cars a known interval apart on the same circle, over the same window."""
    lead = synthetic.window_car(
        "AAA", synthetic.session_telemetry(*WINDOW, offset_s=0.0, **kwargs)
    )
    chase = synthetic.window_car(
        "BBB", synthetic.session_telemetry(*WINDOW, offset_s=2.0, **kwargs)
    )
    return [lead, chase]


def test_window_puts_every_car_on_one_shared_grid():
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)

    rate = replay["meta"]["sampleRateHz"]
    n = round(replay["meta"]["duration"] * rate)
    assert len(replay["cars"]) == 2
    for car in replay["cars"]:
        assert len(car["samples"]) == n
        assert [s["t"] for s in car["samples"]] == [
            round(k / rate, 3) for k in range(n)
        ]


def test_window_greys_only_the_car_whose_colour_lookup_failed():
    """
    A per-car failure stays per-car, and it is visible next to cars that resolved.

    `_team_and_color` fails one driver at a time, so the multi-car form of the check
    is a file in which one car is obviously undecorated while its neighbours keep
    their liveries — the shape a human would see on the canvas. It is also what makes
    the neutral do its job: grey only reads as "no data" when there is a real colour
    beside it to be compared against.
    """
    lead, chase = _two_car_window()
    blanked = dataclasses.replace(chase, team="", color="")
    replay = build_window_replay_dict(
        [lead, blanked], synthetic.SESSION_META, WINDOW
    )

    assert replay["cars"][0]["color"] == synthetic.TEAMS["AAA"][1]
    assert replay["cars"][1]["color"] == "#888888"


def test_window_sample_k_is_the_same_instant_for_every_car():
    """
    CLAUDE.md rule 5, stated as an equality rather than a hope: the cars are aligned
    on SESSION time, so index k means one moment across the whole file.
    """
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    a, b = (c["samples"] for c in replay["cars"])
    for k in (0, 17, len(a) - 1):
        assert a[k]["t"] == b[k]["t"]


def test_window_preserves_the_interval_between_two_cars():
    """
    The closed-form check. Car BBB is car AAA shifted 2 s along the track, so at any
    grid index BBB must sit where AAA was 2 s (= 20 grid steps) earlier. If anything
    rebased a car's clock, this is what breaks.
    """
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    lead, chase = (c["samples"] for c in replay["cars"])
    offset_steps = int(2.0 * replay["meta"]["sampleRateHz"])

    for k in range(offset_steps, len(lead)):
        assert chase[k]["x"] == pytest.approx(lead[k - offset_steps]["x"], abs=0.5)
        assert chase[k]["y"] == pytest.approx(lead[k - offset_steps]["y"], abs=0.5)


def test_window_positions_match_the_closed_form():
    """Each car's emitted path is the circle it was generated from, not merely
    self-consistent with another run of the same code."""
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    rate = replay["meta"]["sampleRateHz"]
    samples = replay["cars"][0]["samples"]

    for k in (0, 5, 33, len(samples) - 1):
        want_x, want_y = synthetic.session_position(
            synthetic.SESSION_T0 + k / rate, 0.0
        )
        # Tolerance is the chordal sagitta of the source polyline, not slack.
        assert samples[k]["x"] == pytest.approx(float(want_x), abs=1.0)
        assert samples[k]["y"] == pytest.approx(float(want_y), abs=1.0)


def test_window_never_rebases_a_cars_time_axis():
    """
    The single most important line in the v2 shape. `build_replay_dict` does
    `t = t - t[0]` because a LAP starts at zero; doing that per car here would put
    every driver at the start of their own data and destroy the alignment.

    Two cars whose telemetry STARTS at different session times must still line up.
    """
    early = synthetic.window_car(
        "AAA", synthetic.session_telemetry(synthetic.SESSION_T0 - 5.0, WINDOW_END)
    )
    late = synthetic.window_car(
        "BBB", synthetic.session_telemetry(synthetic.SESSION_T0 + 3.0, WINDOW_END)
    )
    replay = build_window_replay_dict([early, late], synthetic.SESSION_META, WINDOW)
    a, b = (c["samples"] for c in replay["cars"])

    # Same generator, same offset: once BOTH cars have data, they are in the same
    # place. A rebase would put B a fixed distance behind A forever.
    settled = int(4.0 * replay["meta"]["sampleRateHz"])
    for k in range(settled, len(a)):
        assert b[k]["x"] == pytest.approx(a[k]["x"], abs=1.0)
        assert b[k]["y"] == pytest.approx(a[k]["y"], abs=1.0)


def test_window_holds_a_car_whose_data_starts_late_rather_than_extrapolating():
    late = synthetic.window_car(
        "BBB", synthetic.session_telemetry(synthetic.SESSION_T0 + 3.0, WINDOW_END)
    )
    replay = build_window_replay_dict(
        [synthetic.window_car("AAA", synthetic.session_telemetry(*WINDOW)), late],
        synthetic.SESSION_META,
        WINDOW,
    )
    samples = replay["cars"][1]["samples"]
    first_real = int(3.0 * replay["meta"]["sampleRateHz"])
    held = {(s["x"], s["y"]) for s in samples[:first_real]}
    assert len(held) == 1, "the car should sit at its first fix, not fly in from off-map"


def test_window_holds_a_retired_car_at_its_last_known_place():
    """
    A car that stops mid-window needs no special case: the travel integral goes flat,
    so the arc position stops advancing and the car parks where it stopped. This is
    6b's partially-zero-speed case, and it is the ordinary way a race ends for
    somebody.
    """
    retired = synthetic.window_car(
        "BBB",
        synthetic.session_telemetry(*WINDOW, stopped_from=synthetic.SESSION_T0 + 6.0),
    )
    replay = build_window_replay_dict(
        [synthetic.window_car("AAA", synthetic.session_telemetry(*WINDOW)), retired],
        synthetic.SESSION_META,
        WINDOW,
    )
    samples = replay["cars"][1]["samples"]
    rate = replay["meta"]["sampleRateHz"]
    after = samples[int(8.0 * rate) :]

    assert len({(s["x"], s["y"]) for s in after}) == 1
    assert all(s["speed"] == 0 for s in after)
    # and the car that kept going did not stop with it.
    assert len({(s["x"], s["y"]) for s in replay["cars"][0]["samples"]}) > 10


def test_window_tolerates_cars_at_different_source_rates():
    """Unequal data quality is what a real session serves; the shared grid is the
    point at which that stops mattering."""
    coarse = synthetic.window_car(
        "BBB", synthetic.session_telemetry(*WINDOW, rate=3.0)
    )
    replay = build_window_replay_dict(
        [synthetic.window_car("AAA", synthetic.session_telemetry(*WINDOW, rate=11.0)),
         coarse],
        synthetic.SESSION_META,
        WINDOW,
    )
    a, b = replay["cars"]
    assert len(a["samples"]) == len(b["samples"])


def test_window_emits_a_parked_car_without_raising():
    """
    A stationary car is CORRUPT data for a lap and ORDINARY data for a window. Same
    condition, different meaning — which is the whole reason `covers_ground` exists.
    """
    replay = build_window_replay_dict(
        [
            synthetic.window_car("AAA", synthetic.session_telemetry(*WINDOW)),
            synthetic.window_car("BBB", synthetic.parked_telemetry(*WINDOW)),
        ],
        synthetic.SESSION_META,
        WINDOW,
    )
    parked = replay["cars"][1]["samples"]
    assert all(s["speed"] == 0 for s in parked)
    # Held to its recorded fixes: a handful of distinct jitter points, never a lap.
    span_x = max(s["x"] for s in parked) - min(s["x"] for s in parked)
    assert span_x < 100.0


def test_the_lap_builder_still_raises_on_the_very_same_stationary_car():
    """The mirror of the test above, and the reason both behaviours can coexist."""
    parked = synthetic.parked_telemetry(0.0, 12.0)
    parked["Time"] = parked["Time"] - parked["Time"][0]
    with pytest.raises(TelemetryShapeError, match="integrates to zero distance"):
        build_replay_dict(parked, synthetic.META)


def test_window_marks_the_replay_open_and_a_lap_closed():
    window = build_window_replay_dict(
        _two_car_window(), synthetic.SESSION_META, WINDOW
    )
    assert window["meta"]["loop"] == LOOP_OPEN
    assert build_replay_dict(synthetic.telemetry(), synthetic.META)["meta"]["loop"] == (
        LOOP_CLOSED
    )


def test_window_takes_start_finish_from_the_reference_car():
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    first = replay["cars"][0]["samples"][0]
    assert replay["track"]["startFinish"]["x"] == first["x"]
    assert replay["track"]["startFinish"]["y"] == first["y"]


def test_window_rejects_an_empty_car_list():
    with pytest.raises(TelemetryShapeError, match="at least one car"):
        build_window_replay_dict([], synthetic.SESSION_META, WINDOW)


def test_window_rejects_a_car_missing_a_required_channel():
    cars = _two_car_window()
    del cars[1].telemetry["Speed"]
    with pytest.raises(MissingColumnsError, match="Speed"):
        build_window_replay_dict(cars, synthetic.SESSION_META, WINDOW)


def test_window_rejects_a_car_with_time_running_backwards():
    cars = _two_car_window()
    cars[1].telemetry["Time"] = cars[1].telemetry["Time"][::-1].copy()
    with pytest.raises(TelemetryShapeError, match="BBB: telemetry Time"):
        build_window_replay_dict(cars, synthetic.SESSION_META, WINDOW)


def test_window_rejects_a_car_with_too_few_rows():
    cars = _two_car_window()
    for name in list(cars[1].telemetry):
        cars[1].telemetry[name] = cars[1].telemetry[name][:1]
    with pytest.raises(TelemetryShapeError, match="BBB: telemetry needs at least 2"):
        build_window_replay_dict(cars, synthetic.SESSION_META, WINDOW)


def test_window_positions_are_unaffected_by_the_speed_channel_s_scale():
    """
    6b's unit-agnosticism, carried into the window. Only the RATIO of travel to path
    is used, so a speed channel in mph must emit identical positions.
    """
    kmh = build_window_replay_dict(
        _two_car_window(), synthetic.SESSION_META, WINDOW
    )
    mph_cars = _two_car_window()
    for car in mph_cars:
        car.telemetry["Speed"] = car.telemetry["Speed"] / 1.609344
    mph = build_window_replay_dict(mph_cars, synthetic.SESSION_META, WINDOW)

    for a, b in zip(kmh["cars"], mph["cars"]):
        assert [(s["x"], s["y"]) for s in a["samples"]] == [
            (s["x"], s["y"]) for s in b["samples"]
        ]


# --- DRS is decided once per replay, not per car ----------------------------------


def test_window_gives_every_car_drs_when_any_car_used_it():
    """
    Over a short window a driver who never opened DRS has an all-zero channel and
    would lose the HUD indicator while their team-mate kept it — two cars in one file
    disagreeing about whether the season has DRS. The decision is the replay's.
    """
    cars = _two_car_window()
    cars[1].telemetry["DRS"] = np.zeros_like(cars[1].telemetry["DRS"])
    replay = build_window_replay_dict(cars, synthetic.SESSION_META, WINDOW)

    for car in replay["cars"]:
        assert all("drs" in s for s in car["samples"])
    assert all(s["drs"] == 0 for s in replay["cars"][1]["samples"])


def test_window_omits_drs_from_every_car_when_no_car_used_it():
    """A 2026+ session: all-zero everywhere means the key is omitted, as for a lap."""
    replay = build_window_replay_dict(
        _two_car_window(drs=False), synthetic.SESSION_META, WINDOW
    )
    for car in replay["cars"]:
        assert all("drs" not in s for s in car["samples"])


def test_window_omits_drs_when_one_car_lacks_the_channel_entirely():
    """
    Degrades in the SAFE direction: the indicator disappears for everybody rather
    than the build failing, or — worse — one car silently carrying it.
    """
    cars = _two_car_window()
    del cars[1].telemetry["DRS"]
    replay = build_window_replay_dict(cars, synthetic.SESSION_META, WINDOW)
    for car in replay["cars"]:
        assert all("drs" not in s for s in car["samples"])


def test_has_drs_treats_absent_and_all_zero_alike():
    assert has_drs(None) is False
    assert has_drs(np.zeros(5, dtype=int)) is False
    assert has_drs(np.array([0, 0, 12, 0])) is True


def test_build_samples_refuses_to_include_drs_a_car_does_not_have():
    grid = np.arange(3, dtype=float) / 10
    zeros = np.zeros(3)
    with pytest.raises(TelemetryShapeError, match="carries no DRS channel"):
        build_samples(grid, zeros, zeros, zeros, zeros, zeros, zeros, None,
                      include_drs=True)


# --- resample_channels ------------------------------------------------------------


def test_resample_channels_leaves_position_to_the_caller():
    """
    Position is the ONE channel the two builders treat differently, so it is
    deliberately absent here rather than hidden behind a flag.
    """
    tel = synthetic.telemetry()
    t = tel["Time"] - tel["Time"][0]
    channels = resample_channels(np.array([0.0, 0.5, 1.0]), t, tel)
    assert set(channels) == {"speed", "throttle", "brake", "gear", "drs"}


def test_resample_channels_resamples_by_type():
    """Continuous interpolate, discrete forward-fill (CLAUDE.md rule 6)."""
    t = np.array([0.0, 1.0])
    tel = {
        "Speed": np.array([100.0, 200.0]),
        "Throttle": np.array([0.0, 100.0]),
        "Brake": np.array([0, 1]),
        "nGear": np.array([3, 8]),
        "DRS": np.array([0, 12]),
    }
    ch = resample_channels(np.array([0.5]), t, tel)
    assert ch["speed"][0] == pytest.approx(150.0)
    assert ch["throttle"][0] == pytest.approx(50.0)
    assert ch["brake"][0] == 0  # never 0.5
    assert ch["gear"][0] == 3  # never 5.5
    assert ch["drs"][0] == 0


# --- the scale-spread diagnostic --------------------------------------------------


def test_window_car_report_names_each_car_and_flags_the_parked_one():
    cars = [
        synthetic.window_car("AAA", synthetic.session_telemetry(*WINDOW)),
        synthetic.window_car("BBB", synthetic.parked_telemetry(*WINDOW)),
    ]
    report = window_car_report(cars)

    assert [driver for driver, _, _ in report] == ["AAA", "BBB"]
    assert report[0][1] is True
    assert report[1][1] is False


def test_window_car_report_distance_is_metres_from_the_speed_channel():
    """
    Real metres, read off the one channel whose unit the schema pins — never off the
    position channel, whose scale is exactly the unknown this module refuses to
    assume. Asserted three ways, because the claim has three parts.
    """
    ((_, _, distance),) = window_car_report(_two_car_window()[:1])

    # 1. It is the actual distance the speed profile covers, in metres.
    analytic = synthetic.session_distance_m(synthetic.SESSION_T0, WINDOW_END)
    assert distance == pytest.approx(analytic, rel=1e-3)

    # 2. Rescaling the POSITION channel cannot move it.
    stretched = _two_car_window()[:1]
    stretched[0].telemetry["X"] = stretched[0].telemetry["X"] * 37.0
    stretched[0].telemetry["Y"] = stretched[0].telemetry["Y"] * 37.0
    assert window_car_report(stretched)[0][2] == pytest.approx(distance)

    # 3. Rescaling the SPEED channel moves it exactly in proportion.
    faster = _two_car_window()[:1]
    faster[0].telemetry["Speed"] = faster[0].telemetry["Speed"] * 2.0
    assert window_car_report(faster)[0][2] == pytest.approx(2.0 * distance)


# --- motion fidelity: 6b's metric, per car ----------------------------------------


def test_motion_fidelity_is_near_perfect_on_arc_length_placed_positions():
    """
    6b's acceptance bar (r > 0.97) applied to the window builder's output. Placing
    samples by travelled distance is what makes the marker's apparent speed agree
    with the speed channel; this is that claim, measured.
    """
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    for car in replay["cars"]:
        corr, spread = motion_fidelity(car["samples"], replay["meta"]["sampleRateHz"])
        assert corr > 0.97
        assert spread < 0.05


def test_motion_fidelity_is_scale_free_in_both_channels():
    """
    The property that lets this module compute it at all: it does not know the
    conversion between position units and km/h, and a correlation plus a
    self-normalised spread do not need one.
    """
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    samples = replay["cars"][0]["samples"]
    rescaled = [
        {**s, "x": s["x"] * 7.5, "y": s["y"] * 7.5, "speed": s["speed"] * 0.3}
        for s in samples
    ]
    assert motion_fidelity(samples, 10) == pytest.approx(motion_fidelity(rescaled, 10))


def test_motion_fidelity_catches_positions_placed_by_time_instead_of_travel():
    """
    The negative half. Bunching the samples in space while leaving the speed channel
    alone is exactly the defect 6b removed, and the metric has to see it — otherwise
    it would pass everything and mean nothing.
    """
    replay = build_window_replay_dict(_two_car_window(), synthetic.SESSION_META, WINDOW)
    samples = replay["cars"][0]["samples"]
    scrambled = [
        {**s, "x": s["x"] * (1.0 + 0.6 * ((k % 3) - 1))}
        for k, s in enumerate(samples)
    ]
    good_r, _ = motion_fidelity(samples, 10)
    bad_r, bad_spread = motion_fidelity(scrambled, 10)
    assert bad_r < good_r
    assert bad_spread > 0.2


def test_motion_fidelity_is_undefined_for_a_car_that_never_moved():
    """A parked car's ratio has a zero denominator on every step; there is nothing to
    correlate, and saying so is better than returning a number."""
    replay = build_window_replay_dict(
        [
            synthetic.window_car("AAA", synthetic.session_telemetry(*WINDOW)),
            synthetic.window_car("BBB", synthetic.parked_telemetry(*WINDOW)),
        ],
        synthetic.SESSION_META,
        WINDOW,
    )
    assert motion_fidelity(replay["cars"][1]["samples"], 10) is None


def test_motion_fidelity_is_undefined_when_a_channel_never_varies():
    """Correlation needs variance on both axes; a constant one is not a failure to
    report as a number."""
    flat = [{"x": float(k), "y": 0.0, "speed": 100.0} for k in range(10)]
    assert motion_fidelity(flat, 10) is None


# --- the per-car ratio does NOT reach the emitted positions -----------------------


def test_one_car_s_speed_scale_changes_nothing_for_it_or_its_neighbours():
    """
    The measurement that refuted this slice's own plan, kept as a regression test.

    The plan assumed each car carried a per-car "unit bridge" (path / travel) into
    its placement, so that cars with different ratios would drift apart along the
    track — and on 2024 Monza R that spread computed to an alarming 24 m. It is not
    real: `resample_positions_by_travel` places sample k at a FRACTION of the car's
    own path, so the ratio cancels completely.

    Multiplying ONE car's speed channel by 1.5 moves its path/travel ratio by 33% and
    must leave every emitted coordinate — its own and its neighbour's — untouched.
    Anyone who reintroduces a shared or absolute scale will fail here.
    """
    base = build_window_replay_dict(
        _two_car_window(), synthetic.SESSION_META, WINDOW
    )
    skewed_cars = _two_car_window()
    skewed_cars[1].telemetry["Speed"] = skewed_cars[1].telemetry["Speed"] * 1.5
    skewed = build_window_replay_dict(skewed_cars, synthetic.SESSION_META, WINDOW)

    for before, after in zip(base["cars"], skewed["cars"]):
        assert [(s["x"], s["y"]) for s in before["samples"]] == [
            (s["x"], s["y"]) for s in after["samples"]
        ], before["driver"]


# --- lap ranges -------------------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [("12-14", (12, 14)), ("12", (12, 12)), ("1-53", (1, 53)), ("7-7", (7, 7))],
)
def test_parse_lap_range_accepts_a_number_or_a_range(text, expected):
    assert parse_lap_range(text) == expected


@pytest.mark.parametrize("text", ["14-12", "", "a-b", "12-", "1-2-3", "12.5", "-3"])
def test_parse_lap_range_rejects_anything_else(text):
    """A mis-parsed range is a different window, silently — so it fails loudly."""
    with pytest.raises(TelemetryShapeError, match="lap range"):
        parse_lap_range(text)
