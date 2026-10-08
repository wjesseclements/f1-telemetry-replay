"""
The reference lap (Slice 24): `reference_lap.py`, the builders' use of it, and its
report line.

The fixture that matters most here is a STANDING START (`synthetic.standing_*`): a
car parked on its grid slot that pulls away, crosses the timing line ~30 m later,
and laps. That is the shape of the shipped red-flag window, whose `startFinish` came
out at the pole slot with angle 0.0 — and it is the case the lap builder already
guards (`assert angle != 0.0`) and the window builder, until now, did not. The same
fixture builds the `race-window-standing` golden, so the app's schema sees it too.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np
import pytest

import synthetic
from replay_transform import (
    FAULT_DECLINED_JUMP,
    FAULT_LEFT_REVERSAL,
    FAULT_SURRENDERED_RUN,
    LEGACY_REFERENCE,
    PIT_STOP_MAX_KMH,
    POSITION_FAULT_MARGIN_S,
    REFERENCE_LAP_CLOSE_M,
    REFERENCE_LAP_MIN_S,
    SAMPLE_RATE_HZ,
    START_FINISH_HEADING_M,
    STUCK_MIN_ROWS,
    AnchorPlan,
    FixRejection,
    FrameDisplacement,
    LapFacts,
    NoReferenceLapError,
    PositionFault,
    ReferenceLap,
    Rejection,
    ReversalRejection,
    TelemetryShapeError,
    bridge_stuck_channels,
    build_replay_dict,
    build_window_replay_dict,
    detect_stuck_channels,
    in_window_laps,
    lap_context,
    lap_facts,
    position_faults,
    reference_lap_report,
    reject_impossible_fixes,
    reject_reversals,
    repair_frame_displacements,
    select_reference_lap,
    start_finish_at,
    window_anchor_plan,
)

RATE = SAMPLE_RATE_HZ
NAN = math.nan

# --- a standing start, in closed form (`synthetic.standing_*`) ----------------------

_V = synthetic.SESSION_SPEED_KMH / 3.6
_LINE_M = synthetic.STANDING_LINE_M
_PHI0 = synthetic.STANDING_PHI0
_LAP1_END = synthetic.STANDING_LAP1_END
_LAP2_END = synthetic.STANDING_LAP2_END
_T0 = synthetic.SESSION_T0
_WINDOW = synthetic.STANDING_WINDOW
_phi_at_m = synthetic.standing_phi_at_m


def _standing_facts(
    standing_start: bool = True, accurate=(True, True)
) -> "tuple[LapFacts, ...]":
    """Lap 1 from the lights (the window start), lap 2 line to line — through the
    real `lap_facts`, the way `build_race_replay` hands a FastF1 table over. Both
    laps are vouched for by default, so what passes over lap 1 is the standing start
    (or, outside a race, its grid hold) and nothing else."""
    numbers, starts, times, _, _ = synthetic.STANDING_LAP_TABLE
    return lap_facts(
        numbers, starts, times, [NAN, NAN], [NAN, NAN], list(accurate),
        standing_start, _WINDOW,
    )


def _standing_window(reference_laps="facts", status=(), telemetry=None):
    tel = synthetic.standing_start_telemetry(*_WINDOW) if telemetry is None else telemetry
    cars = [synthetic.window_car("AAA", tel)]
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
        [True, False, False],
        True,
        (100.0, 400.0),
    )
    assert [f.number for f in facts] == [4, 5, 6]
    assert facts[0] == LapFacts(4, 0.0, 90.0, False, False, False, True)
    # A missing LapTime is a NaN end, not an invented one.
    assert facts[1].start_s == 90.0 and math.isnan(facts[1].end_s)
    assert facts[1].pit_out and not facts[1].pit_in
    assert facts[2].pit_in and not facts[2].pit_out
    # Lap 1 is the only lap a standing start flags.
    assert not any(f.race_lap_one for f in facts)


def test_lap_facts_flags_lap_one_only_for_a_standing_start_session():
    table = ([1, 2], [0.0, 90.0], [90.0, 88.0], [NAN, NAN], [NAN, NAN], [True, True])
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
        facts = lap_facts(
            numbers, starts, times, nan, nan, [True] * len(numbers), True, window
        )
        laps, _ = lap_context(*table, window)
        assert [f.number for f in facts] == [lap["number"] for lap in laps], driver
        assert [round(f.start_s, 3) for f in facts] == [lap["startT"] for lap in laps]


@pytest.mark.parametrize(
    "pit_in, accurate",
    [([NAN], [True, True]), ([NAN, NAN], [True])],
    ids=["pit column", "IsAccurate column"],
)
def test_lap_facts_rejects_columns_of_the_wrong_length(pit_in, accurate):
    with pytest.raises(TelemetryShapeError, match="disagree"):
        lap_facts(
            [1, 2], [0.0, 90.0], [90.0, 88.0], pit_in, [NAN, NAN], accurate, True, (0, 9)
        )


def test_lap_facts_counts_only_a_real_true_as_accurate():
    """FastF1 casts `IsAccurate` to bool, but an unset cell in a hand-made or older
    table is NaN or None — and `bool(nan)` is True. An unknown is not accurate."""
    facts = lap_facts(
        [1, 2, 3, 4, 5],
        [0.0, 90.0, 180.0, 270.0, 360.0],
        [90.0] * 5,
        [NAN] * 5,
        [NAN] * 5,
        [np.True_, True, NAN, None, np.False_],
        False,
        (0.0, 450.0),
    )
    assert [f.accurate for f in facts] == [True, True, False, False, False]


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


def _closing_positions(laps, n: int) -> "tuple[list[float], list[float]]":
    """`n` grid positions on which every lap of `laps` CLOSES: a circle traversed
    once per lap, held at its start between laps. Speeds and positions are separate
    channels to the selector, so the lap-table tests need only not trip the closure
    check by accident; its own tests below build positions that do."""
    t = np.arange(n) / RATE
    phase = np.zeros(n)
    for lap in laps:
        # A lap that ends past the channel is no candidate; its phase would only
        # overwrite a later lap's.
        if math.isfinite(lap.end_s) and lap.start_s < lap.end_s < n / RATE:
            inside = (t >= lap.start_s) & (t < lap.end_s)
            phase[inside] = (t[inside] - lap.start_s) / (lap.end_s - lap.start_s)
    angle = 2.0 * math.pi * phase
    return (1000.0 * np.cos(angle)).tolist(), (1000.0 * np.sin(angle)).tolist()


def _select(drivers, laps, speeds, dropouts, status, rate, faults=None, positions=None):
    """`select_reference_lap` with no position fault and closing positions unless a
    test says otherwise — the ONE place these tests opt out of both screens, by name
    (their own tests below pass them explicitly)."""
    return select_reference_lap(
        drivers, laps, speeds, dropouts, status, rate,
        positions=(
            [_closing_positions(l, len(v)) for l, v in zip(laps, speeds)]
            if positions is None
            else positions
        ),
        faults=[()] * len(drivers) if faults is None else faults,
    )


def test_the_first_cars_earliest_clean_green_lap_is_chosen():
    ref = _select(
        ["AAA", "BBB"],
        [[_lap(10, 0.0, 85.0), _lap(11, 85.0, 170.0)], [_lap(10, -3.0, 82.0)]],
        [_fast(171.0), _fast(171.0)],
        [()] * 2,
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
        (
            _lap(5, 0.0, 90.0, accurate=False),
            "lap timing not accurate (IsAccurate=False)",
        ),
        (_lap(5, -2.0, 88.0), "began before the window"),
        (_lap(5, 100.0, 300.0), "runs past the window's end"),
        (_lap(5, 100.0, 103.0), f"under the {REFERENCE_LAP_MIN_S:g} s minimum"),
    ],
)
def test_each_disqualification_is_named(lap, reason):
    good = _lap(9, 110.0, 195.0)
    ref = _select(
        ["AAA"], [[lap, good]], [_fast(200.0)], [()], GREEN_ALL, RATE
    )
    assert ref.number == 9
    assert len(ref.rejected) == 1
    assert ref.rejected[0].number == lap.number
    assert reason in ref.rejected[0].reason


def test_a_lap_containing_a_stop_is_not_a_racing_lap():
    """The grid hold of a standing restart: timing says lap, the speeds say stop."""
    speed = _fast(200.0)
    for k in range(300, 340):
        speed[k] = 0.0
    ref = _select(
        ["RUS"],
        [[_lap(6, 0.0, 90.0), _lap(7, 90.0, 175.0)]],
        [speed],
        [()],
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


def test_the_most_specific_timing_reason_wins_over_not_accurate():
    """FastF1 marks every in/out lap `IsAccurate=False` too; the report should say
    which kind of lap it was, not only that its timing was unvouched."""
    lap = _lap(5, 0.0, 90.0, pit_in=True, accurate=False)
    ref = _select(
        ["AAA"], [[lap, _lap(6, 90.0, 175.0)]], [_fast(180.0)], [()], GREEN_ALL, RATE
    )
    assert ref.rejected == (Rejection("AAA", 5, "in-lap (PitInTime set)"),)


def test_a_lap_bridged_across_a_stuck_channel_dropout_is_passed_over():
    """Across a 9m dropout the emitted positions are the screen's bridge, not fixes
    the car reported — no material for a ribbon or a gap circuit. The 2026 corpus
    has 37 of them, at fixed track positions, so a window can hold several."""
    ref = _select(
        ["COL", "RUS"],
        [[_lap(7, 0.0, 85.0), _lap(8, 85.0, 170.0)], [_lap(7, 2.0, 87.0)]],
        [_fast(171.0), _fast(171.0)],
        [[{"fromT": 30.132, "toT": 35.65}], ()],
        GREEN_ALL,
        RATE,
    )
    assert (ref.car, ref.number) == (0, 8)
    assert ref.rejected == (
        Rejection(
            "COL",
            7,
            "overlaps a stuck-channel dropout at t=30.132-35.65 s - positions there "
            "are bridged, not measured",
        ),
    )


@pytest.mark.parametrize(
    "drop, chosen, passed_over",
    [((85.0, 90.0), 7, ()), ((80.0, 85.0), 8, (7,))],
    ids=["begins where lap 7 ends", "ends where lap 8 begins"],
)
def test_a_dropout_touching_a_lap_boundary_bridges_none_of_its_samples(
    drop, chosen, passed_over
):
    """A dropout's edges are TRUSTED fixes (the screen brackets the run with them),
    so one that merely touches a lap's start or end leaves that lap measured; only
    the lap it actually runs through is passed over."""
    ref = _select(
        ["AAA"],
        [[_lap(7, 0.0, 85.0), _lap(8, 85.0, 170.0)]],
        [_fast(171.0)],
        [[{"fromT": drop[0], "toT": drop[1]}]],
        GREEN_ALL,
        RATE,
    )
    assert ref.number == chosen
    assert tuple(r.number for r in ref.rejected) == passed_over


def test_the_stop_threshold_is_the_pit_lane_detectors():
    """Reused, not re-invented: a crawl just above it is still a racing lap."""
    speed = [PIT_STOP_MAX_KMH] * 901
    ref = _select(
        ["AAA"], [[_lap(3, 0.0, 90.0)]], [speed], [()], GREEN_ALL, RATE
    )
    assert ref.number == 3


def test_a_lap_ending_in_the_holding_step_snaps_to_the_last_sample():
    """The first driver's last lap ends where the window does — inside the step past
    the last sample. That is inside the window, not past it."""
    speed = _fast(90.0)  # 901 samples: duration 90.1 s
    ref = _select(
        ["AAA"], [[_lap(3, 0.0, 90.08)]], [speed], [()], GREEN_ALL, RATE
    )
    assert (ref.from_i, ref.to_i) == (0, 900)


def test_a_lap_beginning_within_half_a_step_of_the_window_starts_at_sample_zero():
    ref = _select(
        ["AAA"], [[_lap(3, -0.04, 85.0)]], [_fast(90.0)], [()], GREEN_ALL, RATE
    )
    assert ref.from_i == 0


def test_a_green_lap_on_a_later_car_beats_a_clean_lap_under_the_safety_car():
    """Pace is one of the four things the reference sets; an SC lap is ~40% slow.
    The tier is chosen before the car — and the passed-over lap says why."""
    status = [
        {"status": "green", "fromT": 0.0, "toT": 10.0},
        {"status": "sc", "fromT": 10.0, "toT": 100.0},
    ]
    ref = _select(
        ["AAA", "BBB"],
        [[_lap(4, 5.0, 95.0)], [_lap(4, 0.0, 9.5)]],
        [_fast(100.0), _fast(100.0)],
        [()] * 2,
        status,
        RATE,
    )
    assert (ref.car, ref.driver, ref.green) == (1, "BBB", True)
    assert ref.rejected == (
        Rejection("AAA", 4, "not green throughout - sc 10-95 s"),
    )


def test_with_no_green_lap_anywhere_the_first_clean_lap_is_the_named_fallback():
    ref = _select(
        ["AAA", "BBB"],
        [[_lap(1, 0.0, 90.0, race_lap_one=True), _lap(2, 90.0, 180.0)], [_lap(2, 92.0, 182.0)]],
        [_fast(190.0), _fast(190.0)],
        [()] * 2,
        [],  # a window with no status data (no shipped asset since Slice 24's regeneration)
        RATE,
    )
    assert (ref.car, ref.number, ref.green) == (0, 2, False)
    assert [r.number for r in ref.rejected] == [1]


def test_status_that_covers_only_part_of_the_lap_is_not_green_throughout():
    status = [{"status": "green", "fromT": 0.0, "toT": 50.0}]
    ref = _select(
        ["AAA", "BBB"],
        [[_lap(2, 0.0, 85.0)], [_lap(2, 1.0, 45.0)]],
        [_fast(90.0), _fast(90.0)],
        [()] * 2,
        status,
        RATE,
    )
    assert ref.car == 1
    assert ref.rejected[0].reason == (
        "not green throughout - track status does not cover all of it"
    )


def test_no_qualifying_lap_fails_loudly_and_names_every_reason():
    with pytest.raises(NoReferenceLapError) as err:
        _select(
            ["RUS", "GAS"],
            [
                [_lap(1, 0.0, 88.0, race_lap_one=True), _lap(3, 88.0, NAN)],
                [_lap(3, 86.0, 190.0, pit_in=True)],
            ],
            [_fast(190.0), _fast(190.0)],
            [()] * 2,
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
        _select(["AAA"], [()], [_fast(90.0)], [()], GREEN_ALL, RATE)


@pytest.mark.parametrize(
    "laps, dropouts, positions, faults",
    [
        ([()], [(), ()], 2, 2),
        ([(), ()], [()], 2, 2),
        ([(), ()], [(), ()], 1, 2),
        ([(), ()], [(), ()], 2, 1),
    ],
    ids=["lap tables", "dropout lists", "position channels", "fault lists"],
)
def test_selection_needs_one_of_everything_per_car(laps, dropouts, positions, faults):
    with pytest.raises(TelemetryShapeError, match="one fault list per car") as err:
        _select(
            ["AAA", "BBB"], laps, [_fast(9.0)] * 2, dropouts, [], RATE,
            positions=[([0.0], [0.0])] * positions, faults=[()] * faults,
        )
    assert "2 drivers" in str(err.value)


# --- position faults: LAP-level, not car-level (Slice 24 follow-up) ----------------

#: RUS in the shipped red-flag window: lap 1 off the grid, lap 2 89.0-175.6 s, and
#: the car's ONE declined jump at t=290.6 s — in the pit lane under red, 115 s after
#: the lap the car-level rule denied it. VER's lap 2 is what that rule chose instead.
_RUS_LAPS = [_lap(1, 0.0, 88.8, race_lap_one=True), _lap(2, 89.0, 175.6)]
_VER_LAPS = [_lap(1, 0.0, 89.7, race_lap_one=True), _lap(2, 89.9, 177.1)]


def _jump(at: float, to: float) -> PositionFault:
    return PositionFault(FAULT_DECLINED_JUMP, at, to)


def _rus_and_ver(rus_faults):
    return _select(
        ["RUS", "VER"], [_RUS_LAPS, _VER_LAPS], [_fast(294.7)] * 2, [()] * 2,
        GREEN_ALL, RATE, faults=[rus_faults, ()],
    )


def test_a_fault_outside_a_lap_keeps_that_lap():
    """THE ruling: a car whose plan was declined keeps every lap clear of its
    faults. The red-flag window's own shape — RUS's lap 2 is the reference."""
    ref = _rus_and_ver((_jump(290.573, 290.733),))
    assert (ref.driver, ref.number, ref.from_t, ref.to_t) == ("RUS", 2, 89.0, 175.6)
    assert [r.number for r in ref.rejected] == [1]


def test_a_fault_inside_a_lap_loses_that_lap_by_name():
    """The same car, the fault moved into the lap: passed over, the fault and its
    time named, and the next car's lap is the reference."""
    ref = _rus_and_ver((_jump(133.753, 133.886),))
    assert (ref.driver, ref.number) == ("VER", 2)
    assert ref.rejected[1] == Rejection(
        "RUS",
        2,
        f"within {POSITION_FAULT_MARGIN_S:g} s of a {FAULT_DECLINED_JUMP} at "
        "t=133.8-133.9 s - positions there are known corrupt",
    )


