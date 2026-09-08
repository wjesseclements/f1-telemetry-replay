"""
dead_feed.py — freeze a car at the point its telemetry collapses (Slice 9l).

THE DEFECT THIS SCREENS FOR
---------------------------
When a car dies on track its feed can die WITH it and keep transmitting: LEC's
2026 Monza impact left every channel fabricating together — speed pinned near
162 km/h (sigma ~6) with throttle exactly 0.0 forever, RPM decaying like a
spun-down instrument, positions dead-reckoned along the racing line by the
tracker. The three existing screens are structurally blind to it: they test
channels against each other, and a dead bus agrees with itself.

THE MEASURED SIGNATURE, AND WHY THESE EXACT SIGNALS
---------------------------------------------------
"Zero pedal at racing pace, with speed that zero power cannot hold." With no
throttle at >=80 km/h, aero drag sheds tens of km/h in seconds — only a
fabricating feed holds speed flat. Measured over the whole corpus (nine 2024
car-windows, all 43 2026 car-windows; PLAN Slice 9l carries the table): at a
20 s window NO live car ever produces even one qualifying stretch, while the
dead feed drifts 14 km/h — the band between them is EMPTY, and the thresholds
below sit inside it. RPM is deliberately NOT a trigger signal: measured on the
one known death it is only 51% monotone, so it would add a false-negative
surface and no separation.

THE FREEZE POINT IS THE PEDALS, NOT THE TRIGGER
-----------------------------------------------
The trigger needs 20 s of evidence, so it fires late by construction (16 s
after the last pedal on LEC). The driver's inputs are the feed's heartbeat:
the freeze lands on the last sample with real pedal activity BEFORE the
trigger — 2.4 s after wall contact on the measured case, at the corner —
and the car is parked there.

THE GUARD, PER THE SURRENDER DOCTRINE (9g)
------------------------------------------
Pedal activity AFTER the trigger means the feed came back: that is a dropout,
not a death, and bridging it would fabricate a retirement. The screen declines,
says so, and ships the data untouched.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

#: Seconds of continuous evidence the trigger needs. At 20 s the corpus-wide
#: false-positive band is empty (no live car qualifies at all); 5 s windows are
#: ordinary lift-and-coast. Measured, not guessed — PLAN Slice 9l.
DEAD_FEED_WINDOW_S = 20.0

#: Percent. Above this the driver's foot is on the pedal and the car is alive.
DEAD_FEED_THROTTLE = 1.0

#: km/h. Below this a flat speed is legitimate (parked, garage, grid) — a dead
#: feed is only detectable while it CLAIMS pace it cannot hold.
DEAD_FEED_MIN_SPEED = 80.0

#: km/h of speed drift allowed inside the trigger window. The measured death
#: drifts 14; no live car qualifies at any drift, so 25 is generous inside an
#: empty band rather than a tuned edge.
DEAD_FEED_MAX_DRIFT = 25.0

#: A trigger window sparser than this fraction of DEAD_FEED_WINDOW_S in actual
#: row coverage is not 20 s of evidence and does not count.
_MIN_COVERAGE = 0.8


@dataclass(frozen=True)
class DeadFeedResult:
    """What the screen decided for one car, in session seconds."""

    #: True when the car is frozen at `freeze_t`.
    frozen: bool
    #: True when a collapse-shaped stretch was found but pedal activity after it
    #: proved the feed resumed — reported, nothing touched.
    declined: bool
    #: The last pedal-alive instant before the trigger (the freeze point).
    freeze_t: "float | None"
    #: Where the 20 s evidence window began.
    trigger_t: "float | None"
    #: The trigger window's speed drift, for the report.
    drift: "float | None"


#: The no-op result for a healthy car.
ALIVE = DeadFeedResult(
    frozen=False, declined=False, freeze_t=None, trigger_t=None, drift=None
)


def detect_dead_feed(
    times: Any,
    speed: Any,
    throttle: Any,
    brake: Any,
    window: "tuple[float, float]",
) -> DeadFeedResult:
    """
    Find the earliest dead-feed trigger inside `window`, on the session axis.

    Inputs are the car's source rows (irregular cadence is fine — the trigger
    demands real row coverage, not row counts). Only trigger STARTS inside the
    window are considered; the evidence window itself may run past the window's
    end, because data is data.
    """
    t = np.asarray(times, dtype=float)
    v = np.asarray(speed, dtype=float)
    th = np.asarray(throttle, dtype=float)
    br = np.asarray(brake, dtype=float) > 0
    t0, t1 = float(window[0]), float(window[1])

    pedal_alive = (th > DEAD_FEED_THROTTLE) | br

    trigger_i = None
    drift = None
    for i in range(len(t)):
        if t[i] < t0 or t[i] > t1:
            continue
        j = int(np.searchsorted(t, t[i] + DEAD_FEED_WINDOW_S, side="right"))
        if j - i < 4 or t[j - 1] - t[i] < DEAD_FEED_WINDOW_S * _MIN_COVERAGE:
            continue
        sl = slice(i, j)
        if th[sl].max() > DEAD_FEED_THROTTLE:
            continue
        # "Zero pedal" means BOTH pedals: a braking car is alive, and a trigger
        # window containing brake activity would otherwise start on the braking
        # sample and immediately decline itself against its own evidence.
        if br[sl].any():
            continue
        if v[sl].min() < DEAD_FEED_MIN_SPEED:
            continue
        d = float(v[sl].max() - v[sl].min())
        if d > DEAD_FEED_MAX_DRIFT:
            continue
        trigger_i, drift = i, d
        break

    if trigger_i is None:
        return ALIVE

    # The guard: pedal activity after the trigger start means the feed resumed.
    if bool(pedal_alive[trigger_i:].any()):
        return DeadFeedResult(
            frozen=False,
            declined=True,
            freeze_t=None,
            trigger_t=float(t[trigger_i]),
            drift=drift,
        )

    # The freeze point: the last pedal-alive sample before the trigger, or the
    # window's start when the feed was dead from the first row.
    before = np.flatnonzero(pedal_alive[:trigger_i])
    freeze_t = float(t[before[-1]]) if len(before) else t0
    return DeadFeedResult(
        frozen=True,
        declined=False,
        freeze_t=freeze_t,
        trigger_t=float(t[trigger_i]),
        drift=drift,
    )


def freeze_telemetry(
    telemetry: Mapping[str, Any], freeze_t: float
) -> "dict[str, Any]":
    """
    Truncate every channel at `freeze_t` and append one REST row a source step
    later: same position, zero speed, zero pedals, neutral gear. The pipeline's
    existing clamp-and-hold semantics then park the car there for the rest of
    the window — position frozen, speed honestly zero, so the emitted channels
    agree with the emitted geometry instead of animating the fabrication.

    DRS holds its last real value rather than being invented: the indicator is
    season data, not a dynamic (rule 8), and zeroing it here would be this
    module deciding what a season looks like.
    """
    t = np.asarray(telemetry["Time"], dtype=float)
    keep = t <= float(freeze_t)
    if not keep.any():
        raise ValueError(
            f"freeze_t={freeze_t} precedes every telemetry row; nothing to keep"
        )
    kept_t = t[keep]
    step = float(np.median(np.diff(kept_t))) if len(kept_t) > 1 else 0.2
    rest_t = float(kept_t[-1]) + step

    out: "dict[str, Any]" = {}
    for name, column in telemetry.items():
        values = np.asarray(column)[keep]
        if name == "Time":
            rest = rest_t
        elif name in ("X", "Y", "DRS"):
            rest = values[-1]
        elif name == "Brake":
            rest = False if values.dtype == bool else 0
        else:  # Speed, Throttle, nGear — the dynamics, honestly at rest
            rest = 0
        out[name] = np.append(values, rest)
    return out
