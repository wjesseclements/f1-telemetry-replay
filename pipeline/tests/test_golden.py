"""
The golden ratchet.

`tests/golden/*.json` are real `build_replay_dict` output, committed, and read by
`app/src/data/pipelineContract.test.ts`, which runs them through the app's actual
`parseReplay`. That vitest check is what proves pipeline output satisfies the schema
without anyone touching the network — but on its own it is blind to a stale golden:
change the pipeline, leave the goldens alone, and it happily re-validates yesterday's
output forever.

This module closes that hole. It regenerates both goldens and compares them to what
is committed, so a behaviour change that has not been re-recorded fails here.

WHAT THE EQUALITY MEANS
-----------------------
Structural equality of PARSED JSON — `generated == json.loads(text)` — never file
bytes. Byte equality would make the ratchet hostage to `json.dump` key ordering and
float repr, so a formatting change in some future Python would read as a pipeline
behaviour change. Structural equality is stable because `build_samples` rounds every
emitted number (`t` 3 dp, `x`/`y` 1 dp, the rest integers), which is far coarser than
any last-ulp difference `np.interp` could develop between numpy versions.

The files are nonetheless WRITTEN through `dump_json` (sorted keys, 2-space indent)
so that a refreshed golden produces a reviewable line-by-line diff instead of one
40 KB line. That is a diff-readability concern and it is not what is asserted here.

To refresh after an intentional pipeline change:  python tests/regenerate_golden.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

import synthetic
from replay_transform import (
    LEGACY_REFERENCE,
    SAMPLE_RATE_HZ,
    build_replay_dict,
    build_window_replay_dict,
    dump_json,
    lap_context,
    lap_facts,
    window_grid,
    window_status_intervals,
)

GOLDEN_DIR = Path(__file__).parent / "golden"

#: A short synthetic race window. Kept to a few seconds for the same reason the lap
#: goldens are only 6 s (`synthetic.LAP_GOLDEN_S`): a golden is read in a diff, and
#: three cars multiply everything.
RACE_WINDOW = (synthetic.SESSION_T0, synthetic.SESSION_T0 + 4.0)


def _lap(drs: bool, meta, table) -> "dict":
    # The lap context goes through the real `lap_context`, exactly as
    # `build_lap_replay` routes it, so the goldens pin that function's output and
    # not a hand-written imitation of it.
    laps, stints = lap_context(*table, (0.0, synthetic.LAP_GOLDEN_S))
    return build_replay_dict(
        synthetic.telemetry(duration_s=synthetic.LAP_GOLDEN_S, drs=drs),
        meta, corners=synthetic.CORNERS, laps=laps, stints=stints,
    )


def _facts(table, window, standing_start: bool = True) -> "tuple":
    """A synthetic lap table as `LapFacts`, through the real `lap_facts`, exactly as
    `build_race_replay` routes a FastF1 table — no lap of these tables went through
    the pit lane, so both pit columns are NaN, and every lap's timing is vouched for
    (`IsAccurate` True), so what the goldens pin is the selector's own rule."""
    numbers, starts, times, _, _ = table
    nan = [math.nan] * len(numbers)
    accurate = [True] * len(numbers)
    return lap_facts(numbers, starts, times, nan, nan, accurate, standing_start, window)


def _window_context(driver: str) -> "tuple[list, list]":
    """A synthetic driver's `(laps, stints)` for RACE_WINDOW — CCC has none."""
    table = synthetic.SESSION_LAP_TABLES.get(driver)
    return ([], []) if table is None else lap_context(*table, RACE_WINDOW)