@pytest.mark.parametrize(
    "fault, kept",
    [
        (_jump(79.9, 80.05), False),  # ends 9.95 s before the lap
        (_jump(79.5, 80.0), True),  # ends exactly the margin before
        (_jump(185.45, 185.5), False),  # starts 9.95 s after the lap
        (_jump(185.5, 185.6), True),  # starts exactly the margin after
    ],
    ids=["just inside, before", "at the margin, before", "just inside, after",
         "at the margin, after"],
)
def test_the_margin_reaches_either_side_of_a_fault_and_no_further(fault, kept):
    """`POSITION_FAULT_MARGIN_S` either side, strictly — the dropouts' convention:
    a fault exactly the margin away reaches the lap's boundary sample and stops.
    Every boundary here is a binary-exact float, so "exactly" means exactly."""
    assert POSITION_FAULT_MARGIN_S == 10.0  # the rows above are written against it
    ref = _select(
        ["RUS"], [[_lap(2, 90.0, 175.5), _lap(3, 220.0, 300.0)]], [_fast(310.0)],
        [()], GREEN_ALL, RATE, faults=[(fault,)],
    )
    assert ref.number == (2 if kept else 3)


def test_the_earliest_fault_a_lap_reaches_is_the_one_named():
    """Faults arrive in any order; the report names the first in time, so a rerun
    prints the same line."""
    late = PositionFault(FAULT_SURRENDERED_RUN, 150.2, 151.0)
    early = PositionFault(FAULT_LEFT_REVERSAL, 120.04, 120.04)
    ref = _rus_and_ver((late, early))
    assert ref.rejected[1].reason == (
        f"within 10 s of a {FAULT_LEFT_REVERSAL} at t=120.0 s - positions there are "
        "known corrupt"
    )


