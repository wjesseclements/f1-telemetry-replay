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
saying OUT, no gap quoted unless both cars are moving on the racing line, a standing
field showing grid order with no numbers until it launches, and a pit-lane car
keeping its row with an em dash instead of a phantom number. The pipeline's pure
half is the `replay_transform` package, one module per concern, screened by three
detectors plus per-car anchor plans. Quality state on the Slice 19 branch:
`npm run check` green with 776 tests and 0 warnings; 273 pytest with 100% lines +
branches on every module; drawcall md5s IDENTICAL on both render modes (the canvas
is untouched); assets, schema and pipeline untouched on disk; the whole tower
derivation measured at 6.0 µs per tick on the 22-car asset.

**What is open, and what is blocked.** **Slice 19 is DONE and ACCEPTED**
(2026-09-09, PR #70, auto-merge enabled): the tower renders the data truthfully —
the second re-watch's 1:52.7 "COL P1" was diagnosed read-only down to its
mechanism, and it is the DATA: F1's feed drops per car once a lap at a fixed spot
in both 2026 Monza windows (78 stuck-speed runs; zero in 2024), freezing speed at
pace while the position dead-reckons forward, and travel-driven placement
amplifies each dropout into a phantom surge until the next anchor. Copy ruled at
acceptance: retired = DNF, off-line = PIT; the restart entry carries a
known-artifact provenance note until the fix ships. **The board, resequenced at
acceptance: 9m (stuck-channel dropout screen — detector corpus-calibrated in the
9-series method, placement bridged across dropouts, 2026 assets regenerated) →
21 (tower reshuffle animation) → 16 (pit-lane drawing) → 9k → 18 → 20.**
**Nothing is blocked**; the standing constraint remains: `build_replay.py` runs
only from the human's home network (CLAUDE.md Gotchas).

**What happens next.** **Slice 9m** — the stuck-channel dropout screen, filed
with its diagnosis already complete in Slice 19's PLAN entry (source-verified
mechanism, blast radius mapped, the HUD's frozen throttle-AND-brake signature
recorded as a second detector input, negative controls named: pit limiter,
flat-out running, the whole 2024 corpus). Then 21 → 16 → 9k → 18 → 20 per the
board, and the backlog's headline **fixture asymmetry overhaul** behind them.
