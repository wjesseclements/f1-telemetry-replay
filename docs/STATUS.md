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
keeping its row. The pipeline's pure half is the `replay_transform` package, one
module per concern, screened by FOUR detectors (frame-displacement, impossible-fix,
reversal, dead-feed) plus the Slice 9m stuck-channel screen and per-car anchor plans.
Quality state on the Slice 9m branch: `npm run check` green with 783 tests and 0
warnings; 293 pytest with 100% lines + branches on every module; drawcall md5s
IDENTICAL on both render modes (the canvas is untouched); the two 2026 assets
regenerated, all three 2024 assets byte-identical old-code vs new-code.

**What is open, and what is blocked.** **Slice 9m is DONE, awaiting the human's
watch** (2026-09-09, branch `feat/slice-9m-stuck-channel`, not pushed): the
stuck-channel dropout screen. Slice 19's 1:52.7 "COL P1" was the DATA — F1's feed
drops per car once a lap at a fixed spot in both 2026 Monza windows, freezing speed
at pace while the position dead-reckons forward, and travel-driven placement
amplifies each dropout into a phantom surge. 9m detects each dropout on the raw
source by its physically-impossible signature (throttle-and-brake saturation, a
frozen position at pace, or an ≥8 g resume snap — 37 firings in 2026, zero across
the 2024 corpus, where the pit limiter's genuinely-constant 9 s at ~80 km/h is the
decisive negative control that duration alone cannot separate), then bridges the
placement across the span (speed and polyline chorded between trusted edges, pedals
coasted, edges anchored) so it re-syncs at resume. Measured against the timing
loops on the shipped restart asset: **COL's gap to the leader goes from +76 m ahead
(the phantom P1) to a monotone −4 m — it never crosses RUS**; no affected car is
left falsely at the front; placement scatter and reversal fall for COL/PIA/ALO. A
per-car `dropouts` interval lands in the schema for a later HUD "no signal"
treatment. Copy from Slice 19 stands (retired = DNF, off-line = PIT); the restart's
known-artifact `provenance.note` is retired. **The board: 21 (tower reshuffle
animation) → 16 (pit-lane drawing) → 9k → 18 → 20.** **Nothing is blocked**; the
standing constraint remains: `build_replay.py` runs only from the human's home
network (CLAUDE.md Gotchas).

**What happens next.** The human watches the restart scenario at 0.5× to accept
9m (pre-registered in its PLAN entry: COL stays in the pack into della Roggia, no
surge and no snap-back; GAS likewise near the front with no throttle-and-brake HUD
readout). Then **Slice 21** — the tower reshuffle animation — then 16 → 9k → 18 →
20 per the board, and the backlog's headline **fixture asymmetry overhaul** behind
them. Two smaller items surfaced by 9m are filed in the backlog: the HUD "no
signal" treatment of the new `dropouts` intervals, and a housekeeping re-record of
the three 2024 gallery assets (stale on `trackStatus` since Slice 17).
