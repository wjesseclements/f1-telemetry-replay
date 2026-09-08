"""
status.py — track-status intervals for a window, from the session's status feed.

FastF1's `session.track_status` is a transition log: an instant and a numeric code,
each valid until the next row. The schema wants the window's view of that log —
sorted, non-overlapping `{status, fromT, toT}` intervals in window seconds — and
this module is the pure transform between the two.

THE CODE MAP IS THE ONLY PLACE THE FEED'S NUMBERS ARE KNOWN
-----------------------------------------------------------
FastF1 documents 1=AllClear, 2=Yellow, 4=SCDeployed, 5=Red, 6=VSCDeployed and
7=VSCEnding (3 is unassigned). 6 and 7 both map to "vsc": "ending" is a phase of
the VSC, not a green flag — the board stays VSC until AllClear arrives. Any code
outside the map degrades to the schema's in-band "unknown" and is reported, never
raised: a strange season should announce itself in the report and render as no
flag, while the loader still rejects arbitrary strings in hand-mangled files
(the COMPOUNDS doctrine, applied to flags).

A WINDOW HEAD BEFORE THE FIRST TRANSITION IS UNCOVERED, NOT GREEN
-----------------------------------------------------------------
The status at the window's start is the last transition at or before it. If the
feed has none (a window opening before the feed's first row), the head of the
window gets NO interval — absence means "no answer", and inventing green would be
a lie the app then renders. The schema accepts gaps for exactly this case.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from .contract import TelemetryShapeError

#: FastF1 track-status code → schema status. See the module docstring.
STATUS_BY_CODE = {
    "1": "green",
    "2": "yellow",
    "4": "sc",
    "5": "red",
    "6": "vsc",
    "7": "vsc",
}

#: The in-band degradation target for codes the map does not know.
STATUS_UNKNOWN = "unknown"


@dataclass(frozen=True)
class StatusIntervals:
    """The emitted intervals, plus the distinct unmapped codes for the report."""

    #: Schema-shaped rows: ``{"status", "fromT", "toT"}``, sorted, non-overlapping.
    intervals: "tuple[dict[str, Any], ...]"
    #: Distinct codes that degraded to "unknown", in first-seen order.
    unknown_codes: "tuple[str, ...]"


def map_status_code(code: Any) -> str:
    """One code to one status; anything unrecognised is in-band ``"unknown"``."""
    return STATUS_BY_CODE.get(str(code).strip(), STATUS_UNKNOWN)


def window_status_intervals(
    times: Sequence[float],
    codes: Sequence[Any],
    window: "tuple[float, float]",
    duration: float,
) -> StatusIntervals:
    """
    Clip the session's transition log to a window and emit schema intervals.

    `times` are session seconds (the feed's own axis, like every window input —
    CLAUDE.md rule 5), non-decreasing; `codes` is the parallel status column.
    `window` is the same `(t0, t1)` handed to `build_window_replay_dict`, and
    `duration` is the EMITTED duration (`n / rate`), which runs up to one grid step
    past `t1` — the final interval extends to it so the app's clock, which parks on
    the holding step, still has an answer there. A transition falling inside that
    sliver past `t1` is ignored: no emitted sample can see it.

    Adjacent intervals with the same mapped status merge (VSC "deployed" and
    "ending" become one "vsc" stretch), and rows are rounded to the same 3 decimals
    as every other emitted time.
    """
    if len(times) != len(codes):
        raise TelemetryShapeError(
            f"track status needs one code per instant: got {len(times)} times "
            f"and {len(codes)} codes"
        )
    t0, t1 = float(window[0]), float(window[1])
    if t1 <= t0:
        raise TelemetryShapeError(
            f"window must run forwards: t0={t0} is not before t1={t1}"
        )
    if float(duration) <= 0:
        raise TelemetryShapeError(f"duration must be positive, got {duration}")

    previous = float("-inf")
    for t in times:
        if float(t) < previous:
            raise TelemetryShapeError(
                "track status times must be non-decreasing; the source rows "
                "are out of order"
            )
        previous = float(t)

    unknown: "list[str]" = []

    def mapped(code: Any) -> str:
        status = map_status_code(code)
        if status == STATUS_UNKNOWN:
            text = str(code).strip()
            if text not in unknown:
                unknown.append(text)
        return status

    # The window's own transition list: the carried-in status at t0 (if the feed
    # reaches back that far), then every transition inside [t0, t1).
    transitions: "list[tuple[float, str]]" = []
    for t, code in zip(times, codes):
        t = float(t)
        if t <= t0:
            # Later rows at or before t0 overwrite earlier ones — the carried-in
            # status is the LAST word the feed said before the window opened.
            entry = (0.0, mapped(code))
            if transitions and transitions[0][0] == 0.0:
                transitions[0] = entry
            else:
                transitions.insert(0, entry)
        elif t < t1:
            transitions.append((t - t0, mapped(code)))

    intervals: "list[dict[str, Any]]" = []
    for i, (from_t, status) in enumerate(transitions):
        to_t = transitions[i + 1][0] if i + 1 < len(transitions) else float(duration)
        if intervals and intervals[-1]["status"] == status:
            intervals[-1]["toT"] = round(to_t, 3)
            continue
        row = {"status": status, "fromT": round(from_t, 3), "toT": round(to_t, 3)}
        if row["toT"] > row["fromT"]:
            intervals.append(row)

    return StatusIntervals(intervals=tuple(intervals), unknown_codes=tuple(unknown))
