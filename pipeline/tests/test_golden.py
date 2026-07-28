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
from replay_transform import build_replay_dict, dump_json

GOLDEN_DIR = Path(__file__).parent / "golden"

#: name -> the exact call that produced the committed file.
CASES = {
    "lap-drs": dict(drs=True, meta=synthetic.META),
    "lap-nodrs": dict(drs=False, meta=synthetic.META_NO_DRS),
}


def generate(name: str) -> "dict":
    case = CASES[name]
    return build_replay_dict(
        synthetic.telemetry(drs=case["drs"]),
        case["meta"],
        corners=synthetic.CORNERS,
    )


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


def test_the_two_goldens_cover_both_drs_shapes():
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