def test_a_field_whose_every_lap_is_near_a_fault_fails_loudly():
    with pytest.raises(NoReferenceLapError, match="within 10 s of a declined"):
        _select(
            ["NOR"], [[_lap(26, 0.0, 85.0)]], [_fast(90.0)], [()], GREEN_ALL, RATE,
            faults=[(_jump(91.0, 91.2),)],
        )


# --- the closure mirror (REFERENCE_LAP_CLOSE_M) -------------------------------------


def _out_and_back(chord_units: float) -> "tuple[list[float], list[float]]":
    """801 positions at 36 km/h for 80 s: out 400 samples along x to the turn, back
    400 to `chord_units` from the start. The path is 800 units whatever the chord,
    against the 800 m the trapezoid integrates, so the bridge is one unit per metre
    and the closing chord reads in metres. At a chord of 25 every step is a
    multiple of 1/32, which binary floats hold exactly — "at the limit" is exact."""
    turn = (800.0 + chord_units) / 2.0
    out = np.arange(401) * (turn / 400.0)
    back = turn - np.arange(1, 401) * ((turn - chord_units) / 400.0)
    return np.concatenate([out, back]).tolist(), [0.0] * 801


@pytest.mark.parametrize(
    "chord, kept", [(25.0, True), (25.5, False)], ids=["at the limit", "just over"]
)
def test_a_lap_that_does_not_close_is_passed_over_as_the_loader_would(chord, kept):
    """The loader's check, mirrored: a span whose ends lie more than
    `REFERENCE_LAP_CLOSE_M` apart is not one lap, and the schema refuses it after
    the file is written. Refused here by name instead, and the next lap chosen."""
    assert REFERENCE_LAP_CLOSE_M == 25.0
    ref = _select(
        ["STR", "RUS"], [[_lap(7, 0.0, 80.0)], [_lap(7, 0.0, 80.0)]],
        [[36.0] * 801] * 2, [()] * 2, GREEN_ALL, RATE,
        positions=[_out_and_back(chord), _closing_positions([_lap(7, 0.0, 80.0)], 801)],
    )
    assert (ref.driver == "STR") is kept
    if not kept:
        assert ref.rejected == (
            Rejection(
                "STR",
                7,
                f"does not close - it ends {chord:.1f} m from where it began, over "
                "the 25 m the loader allows",
            ),
        )


