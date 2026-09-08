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
anchored to the timing loops (9i/9j). The pipeline's pure half is the
`replay_transform` package, one module per concern, screened by three detectors plus
per-car anchor plans; Slice 17 added `status.py` (track-status intervals) and revised
a doctrine by measurement (out-of-range gear is dirty, not impossible — a wrecked
car's gearbox counter is emitted as neutral and reported). Quality state on the
Slice 17 branch: `npm run check` green with 714 tests and 0 warnings; 260 pytest with
100% lines + branches on every module; drawcall md5s IDENTICAL on both render modes
(the canvas is untouched); the 2024 assets byte-identical; the 22-car frame cost
measured on-instrument at 762.8 draw calls/frame against the linear law's 764.

**What is open, and what is blocked.** **Slice 17 is DONE and PASSED** (2026-09-08):
the first browser pass returned three findings — entry 2's landing (the restart was
STANDING, a survey misreading corrected by the watched race), the A+B flag banner,
and LEC's post-impact "limp" diagnosed read-only as the telemetry feed dying at the
wall (true story in the card, artifact disclosed in the new `provenance.note` until
9l retires it) — all fixed in-branch; the re-check PASSED, the human's copy landed
verbatim, and PR #68 merges by auto-squash. **The board, fully sequenced by the
human (16/9k slotted 2026-09-08, at Slice 9l's start): 9l (dead-feed freeze) →
19 (DNF/retired display: bottom of tower, desaturated, no gap; plus
pit-lane/pre-start gap rules) → 21 (tower reshuffle animation) → 16 (pit-lane
drawing) → 9k (NOR's relocation, adjudicated against 16's pit-lane geometry) →
18 (corner lore) → 20 (Aston/Cadillac colour).** **Nothing is blocked**; the
standing constraint remains: `build_replay.py` runs only from the human's home
network (CLAUDE.md Gotchas).

**What happens next.** **Slice 9l is BUILT and awaiting the human's browser
acceptance** (pre-registered in its PLAN entry: LEC's dot stops in the Parabolica
gravel at replay clock ≈ 2:55 and never moves again; trail gone, marker parked;
everything else pixel-identical). The screen measured an EMPTY false-positive
band (no live car in the 52-window corpus holds zero pedal at pace for 20 s),
froze LEC at his last pedal input, emitted per-car `retiredAt`, and retired the
red-flag entry's known-artifact disclosure. Then 19 → 21 → 16 → 9k → 18 → 20 per
the board, and the backlog's headline **fixture asymmetry overhaul** behind them.