def _race_window() -> "dict":
    """
    Three cars chosen to be UNLIKE each other, because a golden of three identical
    cars would prove only that the loop runs three times:

    * AAA — the reference: full coverage, moving throughout.
    * BBB — telemetry stops a second before the window does (a retirement), so the
      committed file records what clamping actually emits rather than what it is
      assumed to.
    * CCC — parked in its box for the whole window: zero speed, jittering fixes. The
      `covers_ground` branch, and the one car in the file whose positions were held
      rather than placed along a path.

    CCC also carries an all-zero DRS channel while the others use theirs, so the file
    pins the replay-level DRS decision: every car gets the key, including the one
    that never opened it.

    The window also carries `SESSION_STATUS` through the real
    `window_status_intervals`, exactly as `build_race_replay` routes it, so the
    golden pins the carried-in status, the VSC merge and the holding-step
    extension cross-language rather than a hand-written imitation of them.
    """
    start, end = RACE_WINDOW
    # The emitted duration, derived from the builder's own grid rather than
    # re-implemented — this is exactly the value `build_race_replay` hands over.
    grid, _ = window_grid(start, end)
    duration = round(len(grid) / SAMPLE_RATE_HZ, 3)
    status = window_status_intervals(
        *synthetic.SESSION_STATUS, RACE_WINDOW, duration
    ).intervals
    return build_window_replay_dict(
        [
            synthetic.window_car(
                "AAA",
                synthetic.session_telemetry(start, end),
                *_window_context("AAA"),
            ),
            synthetic.window_car(
                "BBB",
                synthetic.session_telemetry(start, end - 1.0, offset_s=1.5),
                *_window_context("BBB"),
            ),
            synthetic.window_car("CCC", synthetic.parked_telemetry(start, end)),
        ],
        synthetic.SESSION_META,
        RACE_WINDOW,
        corners=synthetic.CORNERS,
        status=status,
        # 4 s cannot hold a lap, so this golden opts into the pre-Slice-24 line BY
        # NAME and carries no `referenceLap`: the committed negative control for the
        # app's legacy synthesis.
        reference_laps=LEGACY_REFERENCE,
    )


def _pit_window() -> "dict":
    """
    Two cars, one pit lane (Slice 16): AAA is the clean reference whose single
    whole lap is the detector's racing line; BBB leaves the circle onto the
    asymmetric dogleg, stops at its elbow, and rejoins — so the committed file
    carries a `track.pitLane` whose every point is a sample BBB drove. Kept to
    one lap and two cars for the same diffability reason RACE_WINDOW is 4 s.

    It is also the golden that carries an explicit `track.referenceLap` from the
    WINDOW builder (Slice 24): the lap facts go through the real `lap_facts` and
    `select_reference_lap`, AAA's lap 21 qualifies (whole, clean, no stop) and BBB
    has no lap table. The window has no status feed, so the choice lands in the
    fallback tier — the shape a status-less window really takes. RACE_WINDOW
    stays without one on purpose: at 4 s it cannot hold a lap, so it is the
    committed negative control for the loader's legacy synthesis.
    """
    start, end = synthetic.PIT_WINDOW
    return build_window_replay_dict(
        [
            synthetic.window_car(
                "AAA",
                synthetic.session_telemetry(start, end),
                *lap_context(*synthetic.PIT_LAP_TABLE_REF, synthetic.PIT_WINDOW),
            ),
            synthetic.window_car(
                "BBB", synthetic.pit_session_telemetry(start, end)
            ),
        ],
        synthetic.SESSION_META,
        synthetic.PIT_WINDOW,
        corners=synthetic.CORNERS,
        reference_laps=[
            _facts(synthetic.PIT_LAP_TABLE_REF, synthetic.PIT_WINDOW),
            (),
        ],
    )


