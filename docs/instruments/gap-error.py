#!/usr/bin/env python3
"""
gap-error.py — is an emitted replay's TOWER STORY right? Gap error against
position-free truth, per adjacent car pair.

Slice 9i rider (a), committed for the same reason as `placement-error.py`: outside
`app/`, no gate adopts it, header carries the procedure and the limits. PLAN.md's
Slice 9i entry carries the baseline to compare a re-run against.

    pipeline/.venv/bin/python docs/instruments/gap-error.py \
        app/public/gallery/silverstone-2024-rain.json \
        --gp Silverstone --session R --ref HAM --laps 24-28

Needs the FastF1 cache (`pipeline/.f1cache`); runs offline against it and fetches
nothing. Read-only.

WHY GAPS GET THEIR OWN INSTRUMENT
---------------------------------
Absolute placement error partially CANCELS between cars in the timing tower:
correlated misplacement moves both cars the same way and the gap survives. Slice 9h
measured the converse in the wild — repairing HAM while declining NOR broke the
correlation and the HAM-NOR gap error tripled while HAM's absolute placement halved.
So the two numbers can disagree about priority, and this instrument produces the one
the VIEWER actually experiences.

TWO TRUTHS, AND WHAT EACH IS FOR
--------------------------------
G  DTDA — continuous truth. FastF1's `DistanceToDriverAhead`: each driver's distance
   integral (`cumsum(Speed/3.6*dt)` on car_data), zero-anchored at a timing-loop lap
   start, differenced against the car ahead. POSITION-FREE — verified in the fastf1
   source in this slice's own context (`Telemetry.calculate_driver_ahead` reads
   Speed and the laps table only; X/Y never enter), which is what makes it an
   adjudicator for gaps built FROM positions. Scored only at instants where
   `DriverAhead` is the pair's own partner — when a car outside the file sits
   between them, DTDA measures a different pair and is not this pair's truth.

   CAVEAT — G IS A CROSS-CHECK, NOT THE ADJUDICATOR, and this was MEASURED rather
   than assumed (Slice 9i Phase 1). fastf1 warns the integral drifts past one or two
   laps; over these 5-7 lap windows the drift is not the dry-window 0.036-0.059% of
   9h but is dominated by two pit-coupled effects: the pit LAP integrates ~40-50 m
   more than the racing-line arc the projection uses (the pit lane is a different
   path), and a car's post-stop laps can run systematically hot against a non-stopping
   car's (LEC vs VER at Monza: +15-26 m per lap). Summed over a window the truth
   itself drifts >100 m for pairs where exactly one car stops — larger than the
   defect being scored. The signed first/last-minute means are printed so a reading
   dominated by truth drift (monotone growth, loops quiet) is distinguishable from
   real gap error (L elevated too). Where G and L disagree, L wins.

L  LOOP DELTAS — spot truth at the transponder marks. The gap in SECONDS between two
   cars at a timing loop is the difference of their crossing times, straight from the
   laps table. No integration, no position, no speed channel. Sparse (one reading per
   mark per lap) but exact to timing-loop resolution; where G and L disagree, L wins.

THE MEASURED QUANTITY
---------------------
The emitted gap: both cars' samples projected onto the reference manifold
(`placement-error.py`'s, reused by import), arcs unwrapped, differenced — along-track
metres, the same quantity DTDA reports; seconds for L via the crossing instants of
the mark's own arc position. Pit-lane samples project onto the racing line (~10-20 m
lateral at these tracks); their along-track coordinate stays comparable, and the
pit-cycle window is precisely where the tower's story is being scored, so they are
kept, not skipped.

NOISE FLOOR (measured on the three dry finale pairs — see PLAN.md Slice 9i)
---------------------------------------------------------------------------
Established by the Phase 1 baseline run and recorded in PLAN.md rather than here,
so a re-run compares against a table, not a memory.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "pipeline"))

_spec = importlib.util.spec_from_file_location(
    "placement_error", Path(__file__).with_name("placement-error.py")
)
pe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pe)

POS_TO_M = pe.POS_TO_M


def unwrapped_arc(car, manifold):
    """Each emitted sample's along-track coordinate, unwrapped across laps (metres)."""
    t, x, y, _ = pe.car_arrays(car)
    ell, _ = pe.project(manifold, x, y)
    ell = ell * POS_TO_M
    lap_len = manifold[2][-1] * POS_TO_M
    wraps = np.concatenate(([0.0], np.cumsum(np.diff(ell) < -0.5 * lap_len)))
    return t, ell + wraps * lap_len, lap_len


