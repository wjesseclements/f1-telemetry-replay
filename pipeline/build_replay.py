#!/usr/bin/env python3
"""
build_replay.py — fetch real F1 telemetry via FastF1 and emit replay JSON.

This is the ONLY module that touches the network, and it holds no resampling logic:
the maths lives in `replay_transform.py`, which imports numpy and nothing else and is
covered by pytest. Fetching and transforming are split precisely so that the part
which can be tested, is.

The output is validated against `app/src/engine/schema.ts` — the single contract —
before this script exits, by running the app's REAL `parseReplay` over the file just
written. A pipeline change that emits schema-invalid JSON therefore fails here,
loudly, rather than in front of a human wondering why the page is blank.

Setup
-----
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt          # FastF1 3.8+, Python 3.10+

Run (single fast lap, e.g. Verstappen, 2024 Monza qualifying)
-------------------------------------------------------------
    python build_replay.py --year 2024 --gp Monza --session Q \
        --driver VER --out ../app/public/data/monza_ver.json

Run (v2: several cars over a shared session-time window)
--------------------------------------------------------
    python build_replay.py --year 2024 --gp Monza --session R \
        --drivers VER,LEC,NOR --laps 12-14 \
        --out ../app/public/data/monza_race.json

`--laps` is what switches modes. The window is the FIRST driver's lap range, in
session time, and every driver is resampled onto one grid derived from it — so
`cars[k]` is the same instant for everybody (CLAUDE.md rule 5). Naming the window by
laps rather than by raw seconds is a correctness choice, not an ergonomic one; see
`resolve_lap_window`.

Then load that file in the app with the "Load replay" picker. `app/public/data/` is
gitignored, so generated laps are never committed and the app still boots from its
committed fixture with zero network.

NOTE: this needs network access to F1's timing API, so run it on your machine, never
in CI or a restricted sandbox.
"""

from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import fastf1

# Imported explicitly: a bare `import fastf1` does NOT bind the `plotting` submodule,
# so `fastf1.plotting.get_team_color` raised AttributeError on every run and the
# `except` below quietly handed every real lap the fallback colour.
import fastf1.plotting

from replay_transform import (
    OPTIONAL_COLUMNS,
    REQUIRED_COLUMNS,
    SAMPLE_RATE_HZ,
    ReplayMeta,
    SessionMeta,
    TelemetryShapeError,
    build_replay_dict,
    build_window_replay_dict,
    check_columns,
    closing_time,
    color_lookup_warning,
    dump_json,
    parse_lap_range,
    time_base_stretch,
    motion_fidelity,
    window_car_report,
    WindowCar,
)

#: Repo-relative location of the app, resolved from this file so the validator can be
#: found no matter which directory the pipeline is run from.
APP_DIR = Path(__file__).resolve().parent.parent / "app"


def _pick_driver_laps(laps, driver: str):
    """
    `Laps.pick_driver` was renamed `pick_drivers` in FastF1 3.4 and the old name is
    deprecated. Prefer the new one, fall back to the old, so the script works across
    the range `requirements.txt` allows without parsing a version string.
    """
    picker = getattr(laps, "pick_drivers", None)
    if picker is not None:
        return picker(driver)
    return laps.pick_driver(driver)