def _standing_window() -> "dict":
    """
    One car from a STANDING START (Slice 24): parked on its grid slot, launched,
    across the timing line `synthetic.STANDING_LINE_M` later, and round twice — the
    red-flag asset's shape, in closed form.

    It is the one golden whose `track.referenceLap` the app's legacy synthesis could
    NOT have produced. Lap 1 is the race's lap 1 and is passed over by name, so the
    chosen lap is lap 2 with `fromT` > 0, and `startFinish` sits on the timing line
    rather than the slot. Every other golden's field equals what the loader would
    synthesize without it (`{0, 0, ...}`), which left `pipelineContract.test.ts`'s
    "survives parseReplay" assertion unable to fail — mutation-proven by the review
    of the contract half. This one can.

    A green status covers the window through the real `window_status_intervals`, so
    the choice lands in the GREEN tier; the pit golden pins the fallback tier.
    """
    start, end = synthetic.STANDING_WINDOW
    grid, _ = window_grid(start, end)
    duration = round(len(grid) / SAMPLE_RATE_HZ, 3)
    status = window_status_intervals(
        [start - 5.0], ["1"], synthetic.STANDING_WINDOW, duration
    ).intervals
    return build_window_replay_dict(
        [
            synthetic.window_car(
                "AAA",
                synthetic.standing_start_telemetry(start, end),
                *lap_context(*synthetic.STANDING_LAP_TABLE, synthetic.STANDING_WINDOW),
            ),
        ],
        synthetic.SESSION_META,
        synthetic.STANDING_WINDOW,
        corners=synthetic.CORNERS,
        status=status,
        reference_laps=[
            _facts(synthetic.STANDING_LAP_TABLE, synthetic.STANDING_WINDOW),
        ],
    )


#: name -> the exact call that produced the committed file.
CASES = {
    "lap-drs": lambda: _lap(True, synthetic.META, synthetic.LAP_TABLE_DRS),
    "lap-nodrs": lambda: _lap(False, synthetic.META_NO_DRS, synthetic.LAP_TABLE_NODRS),
    "race-window": _race_window,
    "race-window-pit": _pit_window,
    "race-window-standing": _standing_window,
}


def generate(name: str) -> "dict":
    return CASES[name]()


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden_is_current(name):
    path = GOLDEN_DIR / f"{name}.golden.json"
    assert path.is_file(), (
        f"{path} is missing; regenerate it with `python tests/regenerate_golden.py`"
    )
    committed = json.loads(path.read_text())
    assert generate(name) == committed, (
        f"{path.name} no longer matches what the pipeline produces. If the change was "
        "intentional, refresh it with `python tests/regenerate_golden.py` — that also "
        "re-runs the app's schema check over the new output in CI."
    )


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden_is_written_canonically(name):
    """A hand-edited golden would diff badly forever; keep them machine-formatted."""
    path = GOLDEN_DIR / f"{name}.golden.json"
    assert path.read_text() == dump_json(json.loads(path.read_text()))


def test_the_two_lap_goldens_cover_both_drs_shapes():
    """
    They are not near-duplicates. `drs` present on every sample and absent from every
    sample are two different shapes the schema treats differently, and the 2026+ path
    would otherwise ship untested.
    """
    with_drs = json.loads((GOLDEN_DIR / "lap-drs.golden.json").read_text())
    without = json.loads((GOLDEN_DIR / "lap-nodrs.golden.json").read_text())
    assert all("drs" in s for s in with_drs["cars"][0]["samples"])
    assert any(s["drs"] != 0 for s in with_drs["cars"][0]["samples"])
    assert all("drs" not in s for s in without["cars"][0]["samples"])


def test_the_race_golden_is_a_shared_grid_of_unlike_cars():
    """
    The v2 shape, asserted on committed output rather than on a fresh build: one
    open window, three cars, one grid. Each clause is a different thing that would
    otherwise only be true in a unit test's memory.
    """
    race = json.loads((GOLDEN_DIR / "race-window.golden.json").read_text())

    assert race["meta"]["loop"] == "open"
    assert [car["driver"] for car in race["cars"]] == ["AAA", "BBB", "CCC"]

    # One grid: equal counts, and identical `t` sample-for-sample.
    lengths = {len(car["samples"]) for car in race["cars"]}
    assert len(lengths) == 1
    times = [[s["t"] for s in car["samples"]] for car in race["cars"]]
    assert times[0] == times[1] == times[2]

    # ...and the cars are genuinely different data, not three copies.
    positions = [
        {(s["x"], s["y"]) for s in car["samples"]} for car in race["cars"]
    ]
    assert positions[0] != positions[1]
    # CCC was parked: held to a handful of jittering fixes, never a lap's worth.
    assert len(positions[2]) < len(positions[0])

    # DRS is the replay's decision: CCC never opened it and still carries the key.
    assert all(
        "drs" in s for car in race["cars"] for s in car["samples"]
    )
    assert all(s["drs"] == 0 for s in race["cars"][2]["samples"])


