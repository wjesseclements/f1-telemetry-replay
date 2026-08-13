#!/usr/bin/env python3
"""
placement-error.py — is an emitted replay's car WHERE IT SHOULD BE?

Committed for the same reason as `docs/perf/fps-probe.js` and `hud-tick.mjs`: it lives
outside `app/`, no gate adopts it, and its header carries the procedure and the limits
so a re-run is comparable to the run that accepted the change. Slice 9h's entry in
PLAN.md carries the baseline to compare a re-run against.

    python docs/instruments/placement-error.py app/public/gallery/silverstone-2024-rain.json \
        --gp Silverstone --session R --ref HAM --laps 24-28 [--baseline <other.json>]

Needs the FastF1 cache (`pipeline/.f1cache`) for the timing marks; runs offline against
it and fetches nothing. Read-only.

WHY THIS EXISTS RATHER THAN A DIFF AGAINST THE PREVIOUS ASSET
-------------------------------------------------------------
A diff against a baseline can only say a build CHANGED. It cannot say which build is
RIGHT, and Slice 9g shipped on exactly that confusion: the regenerated assets were
measured against the assets they replaced, the difference was called a regression, and
the build that was 40 m CLOSER to the timing loops was reverted. Two of the three
components below measure against the track and the clock instead.

THE THREE COMPONENTS
--------------------
A  REVERSAL — sliding 0.7 s arc-over-net on the emitted path.
   Sees a doubling-back (the pit-entry zigzag). Blind to a slide along the path.
   **Scanned, never scored over a fixed window.** A repair MOVES a defect as often as
   it removes one: scored over Slice 9g's fixed 286.18-286.84 s window, the asset that
   demonstrably has the zigzag on screen reads a clean 1.00, and so does the asset that
   was supposed to have fixed it. The defect was 0.5 s outside the window in both.

B  PLACEMENT — scatter of the emitted position at each transponder mark.
   Lap-start and sector times are timing-loop data: independent of the Speed channel
   and of X/Y alike, which is what makes this an adjudicator rather than an echo.
   Each mark type is one FIXED point on the track, so the same mark across laps must
   land in the same place; the spread is placement error in along-track metres.

   NOT `Distance` / `DistanceToDriverAhead`. Those were checked first and rejected:
   FastF1 builds both from `cumsum(Speed/3.6 * dt)` on car_data BEFORE the position
   merge, so they are independent of position (verified — where VER's polyline claims
   142.6 m they report 47.1 m) but agree with our own `cumulative_travel` to
   0.036-0.059%. Scoring placement against them asks our own progress measure whether
   our own progress measure is right. They remain useful for GAPS, which are
   position-free by the same argument.

C  DISPLACEMENT — per-sample distance from a named baseline build.
   Says a build changed and WHERE. Ship criterion only; never evidence of correctness.

MEASURED NOISE FLOOR (Slice 9h, 2024 Silverstone R, HAM laps 48-52, three clean cars)
------------------------------------------------------------------------------------
    A  1.04-1.08, zero windows above 2.0
    B  6.6 / 11.7 / 8.4 m
Anything at or under those figures is indistinguishable from correct placement with
this instrument. B cannot resolve a defect smaller than ~12 m and does not pretend to.

A CAUTION THE FIRST RUN EARNED
------------------------------
Two aggregation bugs made clean data read as catastrophic before the raw values were
looked at: a manifold built from a guessed sample count ran 783 m long and overlapped
itself, and marks either side of the manifold's seam differed by a whole lap. Both are
fixed here (the manifold is cut S/F-to-S/F by the loops themselves; spreads are
circular). If this instrument ever reports hundreds of metres, print the raw arc values
before believing it.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))

POS_TO_M = 0.1  #: FastF1 X/Y are 1/10 m. The INSTRUMENT may know this; the transform
#: may not, and `resample_positions_by_travel` still assumes no position unit at all.
REVERSAL_WIN = 7  #: samples at 10 Hz = 0.7 s, the width of both known defect clusters.
OFF_LINE_M = 25.0  #: beyond this a mark was taken in the pit lane, which is not the
#: same track point as the racing-line crossing and is reported separately.


# --- geometry ---------------------------------------------------------------------


def car_arrays(car):
    s = car["samples"]
    return (
        np.array([p["t"] for p in s], dtype=float),
        np.array([p["x"] for p in s], dtype=float),
        np.array([p["y"] for p in s], dtype=float),
        np.array([p["speed"] for p in s], dtype=float),
    )


def build_manifold(x, y, i0, i1):
    """A closed one-lap reference path from a slice of a car's emitted path."""
    mx, my = np.asarray(x[i0:i1], float), np.asarray(y[i0:i1], float)
    keep = np.concatenate(([True], np.hypot(np.diff(mx), np.diff(my)) > 1e-9))
    mx, my = np.append(mx[keep], mx[keep][0]), np.append(my[keep], my[keep][0])
    arc = np.concatenate(([0.0], np.cumsum(np.hypot(np.diff(mx), np.diff(my)))))
    return mx, my, arc