# --- the cross-language pin ----------------------------------------------------------

#: The app's engine source, from `pipeline/tests/`. The repo is one checkout in CI and
#: on a human's machine, so reading the other language's file needs no network.
_ENGINE_SRC = Path(__file__).resolve().parents[2] / "app" / "src" / "engine"


def _ts_const(file: str, name: str, value: str) -> str:
    """The right-hand side of `export const <name> = <value>;` in the app's engine
    source, matched STRICTLY: exactly one line of exactly that shape. Anything else —
    a rename, a move, a computed value, a type annotation — fails here by name,
    rather than letting the pin quietly stop pinning."""
    path = _ENGINE_SRC / file
    found = re.findall(
        rf"^export const {name} = ({value});$", path.read_text(encoding="utf-8"), re.M
    )
    assert len(found) == 1, (
        f"expected exactly one `export const {name} = <{value}>;` line in "
        f"app/src/engine/{file}, found {len(found)}. The pipeline mirrors it by hand "
        "(replay_transform/contract.py) and this test is what compares the two: "
        "update the pattern with the constant, never delete it"
    )
    return found[0]


def test_the_closure_and_length_bounds_are_the_apps_own_constants():
    """`REFERENCE_LAP_CLOSE_M` and `REFERENCE_LAP_MIN_S` are mirrored by hand from
    the app (Slice 24 final review): each side pinned its own literal and nothing
    compared the two, so a drift would surface only as `validate_output` refusing a
    real network build. The app's names are aliases — `referenceLap.ts` sets them to
    `gaps.ts`'s `MAX_RESIDUAL_M` and `MIN_LAP_S` — so both links are read."""
    number = r"\d+(?:\.\d+)?"
    assert _ts_const("referenceLap.ts", "REFERENCE_LAP_CLOSE_M", r"\w+") == "MAX_RESIDUAL_M"
    assert _ts_const("referenceLap.ts", "REFERENCE_LAP_MIN_S", r"\w+") == "MIN_LAP_S"
    assert float(_ts_const("gaps.ts", "MAX_RESIDUAL_M", number)) == REFERENCE_LAP_CLOSE_M
    assert float(_ts_const("gaps.ts", "MIN_LAP_S", number)) == REFERENCE_LAP_MIN_S