def loop_anchored_distance(ses, drv_num, base_lap, t_start, t_end):
    """One driver's loop-anchored distance integral over the window, fastf1's own
    construction: slice whole laps starting at the S/F crossing (the timing loop),
    `add_distance` (cumsum of Speed/3.6*dt — position never enters), then clip.

    `base_lap` aligns the zero point across drivers exactly as
    `Telemetry.calculate_driver_ahead` does: a driver whose current lap number at
    `t_start` is behind the reference's zeroes at their NEXT crossing (fastf1's
    `lap_n_before += 1` rule), so every distance is measured from the same physical
    line on the same contest lap and the pairwise difference is along-track
    separation in metres.

    Applied per PAIR rather than through `add_driver_ahead`/`calculate_driver_ahead`
    because fastf1 3.8.3's join misaligns on sliced telemetry (length mismatch) —
    this is the identical arithmetic minus the argmin over the whole field.
    """
    import pandas as pd

    laps = ses.laps[ses.laps["DriverNumber"] == drv_num]
    before = laps[laps["LapStartTime"].dt.total_seconds() <= t_start]
    n0 = int(before["LapNumber"].iloc[-1]) if len(before) else int(laps["LapNumber"].min())
    if n0 < base_lap:
        n0 += 1
    after = laps[laps["Time"].dt.total_seconds() >= t_end]
    n1 = int(after["LapNumber"].iloc[0]) if len(after) else int(laps["LapNumber"].max())
    relevant = laps[(laps["LapNumber"] >= n0) & (laps["LapNumber"] <= n1)]
    tel = ses.car_data[drv_num].slice_by_lap(relevant).add_distance()
    tel = tel.slice_by_time(
        pd.Timedelta(seconds=t_start), pd.Timedelta(seconds=t_end)
    )
    st = tel["SessionTime"].dt.total_seconds().to_numpy()
    return st - t_start, tel["Distance"].to_numpy()


