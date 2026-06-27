#!/usr/bin/env python3
"""
build_replay.py — fetch real F1 telemetry via FastF1 and emit the replay JSON
that the TelemetryReplay app consumes.

The output schema is IDENTICAL to the synthetic generator in the app, so this is
a drop-in data source. v1 writes a single car; the same schema scales to a full
grid (see build_race_replay() at the bottom) with zero frontend changes.

Setup
-----
    python -m venv .venv && source .venv/bin/activate
    pip install fastf1            # 3.8+;  Python 3.10+

Run (single fast lap, e.g. Verstappen, 2024 Monza qualifying)
-------------------------------------------------------------
    python build_replay.py --year 2024 --gp Monza --session Q \
        --driver VER --out app/public/data/monza_ver.json

Then in the app, replace useSyntheticReplay() with a fetch of that file.
NOTE: this needs network access to F1's timing API, so run it on your machine,
not in a restricted sandbox.
"""
import argparse
import json
import os
import numpy as np
import pandas as pd
import fastf1


def _series_to_seconds(s: pd.Series) -> np.ndarray:
    """timedelta -> float seconds."""
    return s.dt.total_seconds().to_numpy()


def build_lap_replay(year, gp, session_id, driver, cache_dir=".f1cache"):
    os.makedirs(cache_dir, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)

    session = fastf1.get_session(year, gp, session_id)
    session.load(telemetry=True, laps=True, weather=False, messages=False)

    lap = session.laps.pick_driver(driver).pick_fastest()
    # merged car + position telemetry: X, Y, Speed, Throttle, Brake, nGear, DRS, Time
    tel = lap.get_telemetry()

    # time within the lap, 0-based
    t = _series_to_seconds(tel["Time"])
    t = t - t[0]
    lap_time = float(t[-1])

    # DRS channel: codes 10/12/14 => DRS open/active
    drs_raw = tel["DRS"].to_numpy()
    drs = np.isin(drs_raw, [10, 12, 14]).astype(int)

    X = tel["X"].to_numpy(dtype=float)
    Y = tel["Y"].to_numpy(dtype=float)
    speed = tel["Speed"].to_numpy(dtype=float)      # km/h
    throttle = tel["Throttle"].to_numpy(dtype=float)  # 0-100
    brake = tel["Brake"].to_numpy().astype(int)       # bool -> 0/1
    gear = tel["nGear"].to_numpy().astype(int)

    # resample everything onto a UNIFORM TIME GRID (the schema's `samples`)
    rate = 20  # Hz
    n = int(lap_time * rate)
    grid = np.linspace(0, lap_time, n, endpoint=False)

    def lin(a):   # linear interp for continuous channels
        return np.interp(grid, t, a)

    def nearest(a):  # nearest for discrete channels (gear/brake/drs)
        idx = np.searchsorted(t, grid).clip(0, len(t) - 1)
        return a[idx]

    gx, gy = lin(X), lin(Y)
    gspeed = lin(speed)
    gthrottle = lin(throttle)
    ggear = nearest(gear)
    gbrake = nearest(brake)
    gdrs = nearest(drs)

    samples = [
        {
            "t": round(float(grid[i]), 3),
            "x": round(float(gx[i]), 1),
            "y": round(float(gy[i]), 1),
            "speed": int(round(gspeed[i])),
            "throttle": int(round(gthrottle[i])),
            "brake": int(gbrake[i]),
            "gear": int(ggear[i]),
            "drs": int(gdrs[i]),
        }
        for i in range(n)
    ]

    # circuit info: rotation (degrees) + corner markers, used by the frontend as-is
    ci = session.get_circuit_info()
    corners = [
        {"number": int(r["Number"]), "letter": str(r["Letter"] or ""),
         "x": round(float(r["X"]), 1), "y": round(float(r["Y"]), 1)}
        for _, r in ci.corners.iterrows()
    ]

    try:
        team = lap["Team"]
        color = fastf1.plotting.get_team_color(team, session=session)
    except Exception:
        team, color = "", "#3671C6"

    return {
        "meta": {
            "year": int(year), "event": str(gp), "session": str(session_id),
            "track": str(session.event["EventName"]),
            "rotation": float(ci.rotation),
            "sampleRateHz": rate, "duration": round(n / rate, 3),
            "units": {"speed": "km/h"},
        },
        "track": {
            "startFinish": {"x": samples[0]["x"], "y": samples[0]["y"], "angle": 0.0},
            "corners": corners,
        },
        "cars": [{
            "driver": str(driver), "team": str(team), "color": str(color),
            "samples": samples,
        }],
    }


def build_race_replay(year, gp, cache_dir=".f1cache"):
    """
    Full-grid version — same schema, many cars. The key difference from a single
    lap: every driver's telemetry must be aligned on SESSION TIME (not per-lap
    time) so the cars are shown at the same instant. Left as the scale-up step;
    the frontend already iterates cars[] and needs no changes.
    """
    raise NotImplementedError("Phase 2: align all drivers on session time, then "
                              "build cars[] exactly as above.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--gp", required=True, help="e.g. Monza, 'Italian Grand Prix', or round number")
    ap.add_argument("--session", default="Q", help="FP1/FP2/FP3/Q/S/R")
    ap.add_argument("--driver", default="VER", help="3-letter code, e.g. VER")
    ap.add_argument("--out", default="replay.json")
    a = ap.parse_args()

    data = build_lap_replay(a.year, a.gp, a.session, a.driver)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(data, f)
    s = data["cars"][0]["samples"]
    print(f"wrote {a.out}: {data['meta']['track']} · {a.driver} · "
          f"{len(s)} samples · {data['meta']['duration']}s")