def build_lap_replay(year, gp, session_id, driver, cache_dir=".f1cache"):
    """
    Fetch one driver's fastest lap and return `(replay, recorded_s, closing_s)`.

    The two times come back alongside the replay so `main` can report the time base
    the transform actually used: what the telemetry recorded, what had to be added to
    close the loop, and the resulting stretch onto the grid. All three are small and
    deliberate — see `replay_transform.closing_time` and `time_base_stretch` — and
    printing them is what keeps them decisions rather than surprises.
    """
    os.makedirs(cache_dir, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)

    session = fastf1.get_session(year, gp, session_id)
    session.load(telemetry=True, laps=True, weather=False, messages=False)

    lap = _pick_driver_laps(session.laps, driver).pick_fastest()
    if lap is None or lap.empty:
        raise SystemExit(f"no laps found for driver {driver!r} in this session")

    # Merged car + position telemetry: X, Y, Speed, Throttle, Brake, nGear, DRS, Time.
    tel = lap.get_telemetry()

    # Print what actually arrived before trusting any channel. FastF1 renames and
    # reshapes columns between versions; this line plus `check_columns` turns that
    # from a KeyError in the middle of the maths into a named list.
    print(f"telemetry columns ({len(tel)} rows): {', '.join(map(str, tel.columns))}")
    check_columns(tel.columns)
    absent = [name for name in OPTIONAL_COLUMNS if name not in set(tel.columns)]
    if absent:
        print(f"optional channel(s) absent, will be omitted from output: {', '.join(absent)}")

    telemetry = {
        name: tel[name].to_numpy()
        for name in REQUIRED_COLUMNS + OPTIONAL_COLUMNS
        if name in tel.columns
    }
    # `Time` is a timedelta column; the transform wants plain seconds.
    telemetry["Time"] = tel["Time"].dt.total_seconds().to_numpy()

    circuit = session.get_circuit_info()

    try:
        team = lap["Team"]
        color = fastf1.plotting.get_team_color(team, session=session)
    except Exception as err:  # noqa: BLE001 - a colour is not worth failing a fetch
        print(color_lookup_warning(driver, err))
        team, color = "", ""

    meta = ReplayMeta(
        year=int(year),
        event=str(gp),
        session=str(session_id),
        track=str(session.event["EventName"]),
        driver=str(driver),
        team=str(team),
        color=color,
        rotation=float(circuit.rotation),
    )

    replay = build_replay_dict(
        telemetry,
        meta,
        corners=[row for _, row in circuit.corners.iterrows()],
        rate=SAMPLE_RATE_HZ,
    )
    # Reported so the numbers behind the emitted time base are visible: what the
    # telemetry recorded, and how much had to be added to close the loop. Both are
    # what `build_replay_dict` itself resampled against.
    times = telemetry["Time"]
    recorded = float(times[-1] - times[0])
    closing = closing_time(
        times, telemetry["X"], telemetry["Y"], telemetry["Speed"]
    )
    return replay, recorded, closing


def validate_output(path: Path) -> None:
    """
    Run the app's real schema validator over the file just written.

    Deliberately a hard failure rather than a warning: the whole point is that
    schema-invalid JSON never reaches a human's browser. A missing toolchain is
    likewise an error with instructions, not a silent skip — a skipped check that
    looks like a pass is worse than no check at all. `--no-validate` is the explicit
    escape hatch.
    """
    if shutil.which("npm") is None:
        raise SystemExit(
            "cannot validate: `npm` is not on PATH.\n"
            "Install Node 22+, or re-run with --no-validate to skip validation "
            "(the output will NOT have been checked against the schema)."
        )
    if not (APP_DIR / "node_modules").is_dir():
        raise SystemExit(
            f"cannot validate: {APP_DIR}/node_modules is missing.\n"
            "Run `cd app && npm ci` first, or re-run with --no-validate to skip "
            "validation (the output will NOT have been checked against the schema)."
        )

    result = subprocess.run(
        ["npm", "run", "--silent", "validate:replay", "--", str(path.resolve())],
        cwd=APP_DIR,
    )
    if result.returncode != 0:
        raise SystemExit(
            f"\n{path} does NOT conform to the schema (see the errors above). "
            "The file was written but must not be loaded."
        )


#: Seconds of telemetry kept either side of the window, so interpolation at the
#: window's own edges has real neighbours instead of clamping against them.
WINDOW_PAD_S = 2.0

#: Slice 6b's acceptance bar for "the marker moves at the speed the HUD shows",
#: applied per car on every window build. 6b measured 0.70 before its fix and 0.9998
#: after, against this target.
MOTION_FIDELITY_TARGET_R = 0.97


def _team_and_color(session, laps, driver):
    """A driver's team and its colour, with the same non-fatal fallback a lap uses."""
    try:
        team = laps.iloc[0]["Team"]
        return str(team), fastf1.plotting.get_team_color(team, session=session)
    except Exception as err:  # noqa: BLE001 - a colour is not worth failing a fetch
        print(color_lookup_warning(driver, err))
        return "", ""


def _session_seconds(column):
    """A FastF1 timedelta column as plain seconds on the SESSION axis."""
    return column.dt.total_seconds().to_numpy()


