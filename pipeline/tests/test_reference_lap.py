"""
The reference lap (Slice 24): `reference_lap.py`, the builders' use of it, and its
report line.

The fixture that matters most here is a STANDING START: a car parked on its grid
slot that pulls away, crosses the timing line ~30 m later, and laps. That is the
shape of the shipped red-flag window, whose `startFinish` came out at the pole slot
with angle 0.0 — and it is the case the lap builder already guards
(`assert angle != 0.0`) and the window builder, until now, did not.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

import synthetic
from replay_transform import (
    PIT_STOP_MAX_KMH,
    REFERENCE_LAP_MIN_S,
    SAMPLE_RATE_HZ,
    START_FINISH_HEADING_M,
    LapFacts,
    NoReferenceLapError,
    ReferenceLap,
    Rejection,
    TelemetryShapeError,
    build_replay_dict,
    build_window_replay_dict,
    in_window_laps,
    lap_context,
    lap_facts,
    reference_lap_report,
    select_reference_lap,
    start_finish_at,
)

RATE = SAMPLE_RATE_HZ
NAN = math.nan

# --- a standing start, in closed form ----------------------------------------------

#: Metres per second at the synthetic circle's mean speed.
_V = synthetic.SESSION_SPEED_KMH / 3.6
#: The grid hold and the launch ramp, seconds.
_HOLD_S, _RAMP_S = 3.0, 2.0
#: The timing line sits this far up the road from the grid slot, metres. A real grid
#: puts the slots well clear of the line (the red-flag asset's pole slot reads ~290 m
#: off it); all the fixture needs is that the line is NOT the slot.
_LINE_M = 30.0
_PHI0 = math.pi / 3.0
#: One lap of the synthetic circle, metres.
_LAP_M = _V * synthetic.SESSION_LAP_S


def _standing_distance_m(tau: np.ndarray) -> np.ndarray:
    """Metres from the grid slot `tau` seconds after the window opens."""
    tau = np.asarray(tau, dtype=float)
    ramp = np.clip(tau - _HOLD_S, 0.0, _RAMP_S)
    after = np.clip(tau - _HOLD_S - _RAMP_S, 0.0, None)
    return _V * ramp * ramp / (2.0 * _RAMP_S) + _V * after


def _time_at_m(d: float) -> float:
    """Inverse of `_standing_distance_m` past the ramp."""
    return _HOLD_S + _RAMP_S + (d - _V * _RAMP_S / 2.0) / _V


def _phi_at_m(d: float) -> float:
    return _PHI0 + d * synthetic.SESSION_UNITS_PER_M / synthetic.SESSION_RADIUS


#: Window seconds at which the car crosses the timing line at the end of lap 1 and
#: of lap 2. The window runs to the end of lap 2, as `resolve_lap_window` would cut it.
_LAP1_END = _time_at_m(_LINE_M + _LAP_M)
_LAP2_END = _time_at_m(_LINE_M + 2.0 * _LAP_M)
_T0 = synthetic.SESSION_T0
_WINDOW = (_T0, _T0 + _LAP2_END)


def _standing_start_telemetry(start: float, end: float) -> "dict[str, np.ndarray]":
    """Parked on the slot for `_HOLD_S`, a linear launch over `_RAMP_S`, then the
    circle at the mean speed; the position is the exact integral of the speed."""
    n = int(round((end - start) * synthetic.SOURCE_RATE_HZ)) + 1
    t = start + np.arange(n, dtype=float) / synthetic.SOURCE_RATE_HZ
    tau = t - _T0
    phi = _PHI0 + _standing_distance_m(tau) * synthetic.SESSION_UNITS_PER_M / (
        synthetic.SESSION_RADIUS
    )
    speed = np.clip((tau - _HOLD_S) / _RAMP_S, 0.0, 1.0) * synthetic.SESSION_SPEED_KMH
    held = speed < 1.0
    return {
        "Time": t,
        "X": synthetic.SESSION_RADIUS * np.cos(phi),
        "Y": synthetic.SESSION_RADIUS * np.sin(phi),
        "Speed": speed,
        "Throttle": np.where(held, 0.0, 90.0),
        "Brake": held.astype(int),
        "nGear": np.where(held, 1, 7).astype(int),
        "DRS": np.zeros(n, dtype=int),
    }


def _standing_facts(standing_start: bool = True) -> "tuple[LapFacts, ...]":
    """Lap 1 from the lights (the window start), lap 2 line to line — through the
    real `lap_facts`, the way `build_race_replay` hands a FastF1 table over."""
    return lap_facts(
        [1, 2],
        [_T0, _T0 + _LAP1_END],
        [_LAP1_END, _LAP2_END - _LAP1_END],
        [NAN, NAN],
        [NAN, NAN],
        standing_start,
        _WINDOW,
    )


def _standing_window(reference_laps="facts", status=()):
    cars = [
        synthetic.window_car("AAA", _standing_start_telemetry(*_WINDOW)),
    ]
    facts = [_standing_facts()] if reference_laps == "facts" else reference_laps
    return build_window_replay_dict(
        cars, synthetic.SESSION_META, _WINDOW, status=status, reference_laps=facts
    )


# --- lap_facts ----------------------------------------------------------------------


def test_lap_facts_rebases_onto_the_window_and_reads_the_pit_columns():
    facts = lap_facts(
        [4, 5, 6],
        [100.0, 190.0, 280.0],
        [90.0, NAN, 85.0],
        [NAN, NAN, 360.0],
        [NAN, 195.0, NAN],
        True,
        (100.0, 400.0),
    )
    assert [f.number for f in facts] == [4, 5, 6]
    assert facts[0] == LapFacts(4, 0.0, 90.0, False, False, False)
    # A missing LapTime is a NaN end, not an invented one.
    assert facts[1].start_s == 90.0 and math.isnan(facts[1].end_s)
    assert facts[1].pit_out and not facts[1].pit_in
    assert facts[2].pit_in and not facts[2].pit_out
    # Lap 1 is the only lap a standing start flags.
    assert not any(f.race_lap_one for f in facts)


def test_lap_facts_flags_lap_one_only_for_a_standing_start_session():
    table = ([1, 2], [0.0, 90.0], [90.0, 88.0], [NAN, NAN], [NAN, NAN])
    race = lap_facts(*table, True, (0.0, 178.0))
    practice = lap_facts(*table, False, (0.0, 178.0))
    assert [f.race_lap_one for f in race] == [True, False]
    assert [f.race_lap_one for f in practice] == [False, False]


def test_lap_facts_considers_exactly_the_laps_the_file_carries():
    """One rule for "a lap in this window": the candidates are `lap_context`'s laps,
    including the lap in progress at t0 (negative start) and a lap with no end."""
    window = (synthetic.SESSION_T0, synthetic.SESSION_T0 + 4.0)
    for driver, table in synthetic.SESSION_LAP_TABLES.items():
        numbers, starts, times, _, _ = table
        nan = [NAN] * len(numbers)
        facts = lap_facts(numbers, starts, times, nan, nan, True, window)
        laps, _ = lap_context(*table, window)
        assert [f.number for f in facts] == [lap["number"] for lap in laps], driver
        assert [round(f.start_s, 3) for f in facts] == [lap["startT"] for lap in laps]


def test_lap_facts_rejects_pit_columns_of_the_wrong_length():
    with pytest.raises(TelemetryShapeError, match="disagree"):
        lap_facts([1, 2], [0.0, 90.0], [90.0, 88.0], [NAN], [NAN, NAN], True, (0, 9))


def test_in_window_laps_rejects_a_lap_time_column_of_the_wrong_length():
    with pytest.raises(TelemetryShapeError, match="disagree"):
        in_window_laps([1, 2], [0.0, 90.0], [90.0], (0.0, 100.0))


# --- select_reference_lap -----------------------------------------------------------


def _lap(number, start, end, **flags) -> LapFacts:
    return LapFacts(number=number, start_s=start, end_s=end, **flags)


def _fast(seconds: float, kmh: float = 250.0) -> "list[float]":
    """A speed channel that never stops, `seconds` long on the 10 Hz grid."""
    return [kmh] * (int(round(seconds * RATE)) + 1)


GREEN_ALL = [{"status": "green", "fromT": 0.0, "toT": 1000.0}]


def test_the_first_cars_earliest_clean_green_lap_is_chosen():
    ref = select_reference_lap(
        ["AAA", "BBB"],
        [[_lap(10, 0.0, 85.0), _lap(11, 85.0, 170.0)], [_lap(10, -3.0, 82.0)]],
        [_fast(171.0), _fast(171.0)],
        GREEN_ALL,
        RATE,
    )
    assert (ref.car, ref.driver, ref.number) == (0, "AAA", 10)
    assert (ref.from_i, ref.to_i) == (0, 850)
    assert (ref.from_t, ref.to_t) == (0.0, 85.0)
    assert ref.green and ref.rejected == ()
    assert ref.field() == {"car": 0, "fromT": 0.0, "toT": 85.0}


@pytest.mark.parametrize(
    "lap, reason",
    [
        (_lap(1, 0.0, 90.0, race_lap_one=True), "race lap 1"),
        (_lap(5, 0.0, NAN), "no LapTime recorded"),
        (_lap(5, 10.0, 10.0), "no LapTime recorded"),
        (_lap(5, 0.0, 90.0, pit_in=True), "in-lap"),
        (_lap(5, 0.0, 90.0, pit_out=True), "out-lap"),
        (_lap(5, -2.0, 88.0), "began before the window"),
        (_lap(5, 100.0, 300.0), "runs past the window's end"),
        (_lap(5, 100.0, 103.0), f"under the {REFERENCE_LAP_MIN_S:g} s minimum"),
    ],
)
def test_each_disqualification_is_named(lap, reason):
    good = _lap(9, 110.0, 195.0)
    ref = select_reference_lap(["AAA"], [[lap, good]], [_fast(200.0)], GREEN_ALL, RATE)
    assert ref.number == 9
    assert len(ref.rejected) == 1
    assert ref.rejected[0].number == lap.number
    assert reason in ref.rejected[0].reason


def test_a_lap_containing_a_stop_is_not_a_racing_lap():
    """The grid hold of a standing restart: timing says lap, the speeds say stop."""
    speed = _fast(200.0)
    for k in range(300, 340):
        speed[k] = 0.0
    ref = select_reference_lap(
        ["RUS"],
        [[_lap(6, 0.0, 90.0), _lap(7, 90.0, 175.0)]],
        [speed],
        GREEN_ALL,
        RATE,
    )
    assert ref.number == 7
    assert ref.rejected == (
        Rejection(
            "RUS",
            6,
            f"contains a stop - 40 sample(s) below {PIT_STOP_MAX_KMH:g} km/h from t=30.0 s",
        ),
    )


def test_the_stop_threshold_is_the_pit_lane_detectors():
    """Reused, not re-invented: a crawl just above it is still a racing lap."""
    speed = [PIT_STOP_MAX_KMH] * 901
    ref = select_reference_lap(["AAA"], [[_lap(3, 0.0, 90.0)]], [speed], GREEN_ALL, RATE)
    assert ref.number == 3


def test_a_lap_ending_in_the_holding_step_snaps_to_the_last_sample():
    """The first driver's last lap ends where the window does — inside the step past
    the last sample. That is inside the window, not past it."""
    speed = _fast(90.0)  # 901 samples: duration 90.1 s
    ref = select_reference_lap(["AAA"], [[_lap(3, 0.0, 90.08)]], [speed], GREEN_ALL, RATE)
    assert (ref.from_i, ref.to_i) == (0, 900)


def test_a_lap_beginning_within_half_a_step_of_the_window_starts_at_sample_zero():
    ref = select_reference_lap(
        ["AAA"], [[_lap(3, -0.04, 85.0)]], [_fast(90.0)], GREEN_ALL, RATE
    )
    assert ref.from_i == 0


def test_a_green_lap_on_a_later_car_beats_a_clean_lap_under_the_safety_car():
    """Pace is one of the four things the reference sets; an SC lap is ~40% slow.
    The tier is chosen before the car — and the passed-over lap says why."""
    status = [
        {"status": "green", "fromT": 0.0, "toT": 10.0},
        {"status": "sc", "fromT": 10.0, "toT": 100.0},
    ]
    ref = select_reference_lap(
        ["AAA", "BBB"],
        [[_lap(4, 5.0, 95.0)], [_lap(4, 0.0, 9.5)]],
        [_fast(100.0), _fast(100.0)],
        status,
        RATE,
    )
    assert (ref.car, ref.driver, ref.green) == (1, "BBB", True)
    assert ref.rejected == (
        Rejection("AAA", 4, "not green throughout - sc 10-95 s"),
    )


def test_with_no_green_lap_anywhere_the_first_clean_lap_is_the_named_fallback():
    ref = select_reference_lap(
        ["AAA", "BBB"],
        [[_lap(1, 0.0, 90.0, race_lap_one=True), _lap(2, 90.0, 180.0)], [_lap(2, 92.0, 182.0)]],
        [_fast(190.0), _fast(190.0)],
        [],  # a window with no status data — the finale asset's shape
        RATE,
    )
    assert (ref.car, ref.number, ref.green) == (0, 2, False)
    assert [r.number for r in ref.rejected] == [1]


def test_status_that_covers_only_part_of_the_lap_is_not_green_throughout():
    status = [{"status": "green", "fromT": 0.0, "toT": 50.0}]
    ref = select_reference_lap(
        ["AAA", "BBB"],
        [[_lap(2, 0.0, 85.0)], [_lap(2, 1.0, 45.0)]],
        [_fast(90.0), _fast(90.0)],
        status,
        RATE,
    )
    assert ref.car == 1
    assert ref.rejected[0].reason == (
        "not green throughout - track status does not cover all of it"
    )


def test_no_qualifying_lap_fails_loudly_and_names_every_reason():
    with pytest.raises(NoReferenceLapError) as err:
        select_reference_lap(
            ["RUS", "GAS"],
            [
                [_lap(1, 0.0, 88.0, race_lap_one=True), _lap(3, 88.0, NAN)],
                [_lap(3, 86.0, 190.0, pit_in=True)],
            ],
            [_fast(190.0), _fast(190.0)],
            GREEN_ALL,
            RATE,
        )
    message = str(err.value)
    assert "RUS lap 1: race lap 1" in message
    assert "RUS lap 3: no LapTime recorded" in message
    assert "GAS lap 3: in-lap" in message
    assert "--laps" in message and "first" in message
    # Loud, and still a TelemetryShapeError: `_run_window` turns it into a SystemExit.
    assert isinstance(err.value, TelemetryShapeError)


def test_no_lap_table_at_all_fails_loudly_too():
    with pytest.raises(NoReferenceLapError, match="no car carries a lap table"):
        select_reference_lap(["AAA"], [()], [_fast(90.0)], GREEN_ALL, RATE)


def test_selection_needs_one_lap_table_and_speed_channel_per_car():
    with pytest.raises(TelemetryShapeError, match="one lap table and one speed"):
        select_reference_lap(["AAA", "BBB"], [()], [_fast(9.0)], [], RATE)


# --- start_finish_at ----------------------------------------------------------------


def _ref(from_i: int, to_i: int) -> ReferenceLap:
    return ReferenceLap(0, "AAA", 2, from_i, to_i, RATE, True)


def test_at_speed_the_heading_is_the_next_sample_exactly_as_before():
    """250 km/h covers 6.9 m per 10 Hz step, past `START_FINISH_HEADING_M`, so the
    heading is the two-sample one both builders always used — byte-identical."""
    n = 100
    x = np.arange(n) * 69.4 * 0.1 * 10.0  # 6.94 m/step at 10 units per metre
    y = 0.5 * np.arange(n) ** 1.1
    sf = start_finish_at(x, y, [250.0] * n, _ref(10, 90))
    assert sf["x"] == round(float(x[10]), 1) and sf["y"] == round(float(y[10]), 1)
    assert sf["angle"] == round(math.atan2(y[11] - y[10], x[11] - x[10]), 6)


def test_a_slow_crossing_reaches_past_the_fixes_too_close_to_point_anywhere():
    """At 36 km/h a step is 1 m: the heading waits for the first fix 5 m away, which
    a stationary pair (the red-flag asset's angle 0.0) never offers."""
    n = 200
    heading = 0.7
    units = np.arange(n) * 10.0  # 1 m per step at 10 units per metre
    glitch = np.where(np.arange(n) == 1, 3.0, 0.0)  # a sideways fix at k=1
    x = units * math.cos(heading) - glitch * math.sin(heading)
    y = units * math.sin(heading) + glitch * math.cos(heading)
    sf = start_finish_at(x, y, [36.0] * n, _ref(0, 150))
    k = int(START_FINISH_HEADING_M)  # the first fix 5 m on
    assert sf["angle"] == round(math.atan2(y[k] - y[0], x[k] - x[0]), 6)
    assert sf["angle"] == pytest.approx(heading, abs=1e-6)
    # The two-sample heading the builders used would have pointed at the glitch.
    assert math.atan2(y[1] - y[0], x[1] - x[0]) == pytest.approx(heading + 0.29, abs=0.01)


def test_a_frozen_position_channel_has_no_heading_and_says_so():
    n = 120
    with pytest.raises(TelemetryShapeError, match="never moves"):
        start_finish_at([5.0] * n, [7.0] * n, [200.0] * n, _ref(0, 100))


def test_a_jitter_cluster_under_a_moving_speed_channel_has_no_heading_either():
    """Positions wander inside a unit-sized cluster while the speed claims a crawl:
    the bridge says the lap covered ground, the fixes never get 5 m from the start."""
    n = 120
    k = np.arange(n)
    x = np.sin(k)
    y = np.cos(1.7 * k)
    with pytest.raises(TelemetryShapeError, match="never moves"):
        start_finish_at(x, y, [20.0] * n, _ref(0, 100))


# --- the builders -------------------------------------------------------------------


def test_the_lap_builder_emits_its_whole_closed_lap_as_the_reference():
    replay = build_replay_dict(synthetic.telemetry(), synthetic.META)
    assert replay["track"]["referenceLap"] == {
        "car": 0,
        "fromT": 0.0,
        "toT": replay["meta"]["duration"],
    }


def test_window_builder_with_a_stationary_reference_start():
    """THE defect, reproduced and removed on one fixture.

    Without lap facts (the pre-Slice-24 path) the line is the grid slot at angle 0.0
    — two identical parked fixes — which is exactly the shipped red-flag asset. With
    them the race's lap 1 is passed over by name, lap 2 is chosen, and the line sits
    on the timing line with the circle's own heading.
    """
    legacy = _standing_window(reference_laps=None)
    slot_x = synthetic.SESSION_RADIUS * math.cos(_PHI0)
    slot_y = synthetic.SESSION_RADIUS * math.sin(_PHI0)
    assert legacy["track"]["startFinish"]["angle"] == 0.0
    assert legacy["track"]["startFinish"]["x"] == pytest.approx(slot_x, abs=0.1)
    assert legacy["track"]["startFinish"]["y"] == pytest.approx(slot_y, abs=0.1)
    assert "referenceLap" not in legacy["track"]

    replay = _standing_window()
    ref = replay["track"]["referenceLap"]
    assert ref == {
        "car": 0,
        "fromT": round(round(_LAP1_END * RATE) / RATE, 3),
        # The window ends where lap 2 does: inside the holding step, so the last sample.
        "toT": round((len(replay["cars"][0]["samples"]) - 1) / RATE, 3),
    }
    sf = replay["track"]["startFinish"]
    assert sf["angle"] != 0.0
    # On the timing line: within one grid step of where the car crossed it...
    line = _phi_at_m(_LINE_M)
    step_units = _V / RATE * synthetic.SESSION_UNITS_PER_M
    assert math.hypot(
        sf["x"] - synthetic.SESSION_RADIUS * math.cos(line),
        sf["y"] - synthetic.SESSION_RADIUS * math.sin(line),
    ) <= step_units
    # ...not on the slot...
    assert math.hypot(sf["x"] - slot_x, sf["y"] - slot_y) > 25.0 * synthetic.SESSION_UNITS_PER_M
    # ...and square to the road: the circle's tangent there, to within a step's turn.
    tangent = line + math.pi / 2.0
    assert math.cos(sf["angle"] - tangent) == pytest.approx(1.0, abs=1e-3)
    # The emitted line IS the chosen car's sample at fromT.
    at = replay["cars"][0]["samples"][round(ref["fromT"] * RATE)]
    assert (sf["x"], sf["y"]) == (at["x"], at["y"])


def test_a_stationary_start_outside_a_race_is_still_passed_over_by_its_stop():
    """No lap-1 flag (a practice session): the grid hold alone disqualifies it."""
    replay = _standing_window(reference_laps=[_standing_facts(standing_start=False)])
    assert replay["track"]["referenceLap"]["fromT"] > 20.0


def test_window_builder_takes_the_line_from_whichever_car_is_the_reference():
    """`cars[0]` parked with no lap table: the reference — and so the line — is
    cars[1]'s, not the first car's first sample."""
    cars = [
        synthetic.window_car("CCC", synthetic.parked_telemetry(*_WINDOW)),
        synthetic.window_car("AAA", _standing_start_telemetry(*_WINDOW)),
    ]
    replay = build_window_replay_dict(
        cars, synthetic.SESSION_META, _WINDOW, reference_laps=[(), _standing_facts()]
    )
    ref = replay["track"]["referenceLap"]
    assert ref["car"] == 1
    at = replay["cars"][1]["samples"][round(ref["fromT"] * RATE)]
    sf = replay["track"]["startFinish"]
    assert (sf["x"], sf["y"]) == (at["x"], at["y"])


def test_window_builder_fails_loudly_when_nothing_qualifies():
    only_lap_one = (_standing_facts()[0],)
    with pytest.raises(NoReferenceLapError, match="race lap 1"):
        _standing_window(reference_laps=[only_lap_one])


def test_window_builder_needs_one_lap_table_per_car():
    with pytest.raises(TelemetryShapeError, match="one lap table per car"):
        _standing_window(reference_laps=[_standing_facts(), ()])


# --- the report ---------------------------------------------------------------------


def test_reference_lap_report_recomputes_the_choice_from_the_file():
    replay = _standing_window()
    report = reference_lap_report(replay, [_standing_facts()])
    assert "cars[0] AAA lap 2:" in report
    assert "FALLBACK - no qualifying lap is green throughout" in report
    assert "passed over AAA lap 1: race lap 1" in report
    assert "start/finish:" in report
    assert "MISMATCH" not in report


def test_reference_lap_report_names_a_green_choice():
    green = [{"status": "green", "fromT": 0.0, "toT": round(_LAP2_END + 0.1, 3)}]
    replay = _standing_window(status=green)
    report = reference_lap_report(replay, [_standing_facts()])
    assert "green throughout" in report and "FALLBACK" not in report


def test_reference_lap_report_is_loudest_when_the_file_disagrees():
    replay = _standing_window()
    replay["track"]["referenceLap"] = dict(replay["track"]["referenceLap"], toT=1.0)
    assert "MISMATCH" in reference_lap_report(replay, [_standing_facts()])