def project(manifold, qx, qy, chunk=512):
    """Arc coordinate and perpendicular distance of the nearest point on the path."""
    mx, my, arc = manifold
    ax, ay = mx[:-1], my[:-1]
    vx, vy = np.diff(mx), np.diff(my)
    vv = np.maximum(vx * vx + vy * vy, 1e-12)
    ell, lat = np.empty(len(qx)), np.empty(len(qx))
    for lo in range(0, len(qx), chunk):
        hi = min(lo + chunk, len(qx))
        px, py = qx[lo:hi, None] - ax[None, :], qy[lo:hi, None] - ay[None, :]
        tt = np.clip((px * vx + py * vy) / vv, 0.0, 1.0)
        d2 = (px - tt * vx) ** 2 + (py - tt * vy) ** 2
        j = np.argmin(d2, axis=1)
        rows = np.arange(hi - lo)
        ell[lo:hi] = arc[j] + tt[rows, j] * np.sqrt(vv[j])
        lat[lo:hi] = np.sqrt(d2[rows, j])
    return ell, lat


def circular_spread(values, lap_len):
    """Tightest arc containing every value, on a circle — seam-proof."""
    v = np.sort(np.mod(np.asarray(values, float), lap_len))
    if len(v) < 2:
        return 0.0
    gaps = np.diff(np.concatenate([v, [v[0] + lap_len]]))
    return float(lap_len - gaps.max())


# --- the components ---------------------------------------------------------------