def _str_then_rus(str_positions, str_speed):
    lap = _lap(7, 0.0, 80.0)
    return _select(
        ["STR", "RUS"], [[lap], [lap]], [str_speed, [250.0] * 801], [()] * 2,
        GREEN_ALL, RATE,
        positions=[str_positions, _closing_positions([lap], 801)],
    )


def test_the_closure_is_read_through_the_loaders_own_bridge():
    """Metres the way `referenceLapEnds` reads them: the car's path over the span
    against the TRAPEZOID speed integral (`gaps.ts`'s `travelIntegral`). A straight
    run's chord IS its path, so the closure reads the travel exactly — 5552.3 m with
    the launch sample counted half, where a plain sum of speeds would read 5556.0."""
    speed = [15.0] + [250.0] * 800
    ref = _str_then_rus(((np.arange(801) * 7.0).tolist(), [3.0] * 801), speed)
    assert ref.driver == "RUS"
    assert ref.rejected[0].reason.startswith("does not close - it ends 5552.3 m ")


def test_a_lap_whose_positions_never_move_is_passed_over_by_name():
    """A position channel frozen under a moving speed channel has no bridge and no
    lap; the loader calls it "covers no ground". Refused here, by name."""
    ref = _str_then_rus(([12.0] * 801, [-4.0] * 801), [250.0] * 801)
    assert (ref.driver, ref.rejected[0].reason) == (
        "RUS",
        "its positions cover no ground over it - the channel is frozen",
    )


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
    legacy = _standing_window(reference_laps=LEGACY_REFERENCE)
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
        synthetic.window_car("AAA", synthetic.standing_start_telemetry(*_WINDOW)),
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


