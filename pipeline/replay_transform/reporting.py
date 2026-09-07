"""
reporting.py — the per-run report lines, quality metrics, and serialisation.

Every screen and every car prints a line — a clean car prints a zero rather than
nothing, because silence is indistinguishable from a detector that never ran.
Split verbatim from `replay_transform.py` in Slice 9i Phase 0; no behaviour change.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Sequence

import numpy as np

from .contract import SAMPLE_RATE_HZ
from .placement import KMH_S_PER_METRE, covers_ground, cumulative_travel
from .repair import FixRejection, FrameDisplacement
from .assembly import AnchorPlan, WindowCar

def stint_report(driver: str, laps: "Sequence[Mapping[str, Any]]", stints: "Sequence[Mapping[str, Any]]") -> str:
    """
    One line per car, in the same family as the screening reports: a car with no
    lap data says so rather than printing nothing, because silence is
    indistinguishable from a column that was never read. UNKNOWN compounds print
    by name — a strange session announces itself here, not in the browser.
    """
    if not laps:
        return f"  {driver}: no lap data"
    parts = []
    for s in stints:
        span = f"L{s['fromLap']}-{s['toLap']}"
        if "ageAtStart" in s:
            a0 = s["ageAtStart"]
            parts.append(f"{span} {s['compound']} age {a0}->{a0 + (s['toLap'] - s['fromLap'])}")
        else:
            parts.append(f"{span} {s['compound']} age unknown")
    lap_span = f"laps {laps[0]['number']}-{laps[-1]['number']}"
    body = " · ".join(parts) if parts else "no stint data"
    return f"  {driver}: {lap_span} · {body}"


def fix_rejection_report(
    driver: str, r: "FixRejection", offset: float = 0.0
) -> str:
    """
    One line per car, in the same family as the time-base stretch and motion fidelity.

    A clean car prints `0 rejected` rather than nothing: silence is indistinguishable
    from a detector that never ran.

    A SURRENDER carries its arc-over-net ratio, because that ratio is what says which
    KIND of problem was declined. ~1.0 is a step change — the polyline relocates and
    stays, and bridging it would mean deciding which side is real, which is
    reconstruction rather than cleaning. Much greater than 1 is an excursion that
    doubles back but ran longer than the bound. Measured on 2024 Silverstone R VER:
    2.56 for the out-and-back, 1.00 for the pit-entry step.
    """
    if r.n_rejected == 0 and not r.surrendered:
        return f"  {driver}: 0 position fixes rejected"
    at = ", ".join(f"{t - offset:.1f}" for t in r.rejected_times[:6])
    more = "..." if len(r.rejected_times) > 6 else ""
    line = (
        f"  {driver}: {r.n_rejected} position fix(es) rejected "
        f"(worst {r.worst_ratio:.1f}x implied vs channel)"
    )
    if at:
        line += f" at t={at}{more}"
    if r.seed_retracted:
        line += "\n      first fix was itself wild; anchor retracted and re-seeded"
    for a, b, ratio in r.surrendered:
        kind = "step change: relocates and stays" if ratio < 1.8 else "excursion"
        line += (
            f"\n      SURRENDERED t={a - offset:.1f}-{b - offset:.1f}s arc/net={ratio:.2f} ({kind}) "
            f"- kept, not bridged"
        )
    return line


def frame_repair_report(
    driver: str, r: "FrameDisplacement", offset: float = 0.0
) -> str:
    """
    One line per car for the frame-displacement screen, in the same family as
    `fix_rejection_report`: a clean car prints a zero rather than nothing, because
    silence is indistinguishable from a detector that never ran.

    A DECLINED displacement is the line worth reading. It means the position channel
    relocated and did not come back, so every fix after it is somewhere else and this
    module has refused to guess which side is real. It is not fatal — the output is
    still schema-valid, the fix screen still ran, and the car is still worth watching —
    but nobody should discover it by wondering why one car's gaps look wrong.
    """
    if not r.jump_times:
        return f"  {driver}: 0 frame displacements"
    at = ", ".join(f"{t - offset:.1f}" for t in r.jump_times[:6])
    more = "..." if len(r.jump_times) > 6 else ""
    if r.repaired:
        span = r.span or (0.0, 0.0)
        return (
            f"  {driver}: frame displaced up to {r.offset_m:.1f} m over "
            f"t={span[0] - offset:.1f}-{span[1] - offset:.1f}s, translated back "
            f"(jumps cancel to {r.residual_m:.1f} m of {r.allowed_m:.1f} m allowed; "
            f"{len(r.jump_times)} jump steps at t={at}{more})"
        )
    return (
        f"  {driver}: {len(r.jump_times)} unmatched position jump(s) at t={at}{more}\n"
        f"      DECLINED: offset {r.offset_m:.1f} m does not cancel"
        + (
            f" (residual {r.residual_m:.1f} m against {r.allowed_m:.1f} m allowed)"
            if r.allowed_m > 0.0
            else " (no second jump to cancel against)"
        )
        + " - the channel relocated and stayed; left to the fix screen, not bridged"
    )


def window_car_report(
    cars: Sequence[WindowCar],
) -> "list[tuple[str, bool, float]]":
    """
    Per car: `(driver, moved, distance travelled in metres)`.

    The distance is converted from the travel integral by the one contract-backed
    conversion this module has (`KMH_S_PER_METRE`). It is deliberately NOT derived
    from the position channel, whose scale is the undocumented unknown.

    WHAT THIS DELIBERATELY DOES NOT REPORT, and why
    -----------------------------------------------
    An earlier version of this function also reported each car's `path / travel`
    ratio, on the theory that it was a per-car "unit bridge" whose spread across cars
    would bound how far two cars' along-track positions could disagree — a number
    Slice 9's relative gaps would rest on. Measured on 2024 Monza R it came out at
    24 m across VER/LEC/NOR, which looked alarming.

    IT WAS MEASURING NOTHING. `resample_positions_by_travel` places sample k at
    `(d_k / d_total) * s_total` — a FRACTION of the car's own path — so the ratio
    cancels out of the emitted positions entirely. That is 6b's unit-agnosticism,
    and it is pinned by a test: multiplying one car's speed channel by 1.5 moves its
    ratio by 33% and leaves every emitted coordinate byte-identical.

    So there is no cross-car bridge drift to bound, and "fix" it by sharing one
    bridge between cars would be a regression — it would reintroduce the scale
    dependence 6b removed, unpin each car's endpoint from its own last recorded fix,
    and reopen the overrun 6b rejected. The honest per-car quality metric is
    `motion_fidelity`, which measures something the output actually carries.
    """
    report = []
    for car in cars:
        t = np.asarray(car.telemetry["Time"], dtype=float)
        moved = covers_ground(
            t, car.telemetry["X"], car.telemetry["Y"], car.telemetry["Speed"]
        )
        travel = float(cumulative_travel(t, car.telemetry["Speed"])[-1])
        report.append((str(car.driver), moved, travel / KMH_S_PER_METRE))
    return report


def motion_fidelity(
    samples: Sequence[Mapping[str, Any]], rate: int = SAMPLE_RATE_HZ
) -> "tuple[float, float] | None":
    """
    Does this car's marker move at the speed the HUD shows? `(r, cv)`, or `None` for
    a car that never moved.

    This is Slice 6b's verification metric, computed on the emitted samples instead
    of by hand: the implied velocity `|dxy| * rate` between consecutive samples,
    against the speed channel over the same step, at k = 1 (the single-step window,
    no smoothing).

    * `r` — correlation. 6b's target was **> 0.97**; before the arc-length fix a real
      lap scored 0.70 and after it 0.9998.
    * `cv` — the implied/actual ratio's coefficient of variation, `sd / mean`. 6b's
      headline number: 0.2717 before, 0.0070 after.

    BOTH ARE SCALE-FREE, which is what makes them usable here at all. The implied
    velocity is in position-units per second and the speed channel is in km/h, and
    this module does not know the conversion between them — but a correlation is
    invariant under scaling either axis, and dividing the ratio's sd by its own mean
    cancels the same unknown. No hard-coded 0.1 or 1/3.6, exactly as 6b requires.

    Every step here is a real step: an open window has no cyclic wrap step to
    exclude, unlike a lap. Steps where the car is stationary are dropped — a zero
    denominator carries no information about fidelity — and `None` comes back when
    too few remain to correlate.
    """
    x = np.array([float(s["x"]) for s in samples])
    y = np.array([float(s["y"]) for s in samples])
    v = np.array([float(s["speed"]) for s in samples])

    implied = np.hypot(np.diff(x), np.diff(y)) * rate
    actual = 0.5 * (v[:-1] + v[1:])
    moving = actual > 0.0
    if int(np.count_nonzero(moving)) < 2:
        return None

    implied, actual = implied[moving], actual[moving]
    if implied.std() == 0.0 or actual.std() == 0.0:
        return None

    ratio = implied / actual
    return float(np.corrcoef(implied, actual)[0, 1]), float(ratio.std() / ratio.mean())


def dump_json(replay: Mapping[str, Any], compact: bool = False) -> str:
    """
    Serialise a replay canonically: sorted keys, 2-space indent, trailing newline.

    Formatting is for HUMANS — a regenerated golden file diffs line by line instead
    of as one enormous line. It is explicitly NOT what `tests/test_golden.py`
    asserts; that compares parsed structures, so key order and float repr cannot
    turn a formatting change into a phantom behaviour change.

    :param compact: drop the indentation and inter-token spaces. For files that are
        DEPLOYED rather than reviewed — the gallery assets in `app/public/gallery/`,
        which no human reads as a diff. Measured on real output it is a 2.3x saving
        (3.74 MB -> 1.62 MB for a 3-car, 7-lap window), which is worth having in a
        repo and on the wire but worth nothing in a golden.

        Keys stay SORTED either way, so the two forms differ only in whitespace and
        `json.loads` cannot tell them apart. The default is False so every existing
        caller — every golden, every `--out` without `--compact` — emits exactly the
        bytes it emitted before this parameter existed.
    """
    if compact:
        return json.dumps(replay, separators=(",", ":"), sort_keys=True) + "\n"
    return json.dumps(replay, indent=2, sort_keys=True) + "\n"


def anchor_report(driver: str, plan: "AnchorPlan") -> str:
    """
    One line per car for the anchor plan (Slice 9i), same family as the screens:
    a car with no anchors says so, and a WITHHELD plan is the line worth reading —
    it means the car carries a declined relocation, so the map deliberately stays
    global rather than pinning to a path that is known to be somewhere else.
    """
    if plan.declined:
        held = len(plan.loop) + len(plan.pit)
        return (
            f"  {driver}: anchors WITHHELD ({held} candidate(s)) - declined "
            f"displacement; the map stays global rather than pin known-unreal path"
        )
    n = len(plan.extra())
    if n == 0:
        return f"  {driver}: 0 extra anchors (no crossings or slow spans in coverage)"
    return (
        f"  {driver}: {n} extra anchor(s) - {len(plan.loop)} S/F crossing(s), "
        f"{len(plan.pit)} pit-span edge(s)"
    )
