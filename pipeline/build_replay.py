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

Then load that file in the app with the "Load replay" picker. `app/public/data/` is
gitignored, so generated laps are never committed and the app still boots from its
committed fixture with zero network.

NOTE: this needs network access to F1's timing API, so run it on your machine, never
in CI or a restricted sandbox.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

import fastf1

from replay_transform import (
    OPTIONAL_COLUMNS,
    REQUIRED_COLUMNS,
    SAMPLE_RATE_HZ,
    ReplayMeta,
    TelemetryShapeError,
    build_replay_dict,
    check_columns,
    dump_json,
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
    """Fetch one driver's fastest lap and return it as a schema-conforming dict."""
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
        print(f"team colour lookup failed ({err}); falling back to the default")
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

    return build_replay_dict(
        telemetry,
        meta,
        corners=[row for _, row in circuit.corners.iterrows()],
        rate=SAMPLE_RATE_HZ,
    )


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


def build_race_replay(year, gp, cache_dir=".f1cache"):
    """
    Full-grid version — same schema, many cars. The key difference from a single
    lap: every driver's telemetry must be aligned on SESSION TIME (not per-lap
    time) so the cars are shown at the same instant. Left as the scale-up step;
    the frontend already iterates cars[] and needs no changes.
    """
    raise NotImplementedError(
        "Slice 8: align all drivers on session time, then build cars[] exactly as above."
    )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Fetch one lap of F1 telemetry via FastF1 and emit replay JSON."
    )
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument(
        "--gp", required=True, help="e.g. Monza, 'Italian Grand Prix', or round number"
    )
    ap.add_argument("--session", default="Q", help="FP1/FP2/FP3/Q/S/R")
    ap.add_argument("--driver", default="VER", help="3-letter code, e.g. VER")
    ap.add_argument("--out", default="replay.json")
    ap.add_argument(
        "--no-validate",
        action="store_true",
        help="skip schema validation of the output (NOT recommended)",
    )
    args = ap.parse_args(argv)

    try:
        data = build_lap_replay(args.year, args.gp, args.session, args.driver)
    except TelemetryShapeError as err:
        raise SystemExit(f"telemetry cannot produce a valid replay: {err}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dump_json(data))

    samples = data["cars"][0]["samples"]
    has_drs = "drs" in samples[0]
    print(
        f"wrote {out}: {data['meta']['track']} · {args.driver} · "
        f"{len(samples)} samples · {data['meta']['duration']}s @ "
        f"{data['meta']['sampleRateHz']} Hz · drs {'present' if has_drs else 'omitted'}"
    )

    if args.no_validate:
        print("WARNING: --no-validate: output was NOT checked against the schema.")
    else:
        validate_output(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