def test_window_builder_has_no_default_reference_and_refuses_none():
    """The legacy line — the pole slot at angle 0.0 on a standing start — is reached
    only BY NAME. Forgetting the lap facts is a TypeError, not that line."""
    cars = [synthetic.window_car("AAA", synthetic.standing_start_telemetry(*_WINDOW))]
    with pytest.raises(TypeError, match="reference_laps"):
        build_window_replay_dict(cars, synthetic.SESSION_META, _WINDOW)
    with pytest.raises(TypeError, match="LEGACY_REFERENCE"):
        build_window_replay_dict(
            cars, synthetic.SESSION_META, _WINDOW, reference_laps=None
        )


def _with_dropout_in_lap_two() -> "dict[str, np.ndarray]":
    """The standing start with a saturated 9m freeze imposed 5 s into lap 2 — the
    same imposition `test_replay_transform`'s bridging test makes."""
    tel = synthetic.standing_start_telemetry(*_WINDOW)
    tau = np.asarray(tel["Time"], dtype=float) - _T0
    lo = int(np.flatnonzero(tau > _LAP1_END + 5.0)[0])
    hi = lo + max(STUCK_MIN_ROWS + 2, int(1.4 / (tau[1] - tau[0])))
    stuck = {name: np.asarray(col).copy() for name, col in tel.items()}
    stuck["Speed"][lo:hi] = 280.0
    stuck["Throttle"][lo:hi] = 104.0
    stuck["Brake"][lo:hi] = 1
    return stuck


def test_window_builder_hands_the_selector_each_cars_dropouts():
    """End to end: the 9m screen bridges AAA's lap 2, so the reference moves to
    BBB's identical, measured lap 2 — and the report, recomputing from the FILE
    (`cars[k].dropouts`), agrees."""
    cars = [
        synthetic.window_car("AAA", _with_dropout_in_lap_two()),
        synthetic.window_car("BBB", synthetic.standing_start_telemetry(*_WINDOW)),
    ]
    facts = [_standing_facts(), _standing_facts()]
    replay = build_window_replay_dict(
        cars, synthetic.SESSION_META, _WINDOW, reference_laps=facts
    )
    assert len(replay["cars"][0]["dropouts"]) == 1
    assert "dropouts" not in replay["cars"][1]
    assert replay["track"]["referenceLap"]["car"] == 1
    report = reference_lap_report(replay, facts, faults=_recomputed_faults(cars))
    assert "passed over AAA lap 2: overlaps a stuck-channel dropout" in report
    assert "cars[1] BBB lap 2:" in report
    assert "MISMATCH" not in report