def _driver_window_telemetry(session, driver, t0, t1):
    """
    One driver's telemetry over `[t0, t1]` session seconds, on the SHARED axis.

    The `Time` key handed back is SessionTime, not the per-lap time `build_lap_replay`
    uses — that substitution is the whole of CLAUDE.md rule 5, and it is made here in
    the fetch layer rather than in `replay_transform`, which never learns what
    "session time" means and only ever sees a monotone axis with an origin someone
    else chose.

    A margin is kept either side so the first and last grid points interpolate
    between real fixes. Rows outside it are dropped rather than carried: the
    normalisation in `resample_positions_by_travel` is estimated from whatever slice
    it is given, so handing it a whole race for one driver and a three-lap window for
    another would silently scale them differently.
    """
    laps = _pick_driver_laps(session.laps, driver)
    if laps is None or len(laps) == 0:
        raise SystemExit(f"no laps found for driver {driver!r} in this session")

    tel = laps.get_telemetry()
    check_columns(tel.columns)
    if "SessionTime" not in tel.columns:
        raise SystemExit(
            f"{driver}: telemetry has no SessionTime column (got: "
            f"{', '.join(map(str, tel.columns))}); multi-car alignment needs it"
        )

    session_s = _session_seconds(tel["SessionTime"])
    keep = (session_s >= t0 - WINDOW_PAD_S) & (session_s <= t1 + WINDOW_PAD_S)
    rows = tel[keep]
    covered = session_s[keep]
    if len(covered) < 2:
        raise SystemExit(
            f"{driver} has {len(covered)} telemetry row(s) inside the window "
            f"{t0:.2f}s-{t1:.2f}s; they were not on track for it. Drop them from "
            "--drivers, or choose a lap range they ran."
        )

    telemetry = {
        name: rows[name].to_numpy()
        for name in REQUIRED_COLUMNS + OPTIONAL_COLUMNS
        if name in rows.columns
    }
    telemetry["Time"] = covered

    team, color = _team_and_color(session, laps, driver)
    car = WindowCar(driver=str(driver), team=team, color=color, telemetry=telemetry)
    return car, (float(covered[0]), float(covered[-1]))


def resolve_lap_window(session, driver, first_lap, last_lap):
    """
    The session-time window spanned by a REFERENCE driver's laps `first..last`.

    A window is named by laps rather than by raw session seconds for two reasons that
    are about correctness, not ergonomics (though nobody knows when lap 12 was
    either). A whole-lap window starts and ends on the start/finish line, so:

    * `track.startFinish`, taken from the reference car's first sample, is the line;
    * the renderer's ribbon — traced from `cars[0]` and closed with `closePath` —
      actually closes, instead of drawing a chord across the infield.

    Both would be silent visual lies with an arbitrary `t0`, and both cost nothing to
    avoid. See PLAN.md Slice 8.
    """
    laps = _pick_driver_laps(session.laps, driver)
    chosen = laps[
        (laps["LapNumber"] >= first_lap) & (laps["LapNumber"] <= last_lap)
    ]
    if len(chosen) == 0:
        raise SystemExit(
            f"{driver} has no laps {first_lap}-{last_lap} in this session "
            f"(recorded laps: {int(laps['LapNumber'].min())}-"
            f"{int(laps['LapNumber'].max())})"
        )

    starts = _session_seconds(chosen["LapStartTime"])
    lap_times = _session_seconds(chosen["LapTime"])
    t0 = float(starts[0])

    # The window ends where the last chosen lap ends. FastF1 leaves `LapTime` as NaT
    # on some laps (an in/out lap, or one cut by a red flag), and a NaN would
    # propagate all the way to a nonsense grid — so it is caught here and named,
    # rather than estimated. Guessing the end of the window would guess how much of
    # the race the file contains.
    if math.isnan(lap_times[-1]):
        raise SystemExit(
            f"{driver} lap {last_lap} has no recorded lap time (FastF1 leaves it "
            "unset on in/out laps and red-flagged laps), so the window has no "
            "defined end. Choose a lap range of clean laps."
        )
    return t0, float(starts[-1] + lap_times[-1])


def build_race_replay(year, gp, session_id, drivers, laps, cache_dir=".f1cache"):
    """
    Fetch several drivers over a shared session-time window and return
    `(replay, window, cars)`.

    The v2 shape. Every driver is resampled onto ONE grid derived from the window, so
    sample k of every car is the same instant — which is what `cars[]` being an array
    has been waiting for since Slice 2, and why the app needs no change to render it.

    `drivers[0]` is the reference: the window is its lap range, and it supplies the
    replay's start/finish line.
    """
    os.makedirs(cache_dir, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)

    session = fastf1.get_session(year, gp, session_id)
    session.load(telemetry=True, laps=True, weather=False, messages=False)

    first_lap, last_lap = laps
    t0, t1 = resolve_lap_window(session, drivers[0], first_lap, last_lap)
    print(
        f"window from {drivers[0]} laps {first_lap}-{last_lap}: "
        f"session {t0:.2f}s -> {t1:.2f}s ({t1 - t0:.2f}s)"
    )

    window_cars = []
    coverage = {}
    for driver in drivers:
        car, covered = _driver_window_telemetry(session, driver, t0, t1)
        window_cars.append(car)
        coverage[driver] = covered
        print(
            f"  {driver}: {len(car.telemetry['Time'])} source rows covering "
            f"{covered[0]:.2f}s -> {covered[1]:.2f}s"
        )

    circuit = session.get_circuit_info()
    meta = SessionMeta(
        year=int(year),
        event=str(gp),
        session=str(session_id),
        track=str(session.event["EventName"]),
        rotation=float(circuit.rotation),
    )

    replay = build_window_replay_dict(
        window_cars,
        meta,
        (t0, t1),
        corners=[row for _, row in circuit.corners.iterrows()],
        rate=SAMPLE_RATE_HZ,
    )
    return replay, (t0, t1), window_cars, coverage