def test_the_goldens_cover_the_lap_and_stint_shapes():
    """
    Slice 14's per-car fields, pinned on committed output with three cars that are
    deliberately unlike (see `synthetic.SESSION_LAP_TABLES`): a mid-window compound
    change, a stint with no age, and a car with no lap data at all. The two lap
    goldens split the compound paths the same way: known SOFT with an age, and the
    UNKNOWN mapping with the age omitted.
    """
    race = json.loads((GOLDEN_DIR / "race-window.golden.json").read_text())
    aaa, bbb, ccc = race["cars"]

    # AAA: the lap in progress at the window start carries its true, NEGATIVE startT,
    # and the compound changes mid-window.
    assert [lap["number"] for lap in aaa["laps"]] == [12, 13]
    assert aaa["laps"][0]["startT"] == -18.0
    assert aaa["laps"][1]["startT"] == 2.0
    assert aaa["stints"] == [
        {"compound": "MEDIUM", "fromLap": 12, "toLap": 12, "ageAtStart": 5},
        {"compound": "SOFT", "fromLap": 13, "toLap": 13, "ageAtStart": 0},
    ]

    # BBB: a lap that never ended in the data is still the lap the car was on, and
    # an unknown TyreLife is an OMITTED age, not a zero.
    assert [lap["number"] for lap in bbb["laps"]] == [12]
    assert bbb["stints"] == [{"compound": "HARD", "fromLap": 12, "toLap": 12}]

    # CCC: no lap data — the keys are still emitted, empty.
    assert ccc["laps"] == [] and ccc["stints"] == []

    with_drs = json.loads((GOLDEN_DIR / "lap-drs.golden.json").read_text())
    without = json.loads((GOLDEN_DIR / "lap-nodrs.golden.json").read_text())
    assert with_drs["cars"][0]["laps"] == [{"number": 7, "startT": 0.0}]
    assert with_drs["cars"][0]["stints"] == [
        {"compound": "SOFT", "fromLap": 7, "toLap": 7, "ageAtStart": 2}
    ]
    assert without["cars"][0]["stints"] == [
        {"compound": "UNKNOWN", "fromLap": 7, "toLap": 7}
    ]


def test_the_lap_goldens_stay_closed_and_the_race_golden_open():
    """`meta.loop` is what tells the engine whether to run the last sample back to
    the first. Getting it backwards is invisible until the loop point."""
    for name in ("lap-drs", "lap-nodrs"):
        replay = json.loads((GOLDEN_DIR / f"{name}.golden.json").read_text())
        assert replay["meta"]["loop"] == "closed"
        assert len(replay["cars"]) == 1


def test_the_standing_golden_carries_a_reference_lap_the_loader_could_not_invent():
    """The committed half of the cross-language check: `pipelineContract.test.ts`
    asserts this file's field survives `parseReplay` and differs from the legacy
    synthesis; this asserts, on the same committed bytes, that there is something to
    differ — a lap that starts after the window opens, on the line, not the slot."""
    replay = json.loads((GOLDEN_DIR / "race-window-standing.golden.json").read_text())
    ref = replay["track"]["referenceLap"]
    rate = replay["meta"]["sampleRateHz"]
    assert ref["car"] == 0 and ref["fromT"] > 0.0
    at = replay["cars"][0]["samples"][round(ref["fromT"] * rate)]
    sf = replay["track"]["startFinish"]
    assert (sf["x"], sf["y"]) == (at["x"], at["y"])
    assert sf["angle"] != 0.0
    # Lap 1 began on the grid slot, parked: the legacy line's spot, not this one.
    slot = replay["cars"][0]["samples"][0]
    assert slot["speed"] == 0 and (slot["x"], slot["y"]) != (sf["x"], sf["y"])