def _recomputed_faults(cars) -> "dict[str, tuple[PositionFault, ...]]":
    """Each car's `position_faults`, recomputed the way `report_window` recomputes
    them — stuck bridge, repair, fix screen, reversal screen, anchor plan — so a
    report test hands over exactly what a real run would."""
    out = {}
    for car in cars:
        tel = car.telemetry
        stuck = detect_stuck_channels(
            tel["Time"], tel["Speed"], tel["Throttle"], tel["Brake"], tel["X"], tel["Y"]
        )
        bridged, anchors = bridge_stuck_channels(tel, stuck)
        t, v = bridged["Time"], bridged["Speed"]
        repair = repair_frame_displacements(t, bridged["X"], bridged["Y"], v)
        plan = window_anchor_plan(t, v, repair, car, _T0, stuck_anchors=anchors)
        out[car.driver] = position_faults(
            t,
            _T0,
            plan,
            repair,
            reject_impossible_fixes(t, repair.x, repair.y, v),
            reject_reversals(t, repair.x, repair.y, v),
        )
    return out


def _excursion(at_s: float, metres: float = 40.0, back_s: float = 1.5):
    """The standing start with a TRANSIENT frame excursion at window second `at_s` —
    the shape every 2026 declined car measured: one impossible step out, then a
    return spread over `back_s` that no single step betrays. The repair finds one
    jump with no partner and DECLINES the plan; positions rejoin the road after.
    Radial, so the excursion leaves the circle rather than sliding along it."""
    tel = synthetic.standing_start_telemetry(*_WINDOW)
    tau = np.asarray(tel["Time"], dtype=float) - _T0
    k = int(np.searchsorted(tau, at_s))
    reach = np.clip(1.0 - (tau - tau[k]) / back_s, 0.0, 1.0)
    reach[:k] = 0.0
    x = np.asarray(tel["X"], dtype=float)
    y = np.asarray(tel["Y"], dtype=float)
    out = metres * synthetic.SESSION_UNITS_PER_M * reach / np.hypot(x, y)
    return dict(tel, X=x * (1.0 + out), Y=y * (1.0 + out))


def _declined_excursion_window(at_s: float):
    cars = [
        synthetic.window_car("AAA", _excursion(at_s)),
        synthetic.window_car("BBB", synthetic.standing_start_telemetry(*_WINDOW)),
    ]
    facts = [_standing_facts(), _standing_facts()]
    replay = build_window_replay_dict(
        cars, synthetic.SESSION_META, _WINDOW, reference_laps=facts
    )
    faults = _recomputed_faults(cars)
    # The premise, asserted: ONE unpartnered jump, so a declined plan, and every
    # fault the car carries is the excursion's (its return also reads as a reversal
    # the withheld screen leaves in place).
    kinds = [f.kind for f in faults["AAA"]]
    assert kinds[0] == FAULT_DECLINED_JUMP and kinds.count(FAULT_DECLINED_JUMP) == 1
    assert all(abs(f.from_s - at_s) < 0.5 for f in faults["AAA"])
    assert faults["BBB"] == ()
    return replay, facts, faults


def test_window_builder_keeps_a_declined_cars_lap_clear_of_its_fault():
    """End to end, the ruling: AAA's plan is DECLINED by an excursion 16 s before
    lap 2 begins — the car-level rule would have handed the reference to BBB. Lap
    by lap, AAA's lap 2 is clear of it, so AAA (the first car) keeps the reference
    and the line; the report, handed the recomputed faults, agrees."""
    replay, facts, faults = _declined_excursion_window(8.0)
    assert _LAP1_END - 8.0 > POSITION_FAULT_MARGIN_S
    ref = replay["track"]["referenceLap"]
    assert ref["car"] == 0
    at = replay["cars"][0]["samples"][round(ref["fromT"] * RATE)]
    sf = replay["track"]["startFinish"]
    assert (sf["x"], sf["y"]) == (at["x"], at["y"])
    report = reference_lap_report(replay, facts, faults=faults)
    assert "cars[0] AAA lap 2:" in report and "MISMATCH" not in report


def test_window_builder_passes_over_a_lap_its_fault_lies_inside():
    """The same excursion moved INTO lap 2: AAA's lap 2 is passed over with the
    fault named, BBB's identical lap is the reference and the line. Handed no
    faults, the report recomputes AAA's lap as clean and is the loudest line it
    can print."""
    replay, facts, faults = _declined_excursion_window(_LAP1_END + 8.0)
    ref = replay["track"]["referenceLap"]
    assert ref["car"] == 1
    at = replay["cars"][1]["samples"][round(ref["fromT"] * RATE)]
    sf = replay["track"]["startFinish"]
    assert (sf["x"], sf["y"]) == (at["x"], at["y"])

    report = reference_lap_report(replay, facts, faults=faults)
    assert (
        f"passed over AAA lap 2: within 10 s of a {FAULT_DECLINED_JUMP} at t="
        in report
    )
    assert "cars[1] BBB lap 2:" in report and "MISMATCH" not in report
    assert "MISMATCH" in reference_lap_report(
        replay, facts, faults={"AAA": (), "BBB": ()}
    )