def report_window(replay, window, cars, coverage) -> None:
    """
    Print the numbers behind a window build, for the same reason `build_lap_replay`
    prints its closing chord and time-base stretch: a deliberate approximation should
    still be impossible to be surprised by.

    The one worth reading is MOTION FIDELITY — Slice 6b's `r` and ratio-spread
    metric, now computed per car on every build instead of by hand once. It answers
    the question Slice 9's relative gaps actually rest on: does each car's marker
    move at the speed its own telemetry claims?
    """
    t0, t1 = window
    n = len(replay["cars"][0]["samples"])
    rate = replay["meta"]["sampleRateHz"]
    print(
        f"window {t0:.2f}s -> {t1:.2f}s ({t1 - t0:.2f}s) · {len(replay['cars'])} cars "
        f"· {n} samples each @ {rate} Hz · duration {replay['meta']['duration']}s · "
        f"open, no closing chord · time base 1.000000x"
    )

    poor = []
    for (driver, moved, distance), car in zip(window_car_report(cars), replay["cars"]):
        start, end = coverage[driver]
        partial = ""
        if start > t0 + 1.0 / rate or end < t1 - 1.0 / rate:
            partial = f" · PARTIAL coverage {start:.2f}s -> {end:.2f}s"
        if not moved:
            print(f"  {driver}: PARKED (held positions, no path placement){partial}")
            continue

        fidelity = motion_fidelity(car["samples"], rate)
        if fidelity is None:
            print(f"  {driver}: {distance:.0f} m · motion fidelity unavailable{partial}")
            continue
        corr, spread = fidelity
        if corr < MOTION_FIDELITY_TARGET_R:
            poor.append((driver, corr))
        print(
            f"  {driver}: {distance:.0f} m · motion fidelity r={corr:.4f} "
            f"spread={spread:.4f}{partial}"
        )

    if poor:
        # 6b's own bar, applied automatically. Below it the marker's apparent speed
        # stops agreeing with the HUD — the exact defect 6b existed to remove — so it
        # is worth knowing before the file becomes somebody's demo. Loud, not fatal:
        # the output is still schema-valid and still worth looking at.
        names = ", ".join(f"{driver} (r={corr:.4f})" for driver, corr in poor)
        print(
            f"\nWARNING: motion fidelity below {MOTION_FIDELITY_TARGET_R} for: "
            f"{names}.\n"
            f"  Their markers will not move at the speed their own telemetry "
            f"reports — the defect Slice 6b removed for laps. Check the source "
            f"telemetry for those drivers over this window before using the "
            f"replay; see `replay_transform.motion_fidelity`.\n"
        )

    size_mb = len(dump_json(replay)) / 1e6
    print(f"  estimated file size: {size_mb:.1f} MB")
    if size_mb > 20.0:
        print(
            f"\nWARNING: {size_mb:.0f} MB is a lot to push through a file picker.\n"
            f"  Narrow the lap range or the driver list; a full race grid is tens of "
            f"megabytes and is not what the window exists to produce.\n"
        )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Fetch F1 telemetry via FastF1 and emit replay JSON: one driver's "
            "fastest lap, or (with --laps) a multi-car session-time window."
        )
    )
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument(
        "--gp", required=True, help="e.g. Monza, 'Italian Grand Prix', or round number"
    )
    ap.add_argument("--session", default="Q", help="FP1/FP2/FP3/Q/S/R")
    ap.add_argument("--driver", default="VER", help="3-letter code, e.g. VER")
    ap.add_argument("--out", default="replay.json")
    # --- race window (v2) ---------------------------------------------------------
    # `--laps` is the switch between the two modes, and it is the lap RANGE rather
    # than a session-time range on purpose: a whole-lap window starts and ends on the
    # start/finish line, which is what keeps `track.startFinish` honest and the
    # rendered ribbon closed. See `resolve_lap_window`.
    ap.add_argument(
        "--laps",
        help=(
            "reference driver's lap range, e.g. 12-14. Switches to multi-car "
            "session-time window mode."
        ),
    )
    ap.add_argument(
        "--drivers",
        help=(
            "comma-separated codes for window mode, e.g. VER,LEC,NOR. The FIRST is "
            "the reference driver whose laps define the window. Defaults to --driver."
        ),
    )
    ap.add_argument(
        "--no-validate",
        action="store_true",
        help="skip schema validation of the output (NOT recommended)",
    )
    args = ap.parse_args(argv)

    if args.drivers is not None and args.laps is None:
        raise SystemExit(
            "--drivers selects the cars in a session-time WINDOW, which is named by "
            "--laps. Add --laps A-B, or use --driver for a single fastest lap."
        )

    if args.laps is not None:
        return _run_window(args)
    return _run_lap(args)


