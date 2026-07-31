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
from pathlib import Path

import pytest

import synthetic
from replay_transform import build_replay_dict, build_window_replay_dict, dump_json

GOLDEN_DIR = Path(__file__).parent / "golden"

#: A short synthetic race window. Kept to a few seconds for the same reason the lap
#: goldens are 3.1 s: a golden is read in a diff, and three cars multiply everything.
RACE_WINDOW = (synthetic.SESSION_T0, synthetic.SESSION_T0 + 4.0)


def _lap(drs: bool, meta) -> "dict":
    return build_replay_dict(
        synthetic.telemetry(drs=drs), meta, corners=synthetic.CORNERS
    )


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
    """
    start, end = RACE_WINDOW
    return build_window_replay_dict(
        [
            synthetic.window_car("AAA", synthetic.session_telemetry(start, end)),
            synthetic.window_car(
                "BBB", synthetic.session_telemetry(start, end - 1.0, offset_s=1.5)
            ),
            synthetic.window_car("CCC", synthetic.parked_telemetry(start, end)),
        ],
        synthetic.SESSION_META,
        RACE_WINDOW,
        corners=synthetic.CORNERS,
    )


#: name -> the exact call that produced the committed file.
CASES = {
    "lap-drs": lambda: _lap(True, synthetic.META),
    "lap-nodrs": lambda: _lap(False, synthetic.META_NO_DRS),
    "race-window": _race_window,
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


def test_the_lap_goldens_stay_closed_and_the_race_golden_open():
    """`meta.loop` is what tells the engine whether to run the last sample back to
    the first. Getting it backwards is invisible until the loop point."""
    for name in ("lap-drs", "lap-nodrs"):
        replay = json.loads((GOLDEN_DIR / f"{name}.golden.json").read_text())
        assert replay["meta"]["loop"] == "closed"
        assert len(replay["cars"]) == 1
