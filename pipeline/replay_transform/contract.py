"""
contract.py — the schema mirror, and column/value hygiene.

The constants below are mirrored from `app/src/engine/schema.ts` (the requirements
document for this package — see `__init__.py`), plus the checks that make dirty
upstream values conform before any maths runs. Split verbatim from
`replay_transform.py` in Slice 9i Phase 0; no behaviour change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np

# --- contract constants (mirrored from app/src/engine/schema.ts) -------------------

#: Bump only for a BREAKING contract change. Must match `SCHEMA_VERSION` in schema.ts.
SCHEMA_VERSION = 1

#: The engine's thermal colour stops are calibrated in km/h; the schema pins the unit.
SPEED_UNIT = "km/h"

#: `meta.loop` — whether the samples form a CYCLE or an open segment. Mirrored from
#: `LOOP_MODES` in schema.ts, which rejects anything else.
#:
#: A lap closes: the segment leaving the last sample runs back to the first, because
#: that is where the car went. A session-time WINDOW does not, and cannot — several
#: cars do not simultaneously return to their starting positions — so the app holds
#: the last sample for the final grid step instead of gliding back to the start.
#:
#: This single fact is what separates the two builders below. It also decides, on its
#: own, that a window needs neither `closing_time` nor `source_times`: both exist only
#: to give the app's cyclic wrap step a full step of travel, and an open window has no
#: cyclic wrap step. See `build_window_replay_dict`.
LOOP_CLOSED = "closed"
LOOP_OPEN = "open"

#: FastF1's merged telemetry lands at roughly 4-10 Hz, so 10 Hz is the finest grid
#: that does not invent resolution. It also matches the committed app fixture, which
#: keeps "what the app was built against" and "what the pipeline emits" the same shape.
SAMPLE_RATE_HZ = 10

#: Used when a team colour is missing or malformed — the schema's hex regex rejects
#: anything else, and a colour lookup is not worth failing a fetch over.
#:
#: ACHROMATIC ON PURPOSE, and this is the whole point of the constant. It was
#: `#3671C6` — the hex widely published as Red Bull's brand blue — so a failed lookup
#: rendered as a plausible Red Bull lap, and that is precisely why the always-failing
#: `fastf1.plotting` lookup (one missing import, fixed in PR #31) survived a whole
#: slice unnoticed: the wrong output looked right.
#:
#: The replacement has to clear two bars at once, which exclude different things.
#: It must not read as a LIVERY: every F1 team colour is a saturated hue, and no
#: current livery occupies mid-grey (silver and white are high-value, near-white).
#: And it must not read as a DELIBERATE CHOICE either, which is what rules out the
#: loud alternatives — a magenta is unmistakably not a livery, but sat on a dark
#: canvas beside three team colours it reads as "selected". A desaturated mid grey is
#: what every UI already means by "no value". Pinned by test, r == g == b.
DEFAULT_COLOR = "#888888"

_HEX_COLOR = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

#: Channels the replay cannot be built without.
REQUIRED_COLUMNS = ("Time", "X", "Y", "Speed", "Throttle", "Brake", "nGear")

#: Season-dependent indicator channels. Absent is not an error: DRS is removed in
#: 2026 with no published replacement, and CLAUDE.md rule 8 forbids treating it as a
#: core field or branching on the year. A missing DRS column and an all-zero one are
#: handled identically — the `drs` key is simply omitted from the output.
OPTIONAL_COLUMNS = ("DRS",)


class TelemetryShapeError(ValueError):
    """Raised when source telemetry cannot produce a schema-conforming replay."""


class MissingColumnsError(TelemetryShapeError):
    """Raised when the loaded session lacks channels the replay needs."""


@dataclass(frozen=True)
class ReplayMeta:
    """The non-telemetry facts about a lap, gathered by the fetch layer."""

    year: int
    event: str
    session: str
    track: str
    driver: str
    team: str
    color: str
    #: Degrees, from FastF1 `circuit_info`. Applied by the app at render time; stored
    #: x/y are never rotated here (schema.ts documents this split).
    rotation: float


# --- column and value hygiene -----------------------------------------------------


def check_columns(columns: Iterable[str]) -> None:
    """
    Verify the loaded telemetry carries every required channel.

    Called before any channel is read, so a FastF1 upgrade that renames a column
    produces a named list rather than a `KeyError` from the middle of the maths.
    """
    present = set(columns)
    missing = [name for name in REQUIRED_COLUMNS if name not in present]
    if missing:
        raise MissingColumnsError(
            "telemetry is missing required channel(s): "
            + ", ".join(missing)
            + f"; got: {', '.join(sorted(present))}"
        )


def normalise_color(value: Any, fallback: str = DEFAULT_COLOR) -> str:
    """Coerce a team colour to the `#rgb`/`#rrggbb` the schema accepts."""
    if not isinstance(value, str):
        return fallback
    candidate = value.strip()
    if not candidate.startswith("#"):
        candidate = "#" + candidate
    return candidate if _HEX_COLOR.match(candidate) else fallback


def color_lookup_warning(driver: str, err: BaseException) -> str:
    """
    The line printed when a team-colour lookup fails, in the house tripwire format.

    LOUD, NOT FATAL — the volume moved, the handling did not. A colour is still not
    worth failing a fetch over, so the `except` in `build_replay.py` stays broad and
    stays non-fatal. What changed is the conditions: before PR #31 this fired on every
    single run, where a banner would have been pure noise and a quiet line was right.
    It should now never fire, so if it does it is NEW — either FastF1 moved its API
    again (the defect PR #31 fixed, returning) or a team is missing from the colour
    map. Both silently paint every car in the file `DEFAULT_COLOR`.

    The exception TYPE is reported alongside its message because `AttributeError` and
    `KeyError` are those two different diagnoses, and they have different fixes.

    It lives in this module, not next to the `except` that uses it, for the reason
    Slice 8 recorded when it moved `parse_lap_range`: `build_replay.py` imports FastF1,
    which CI does not install, so nothing in it can be tested — and a warning whose
    text is wrong is itself a quiet failure.
    """
    return (
        f"\nWARNING: {driver}: team colour lookup failed "
        f"({type(err).__name__}: {err}); "
        f"falling back to {DEFAULT_COLOR}, which is not a livery.\n"
    )


def clamp_throttle(values: Any) -> np.ndarray:
    """
    Clamp throttle into the schema's 0-100.

    Speed is NOT clamped: an out-of-range speed is impossible rather than merely
    dirty, so the right outcome is the schema rejecting it loudly, not the
    pipeline hiding it. Gear once carried the same claim — `normalise_gear` says
    what measurement did to it.
    """
    return np.clip(np.asarray(values, dtype=float), 0.0, 100.0)


def normalise_gear(values: Any) -> np.ndarray:
    """
    Round gear to int and send anything outside 0-8 to 0 (neutral).

    This module used to claim an out-of-range gear was "impossible rather than
    merely dirty" and left it to the schema to reject. The 2026 Italian GP measured
    that claim away: LEC's wrecked car streamed an nGear channel that counts
    monotonically 0→128 while parked at idle — garbage from a damaged gearbox, not
    a gear. Clamping to 8 would invent a parked car in top gear; zero is the one
    in-range value that claims nothing ("no gear engaged"), the same honesty as
    UNKNOWN compounds and "unknown" flags. `gear_anomaly_warning` puts the count in
    the report, so a corrupt channel announces itself there, never in the browser.
    """
    gears = np.rint(np.asarray(values, dtype=float)).astype(int)
    return np.where((gears >= 0) & (gears <= 8), gears, 0)


def count_out_of_range_gears(values: Any) -> int:
    """How many source gear readings `normalise_gear` would zero out."""
    gears = np.rint(np.asarray(values, dtype=float)).astype(int)
    return int(np.count_nonzero((gears < 0) | (gears > 8)))


def gear_anomaly_warning(driver: str, count: int) -> str:
    """The report line for a corrupt gear channel. Call only when `count` > 0."""
    return (
        f"  WARNING: {driver}: {count} out-of-range gear reading(s) emitted as "
        "neutral - a damaged car's gearbox telemetry is not a gear"
    )


def normalise_brake(values: Any) -> np.ndarray:
    """FastF1 Brake arrives as bool, int or float; the schema wants literal 0 or 1."""
    return (np.asarray(values, dtype=float) > 0).astype(int)