def _run_window(args) -> int:
    drivers = [
        code.strip().upper()
        for code in (args.drivers or args.driver).split(",")
        if code.strip()
    ]
    lap_range = parse_lap_range(args.laps)

    try:
        data, window, cars, coverage = build_race_replay(
            args.year, args.gp, args.session, drivers, lap_range
        )
    except TelemetryShapeError as err:
        raise SystemExit(f"telemetry cannot produce a valid replay: {err}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dump_json(data))

    print(
        f"wrote {out}: {data['meta']['track']} · "
        f"{', '.join(car['driver'] for car in data['cars'])}"
    )
    report_window(data, window, cars, coverage)

    if args.no_validate:
        print("WARNING: --no-validate: output was NOT checked against the schema.")
    else:
        validate_output(out)
    return 0


def _run_lap(args) -> int:
    try:
        data, recorded, closing = build_lap_replay(
            args.year, args.gp, args.session, args.driver
        )
    except TelemetryShapeError as err:
        raise SystemExit(f"telemetry cannot produce a valid replay: {err}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dump_json(data))

    samples = data["cars"][0]["samples"]
    has_drs = "drs" in samples[0]
    rate = data["meta"]["sampleRateHz"]
    stretch = time_base_stretch(len(samples), recorded + closing, rate)
    # Closing the loop should cost a small FRACTION of a grid step — Monza Q measured
    # 0.07 and 0.24 of one (0.67 m and 2.12 m against a ~9 m step). Reported as that
    # fraction rather than as milliseconds because the fraction is the number with a
    # threshold attached, and because it is scale-free across sample rates and tracks.
    closing_steps = closing * rate
    print(
        f"wrote {out}: {data['meta']['track']} · {args.driver} · "
        f"{len(samples)} samples · {data['meta']['duration']}s @ "
        f"{data['meta']['sampleRateHz']} Hz · drs {'present' if has_drs else 'omitted'}"
    )
    # Small, deliberate, and stated out loud rather than buried: the lap the replay
    # loops is the recorded telemetry plus the chord back to its start, and that lap
    # is then stretched onto a whole number of grid steps. See replay_transform's
    # `closing_time` and `time_base_stretch`.
    print(
        f"lap {recorded:.3f}s recorded + {closing * 1000:.0f}ms to close the loop "
        f"({closing_steps:+.2f} of a grid step) · "
        f"time base stretched {stretch:.5f}x onto the grid"
    )
    # The tripwire for the case the synthetic tests can only simulate: telemetry that
    # leaves more than a whole grid step unrecorded (or runs more than one past the
    # line). Beyond that the closing chord is no longer a rounding correction — the
    # last samples pile up on the final fix, and the lap length itself is suspect.
    # Loud rather than fatal: the output is still schema-valid and still worth looking
    # at, but nobody should discover this by wondering why the car stalls at the line.
    if abs(closing_steps) > 1.0:
        print(
            f"\nWARNING: closing the loop costs {closing_steps:+.2f} grid steps, more "
            f"than one whole step of travel.\n"
            f"  The telemetry for this lap does not run from the line back to the "
            f"line — it is short (or long) by more than a sample.\n"
            f"  The emitted lap length is therefore a guess built on that gap, and the "
            f"samples nearest the line may repeat the final fix.\n"
            f"  Check the source lap before using this replay; see "
            f"`replay_transform.closing_time`.\n"
        )

    if args.no_validate:
        print("WARNING: --no-validate: output was NOT checked against the schema.")
    else:
        validate_output(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
