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
    dump_json,
    forward_fill,
    interp_continuous,
    normalise_brake,
    normalise_color,
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
