# STATUS — read this before PLAN.md

The front page, not the ledger. PLAN.md holds every slice with its evidence; this page
holds where the project stands right now, in three paragraphs, for a new reader or a
fresh session. It is updated in the PR that changes what it says — if it disagrees with
PLAN.md, PLAN.md wins and this page is the bug.

**Where the project is.** v1 (one car, one lap) and v2 (multi-car race replay on the
same engine and schema) are both shipped, `main` deploys to production via Vercel, and
the site opens on a five-scenario gallery of real F1 data: the 2026 Italian GP
red-flag pair (Slice 17 — the first 2026 session, a full 22-car field, track-status
flags on the transport bar, and a chained event card narrating the stoppage) plus the
Silverstone 2024 finale and rain and the Monza 2024 pit cycle — with per-car laps and
stints, a leader-lap counter, a speed-trace comparison overlay, and placement
anchored to the timing loops (9i/9j). The timing tower now carries broadcast
semantics (Slice 19): per-car RETIRED/OFF-LINE/STATIONARY states derived at the
≤30 Hz tick from data the file already carries, a retired car at the bottom in grey
saying DNF, no gap quoted unless both cars are moving on the racing line, a standing
field showing grid order with no numbers until it launches, and a pit-lane car
keeping its row. The tower's reorders now ANIMATE (Slice 21): FLIP
slides driven by the Web Animations API — compositor-only transforms, a per-commit
measure pass at the ≤30 Hz tick, mid-animation resorts retargeted from the row's
current visual position — with a replay/scenario switch deliberately snapping (no
false continuity), reduced-motion honoured, and the 9m rider folded in (a one-line
"NO SIG" where the width budget rules, full words in the readout and every
accessible name). The pipeline's pure half is the `replay_transform` package, one
module per concern, screened by FOUR detectors (frame-displacement, impossible-fix,
reversal, dead-feed) plus the Slice 9m stuck-channel screen and per-car anchor plans.
Quality state on the Slice 21 branch: `npm run check` green with 799 tests and 0
warnings; 293 pytest with 100% lines + branches on every module; drawcall md5s
IDENTICAL on both render modes (the canvas is untouched); fps-probe over the
restart launch at 2× — 0 frames over 20 ms, callback p95 4.2 ms.

**What is open, and what is blocked.** **Slice 21 is BUILT and awaiting the
acceptance watch** (2026-09-10, branch `feat/slice-21-tower-animation`): the tower
reshuffle animation, with the pre-registered `TOWER_MOVE_MS = 300` / ease-out
written into PLAN before the watch, and the "NO SIG" compact spelling pending the
human's copy ruling. The acceptance scene is the restart launch at 2× — following
COL's P5→P2→P7 arc by eye — plus the 2024 pit cycle's swaps reading as moves.
Before it, **Slice 9m shipped** (2026-09-10,
PR #71): the stuck-channel dropout screen — F1's feed drops per car once a lap in
both 2026 Monza windows, and 9m detects each dropout by its physically-impossible
signature (37 firings in 2026, zero across the 2024 corpus), bridges it along the
recorded polyline (which dead-reckons the racing line, ≤ 0.8 m off, measured), and
shows NO SIGNAL through it as a new DROPOUT state; COL's phantom P1 is gone (gap to
the leader monotone, never crossing RUS) and the restart's known-artifact
`provenance.note` is retired. **The board: 16 (pit-lane drawing) → 9k → 18 → 20.**
**Nothing is blocked**; the standing constraint remains: `build_replay.py` runs
only from the human's home network (CLAUDE.md Gotchas).

**What happens next.** The Slice 21 acceptance watch, then **Slice 16** (pit-lane
drawing) per the board: 16 → 9k → 18 → 20, with the backlog's headline **fixture
asymmetry overhaul** behind them. One housekeeping item is filed: a re-record of
the three 2024 gallery assets, stale on `trackStatus` since Slice 17 (9m proved it
left them byte-identical).
