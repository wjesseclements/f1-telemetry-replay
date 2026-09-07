"""
lap_context.py — laps and stints (Slice 14): the schema's lap-context shape.

Split verbatim from `replay_transform.py` in Slice 9i Phase 0; no behaviour change.
"""

from __future__ import annotations

import math
from typing import Any, Sequence

import numpy as np

from .contract import TelemetryShapeError

# --- laps and tyres (Slice 14) ----------------------------------------------------

#: The compounds the schema names, 2024-era. Anything else the lap table says —
#: historical HYPERSOFT/ULTRASOFT, test-session codes, missing data — is mapped to
#: UNKNOWN_COMPOUND here, in the pipeline, and announced by `stint_report`; the
#: app's schema then rejects arbitrary strings the way it rejects a `loop` typo.
#: Degrade at the emitter, fail loudly at the loader.
KNOWN_COMPOUNDS = ("SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET")
UNKNOWN_COMPOUND = "UNKNOWN"


def normalise_compound(value: Any) -> str:
    """A lap-table compound as the schema spells it, or UNKNOWN_COMPOUND."""
    if isinstance(value, str) and value.upper() in KNOWN_COMPOUNDS:
        return value.upper()
    return UNKNOWN_COMPOUND


def lap_context(
    numbers: "Sequence[Any]",
    starts_s: "Sequence[float]",
    lap_times_s: "Sequence[float]",
    compounds: "Sequence[Any]",
    tyre_lives: "Sequence[float]",
    window: "tuple[float, float]",
) -> "tuple[list[dict], list[dict]]":
    """
    A car's `laps` and `stints` for one window, in the schema's emitted form.

    Inputs are the lap table's columns as plain arrays (LapNumber, LapStartTime and
    LapTime in session seconds, Compound, TyreLife) — pandas stays in the fetch
    layer. `window` is the same `(t0, t1)` the builders already use, and `startT`
    is the same subtraction the reports already do (`start - t0`, rounded like a
    sample's `t`). The FIRST kept lap's `startT` is commonly NEGATIVE for a
    non-reference car: its lap-in-progress at t0 began before the window, and the
    true value is emitted rather than a clamp that would lie about the lap.

    A lap is kept when its interval intersects the window. A lap's end is its
    start plus its LapTime; when LapTime is missing (a retirement, a red flag)
    the next lap's start stands in, and a missing end on the last lap keeps the
    lap — a car that never finished its final lap was still on it.

    Stints are inferred from Compound and TyreLife, the columns the schema's
    fields come from: a new stint starts where the compound changes, or where
    TyreLife fails to grow (a fresh or different set of the same compound).
    `ageAtStart` is TyreLife minus one — TyreLife counts the lap in progress
    (verified against 2024 Silverstone R: a fresh set's first lap reads 1), while
    the displayed age counts laps COMPLETED on the set — and is omitted when
    TyreLife is missing: an unknown age is not a fresh set.

    Rows with a missing LapStartTime are dropped first: a lap that cannot be
    placed on the clock cannot answer `lapAt`.
    """
    t0, t1 = float(window[0]), float(window[1])
    starts = np.asarray(starts_s, dtype=float)
    times = np.asarray(lap_times_s, dtype=float)
    lives = np.asarray(tyre_lives, dtype=float)
    if not (len(numbers) == len(starts) == len(times) == len(compounds) == len(lives)):
        raise TelemetryShapeError(
            "lap table columns disagree about the number of laps"
        )

    placeable = np.isfinite(starts)
    idx = [int(i) for i in np.flatnonzero(placeable)]
    if any(
        starts[b] <= starts[a] or int(numbers[b]) <= int(numbers[a])
        for a, b in zip(idx, idx[1:])
    ):
        raise TelemetryShapeError(
            "lap table must be strictly increasing in LapNumber and LapStartTime"
        )

    kept: "list[tuple[int, float, str, float]]" = []
    for pos, i in enumerate(idx):
        if np.isfinite(times[i]):
            end = float(starts[i] + times[i])
        elif pos + 1 < len(idx):
            end = float(starts[idx[pos + 1]])
        else:
            end = math.inf
        if starts[i] < t1 and end > t0:
            kept.append(
                (int(numbers[i]), float(starts[i]), normalise_compound(compounds[i]), float(lives[i]))
            )

    laps = [{"number": n, "startT": round(start - t0, 3)} for n, start, _, _ in kept]

    stints: "list[dict]" = []
    prev_compound: "str | None" = None
    prev_life = math.nan
    for n, _, compound, life in kept:
        fresh_set = np.isfinite(life) and np.isfinite(prev_life) and life <= prev_life
        if compound != prev_compound or fresh_set:
            stint: "dict[str, Any]" = {"compound": compound, "fromLap": n, "toLap": n}
            if np.isfinite(life):
                stint["ageAtStart"] = max(0, int(round(life)) - 1)
            stints.append(stint)
        else:
            stints[-1]["toLap"] = n
        prev_compound, prev_life = compound, life

    return laps, stints