def reversal(car, win=REVERSAL_WIN):
    """A: arc-over-net in a sliding window. 1.0 is straight-through motion."""
    t, x, y, _ = car_arrays(car)
    step = np.hypot(np.diff(x), np.diff(y)) * POS_TO_M
    arc = np.convolve(step, np.ones(win), mode="valid")
    net = np.hypot(x[win:] - x[:-win], y[win:] - y[:-win]) * POS_TO_M
    return t[win // 2 : win // 2 + len(arc)], arc / np.maximum(net, 1e-9), arc, net


def placement(car, marks, manifold):
    """B: per-mark-type along-track spread, and the marks taken off the racing line."""
    lap_len = manifold[2][-1] * POS_TO_M
    t, x, y, _ = car_arrays(car)
    cells, skipped = [], 0
    for name in ("S/F", "sector1", "sector2"):
        times = [m for m in marks.get(name, []) if t[0] <= m <= t[-1]]
        if len(times) < 2:
            continue
        ell, lat = project(manifold, np.interp(times, t, x), np.interp(times, t, y))
        ell, lat = ell * POS_TO_M, lat * POS_TO_M
        on = lat <= OFF_LINE_M
        skipped += int((~on).sum())
        if on.sum() >= 2:
            cells.append((name, int(on.sum()), circular_spread(ell[on], lap_len)))
    return cells, skipped


def displacement(base_car, car):
    """C: per-sample distance from the baseline build."""
    t, xa, ya, _ = car_arrays(base_car)
    _, xb, yb, _ = car_arrays(car)
    return t, np.hypot(xb - xa, yb - ya) * POS_TO_M


# --- session marks ----------------------------------------------------------------


def timing_marks(year, gp, session_id, ref, laps, cache):
    """Transponder marks per driver, in window-relative seconds, plus the window."""
    import fastf1

    fastf1.Cache.enable_cache(str(cache))
    fastf1.Cache.offline_mode(True)
    ses = fastf1.get_session(year, gp, session_id)
    ses.load(telemetry=False, laps=True, weather=False, messages=False)

    ref_laps = ses.laps.pick_drivers(ref)
    chosen = ref_laps[
        (ref_laps["LapNumber"] >= laps[0]) & (ref_laps["LapNumber"] <= laps[1])
    ]
    starts = chosen["LapStartTime"].dt.total_seconds().to_numpy()
    t0 = float(starts[0])
    t1 = float(starts[-1] + chosen["LapTime"].dt.total_seconds().to_numpy()[-1])

    out = {}
    for drv in ses.laps["Driver"].unique():
        lp = ses.laps.pick_drivers(drv)
        per = {}
        for name, col in (
            ("S/F", "LapStartTime"),
            ("sector1", "Sector1SessionTime"),
            ("sector2", "Sector2SessionTime"),
        ):
            if col not in lp.columns:
                continue
            v = lp[col].dt.total_seconds().to_numpy()
            v = v[np.isfinite(v)]
            per[name] = (v[(v >= t0 + 1) & (v <= t1 - 1)] - t0).tolist()
        out[str(drv)] = per
    return out, (t0, t1)


def lap_manifold(replay, marks, ref_driver):
    """One lap of the reference car, cut S/F to S/F by the loops rather than guessed."""
    car = next(c for c in replay["cars"] if c["driver"] == ref_driver)
    t, x, y, _ = car_arrays(car)
    sf = sorted(m for m in marks[ref_driver]["S/F"] if t[0] <= m <= t[-1])
    if len(sf) < 2:
        raise SystemExit(
            f"{ref_driver} has {len(sf)} S/F marks inside this window; the manifold "
            "needs two to cut a lap. Choose a reference driver who ran whole laps."
        )
    i0, i1 = int(np.searchsorted(t, sf[0])), int(np.searchsorted(t, sf[1]))
    return build_manifold(x, y, i0, i1), (sf[0], sf[1])


# --- report -----------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("replay", type=Path)
    ap.add_argument("--gp", required=True)
    ap.add_argument("--session", default="R")
    ap.add_argument("--year", type=int, default=2024)
    ap.add_argument("--ref", required=True, help="reference driver: names the window")
    ap.add_argument("--laps", required=True, help="A-B, the reference driver's laps")
    ap.add_argument("--baseline", type=Path, help="build to measure displacement from")
    ap.add_argument("--cache", type=Path, default=REPO / "pipeline" / ".f1cache")
    args = ap.parse_args(argv)

    lo, _, hi = args.laps.partition("-")
    laps = (int(lo), int(hi))
    replay = json.loads(args.replay.read_text())
    marks, window = timing_marks(
        args.year, args.gp, args.session, args.ref, laps, args.cache
    )
    manifold, cut = lap_manifold(replay, marks, args.ref)
    lap_len = manifold[2][-1] * POS_TO_M

    print(f"{args.replay.name}: {len(replay['cars'])} cars, "
          f"{replay['meta']['duration']:.1f}s window")
    print(f"manifold: {args.ref} lap {cut[0]:.2f}->{cut[1]:.2f}s = {lap_len:.1f} m\n")

    print("A REVERSAL — sliding 0.7 s arc/net (clean reads 1.04-1.08, 0 windows > 2.0)")
    for car in replay["cars"]:
        tc, ratio, arc, net = reversal(car)
        i = int(ratio.argmax())
        print(f"  {car['driver']:4} max {ratio[i]:6.2f} @ t={tc[i]:7.1f}s "
              f"(arc {arc[i]:5.1f} m for net {net[i]:5.1f} m) | "
              f"p99 {np.percentile(ratio, 99):4.2f} | "
              f"{int((ratio > 2.0).sum()):3d} windows > 2.0")

    print("\nB PLACEMENT — transponder-mark scatter (noise floor 6.6-11.7 m)")
    for car in replay["cars"]:
        cells, skipped = placement(car, marks.get(car["driver"], {}), manifold)
        if not cells:
            print(f"  {car['driver']:4} no usable marks in window")
            continue
        worst = max(c[2] for c in cells)
        detail = " | ".join(f"{n} n={k} {s:5.1f} m" for n, k, s in cells)
        print(f"  {car['driver']:4} {detail} | off-line skipped: {skipped}  "
              f"WORST {worst:5.1f} m")

    if args.baseline:
        base = json.loads(args.baseline.read_text())
        by_driver = {c["driver"]: c for c in base["cars"]}
        print(f"\nC DISPLACEMENT from {args.baseline.name}")
        for car in replay["cars"]:
            ref = by_driver.get(car["driver"])
            if ref is None:
                print(f"  {car['driver']:4} absent from baseline")
                continue
            t, d = displacement(ref, car)
            print(f"  {car['driver']:4} max {d.max():6.1f} m | mean {d.mean():5.1f} m | "
                  f"{int((d > 1).sum()):5d} samples > 1 m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