def crossing_times(t, arc, target, lap_len):
    """Every instant the unwrapped arc crosses `target + k*lap_len`, by interpolation."""
    out = []
    k0 = int(np.floor((arc[0] - target) / lap_len))
    for k in range(k0, k0 + int((arc[-1] - arc[0]) / lap_len) + 2):
        a = target + k * lap_len
        idx = np.flatnonzero((arc[:-1] < a) & (arc[1:] >= a))
        for i in idx:
            f = (a - arc[i]) / (arc[i + 1] - arc[i])
            out.append(float(t[i] + f * (t[i + 1] - t[i])))
    return sorted(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("replay", type=Path)
    ap.add_argument("--gp", required=True)
    ap.add_argument("--session", default="R")
    ap.add_argument("--year", type=int, default=2024)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--laps", required=True)
    ap.add_argument("--cache", type=Path, default=REPO / "pipeline" / ".f1cache")
    args = ap.parse_args(argv)

    import fastf1

    lo, _, hi = args.laps.partition("-")
    laps = (int(lo), int(hi))
    replay = json.loads(args.replay.read_text())
    marks, window = pe.timing_marks(
        args.year, args.gp, args.session, args.ref, laps, args.cache
    )
    manifold, _ = pe.lap_manifold(replay, marks, args.ref)

    fastf1.Cache.enable_cache(str(args.cache))
    fastf1.Cache.offline_mode(True)
    ses = fastf1.get_session(args.year, args.gp, args.session)
    ses.load(telemetry=True, laps=True, weather=False, messages=False)
    num_of = {
        str(ses.get_driver(d)["Abbreviation"]): str(d) for d in ses.drivers
    }

    arcs = {}
    for car in replay["cars"]:
        arcs[car["driver"]] = unwrapped_arc(car, manifold)

    drivers = [c["driver"] for c in replay["cars"]]
    print(f"{args.replay.name}: {len(drivers)} cars, window {window[0]:.1f}->{window[1]:.1f}s")

    print("\nG GAP vs the DTDA quantity — |emitted along-track gap - truth|, metres")
    print("  (loop-anchored speed-integral difference, fastf1's own construction,")
    print("   applied per pair; position-free; k fixed per pair over the window)")
    # the alignment base: the reference driver's lap in progress at t_start
    ref_laps = ses.laps[ses.laps["DriverNumber"] == num_of[args.ref]]
    base_lap = int(
        ref_laps[ref_laps["LapStartTime"].dt.total_seconds() <= window[0] + 1]
        ["LapNumber"].iloc[-1]
    )
    truth_d = {
        d: loop_anchored_distance(ses, num_of[d], base_lap, window[0], window[1])
        for d in drivers
    }
    for i, b_drv in enumerate(drivers):
        for a_drv in drivers[i + 1:]:
            ta, da = truth_d[a_drv]
            tb, db = truth_d[b_drv]
            tt = tb[(tb >= max(ta[0], tb[0])) & (tb <= min(ta[-1], tb[-1]))]
            truth = np.interp(tt, ta, da) - np.interp(tt, tb, db)
            t_b, arc_b, lap_len = arcs[b_drv]
            t_a, arc_a, _ = arcs[a_drv]
            raw = np.interp(tt, t_a, arc_a) - np.interp(tt, t_b, arc_b)
            k = round(float(np.median(truth - raw)) / lap_len)
            signed = raw + k * lap_len - truth
            err = np.abs(signed)
            first = signed[tt < tt[0] + 60].mean()
            last = signed[tt > tt[-1] - 60].mean()
            print(
                f"  {b_drv}-{a_drv}: n={len(tt):5d} "
                f"mean {err.mean():5.1f} m | p95 {np.percentile(err, 95):5.1f} m | "
                f"max {err.max():5.1f} m | signed ends {first:+6.1f} -> {last:+6.1f} m "
                f"(k={k})"
            )

    print("\nL GAP vs LOOP DELTAS — |emitted crossing-time delta - loop delta|, seconds")
    print("  (zero-integration spot truth; one reading per mark per lap)")
    for name in ("S/F", "sector1", "sector2"):
        cells = []
        for i, a_drv in enumerate(drivers):
            for b_drv in drivers[i + 1:]:
                ta = [m for m in marks.get(a_drv, {}).get(name, [])]
                tb = [m for m in marks.get(b_drv, {}).get(name, [])]
                if len(ta) < 2 or len(tb) < 2:
                    continue
                # the mark's arc position: median projection of the ref car's own
                # crossings, one fixed point per mark family (placement-error's premise)
                t_r, arc_r, lap_len = arcs[args.ref]
                pos = np.median(
                    np.mod(np.interp(marks[args.ref][name], t_r, arc_r), lap_len)
                )
                errs = []
                for m_a in ta:
                    # truth: this car's crossing vs the OTHER car's nearest crossing
                    m_b = min(tb, key=lambda v: abs(v - m_a))
                    truth = m_b - m_a
                    if abs(truth) > 60.0:
                        continue  # different lap of the track; not a tower gap
                    ca = crossing_times(*arcs[a_drv][:2], pos, lap_len)
                    cb = crossing_times(*arcs[b_drv][:2], pos, lap_len)
                    if not ca or not cb:
                        continue
                    e_a = min(ca, key=lambda v: abs(v - m_a))
                    e_b = min(cb, key=lambda v: abs(v - m_b))
                    errs.append(abs((e_b - e_a) - truth))
                if errs:
                    cells.append((f"{a_drv}-{b_drv}", name, errs))
        for pair, fam, errs in cells:
            e = np.array(errs)
            print(
                f"  {pair} @ {fam}: n={len(e)} mean {e.mean():5.2f} s | "
                f"max {e.max():5.2f} s"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