# --- position_faults ----------------------------------------------------------------

_TS = np.array([100.0, 100.2, 100.4, 100.6, 100.8, 101.0])


def _repair(jumps, repaired=False) -> FrameDisplacement:
    return FrameDisplacement(_TS, _TS, tuple(jumps), repaired, (), 30.0, 30.0, 5.0, None)


def _plan(declined: bool) -> AnchorPlan:
    return AnchorPlan(loop=(), pit=(), stuck=(), declined=declined)


def _fixes(surrendered=()) -> FixRejection:
    return FixRejection(np.ones(len(_TS), bool), (), 1.0, tuple(surrendered), False)


_REVERSALS = ReversalRejection(np.ones(len(_TS), bool), (100.6,))


def _spans(faults):
    return [(f.kind, round(f.from_s, 6), round(f.to_s, 6)) for f in faults]


def test_position_faults_of_a_declined_plan_name_every_kind_in_window_seconds():
    """A declined plan: each jump step from its row to the row it jumped to, each
    reversal the withheld screen would have removed, each surrendered run — rebased
    onto the window and earliest first, whatever order they arrive in."""
    faults = position_faults(
        _TS, 100.0, _plan(True), _repair([100.4, 100.0]),
        _fixes([(100.8, 101.0, 1.0)]), _REVERSALS,
    )
    assert _spans(faults) == [
        (FAULT_DECLINED_JUMP, 0.0, 0.2),
        (FAULT_DECLINED_JUMP, 0.4, 0.6),
        (FAULT_LEFT_REVERSAL, 0.6, 0.6),
        (FAULT_SURRENDERED_RUN, 0.8, 1.0),
    ]


def test_position_faults_of_an_undeclined_car_are_only_its_surrenders():
    """No declined plan, no jump or reversal fault: a repaired displacement was
    translated back and a reversal was removed and bridged — repairs, not faults.
    A surrender is the fix screen KEEPING bad fixes, and is a fault whoever has it."""
    repaired = position_faults(
        _TS, 100.0, _plan(False), _repair([100.2, 100.6], repaired=True),
        _fixes([(100.2, 100.4, 1.0)]), _REVERSALS,
    )
    assert _spans(repaired) == [(FAULT_SURRENDERED_RUN, 0.2, 0.4)]
    assert position_faults(
        _TS, 100.0, _plan(False), _repair([]), _fixes(), _REVERSALS
    ) == ()


def test_a_jump_on_the_last_row_ends_there():
    """An adjudicated step is admitted by its time and could name the last row; its
    fault then ends where the rows do instead of reading past them."""
    faults = position_faults(
        _TS, 100.0, _plan(True), _repair([101.0]), _fixes(), _REVERSALS
    )
    assert _spans(faults)[-1] == (FAULT_DECLINED_JUMP, 1.0, 1.0)


def test_a_fault_prints_a_point_or_a_range():
    assert PositionFault("x", 290.57, 290.73).at() == "290.6-290.7"
    assert PositionFault("x", 120.04, 120.04).at() == "120.0"
    assert PositionFault("x", 120.01, 120.04).at() == "120.0"


# --- the report ---------------------------------------------------------------------


def test_reference_lap_report_recomputes_the_choice_from_the_file():
    replay = _standing_window()
    report = reference_lap_report(replay, [_standing_facts()], faults={"AAA": ()})
    assert "cars[0] AAA lap 2:" in report
    assert "FALLBACK - no qualifying lap is green throughout" in report
    assert "passed over AAA lap 1: race lap 1" in report
    assert "start/finish:" in report
    assert "MISMATCH" not in report


def test_reference_lap_report_names_a_green_choice():
    green = [{"status": "green", "fromT": 0.0, "toT": round(_LAP2_END + 0.1, 3)}]
    replay = _standing_window(status=green)
    report = reference_lap_report(replay, [_standing_facts()], faults={"AAA": ()})
    assert "green throughout" in report and "FALLBACK" not in report


def test_reference_lap_report_is_loudest_when_the_file_disagrees():
    replay = _standing_window()
    replay["track"]["referenceLap"] = dict(replay["track"]["referenceLap"], toT=1.0)
    assert "MISMATCH" in reference_lap_report(
        replay, [_standing_facts()], faults={"AAA": ()}
    )


def test_reference_lap_report_requires_every_cars_faults():
    """No default, and none per driver: a forgotten list would re-admit a lap the
    builder passed over, and the MISMATCH line would then blame the lap facts."""
    with pytest.raises(TypeError, match="faults"):
        reference_lap_report(_standing_window(), [_standing_facts()])
    with pytest.raises(KeyError, match="AAA"):
        reference_lap_report(_standing_window(), [_standing_facts()], faults={})
