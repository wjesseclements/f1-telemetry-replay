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
anchored to the timing loops (9i/9j). The timing tower carries broadcast
semantics (Slice 19) — per-car RETIRED/OFF-LINE/STATIONARY states at the ≤30 Hz
tick, DNF rows at the bottom, no gap quoted unless both cars are racing — and its
reorders ANIMATE (Slice 21, FLIP slides, reduced-motion honoured, the 9m "NO SIG"
rider folded in). The canvas now draws the PIT LANE (Slice 16): the pipeline
detects per-car pit traversals (off-line span + a real stop + real extent, every
threshold inside a measured empty band), emits `track.pitLane` as the union of
polylines cars actually drove (declined cars excluded — 9k's adjudicator must not
be built by the car it will judge), and the app renders it as the circuit ribbon
in miniature, under the ribbon, one retained Path2D, +2 draw calls per frame
regardless of car count; the tower's PIT label is now gated by that geometry
where a file carries it, so a genuine off-track moment reads an em dash instead.
The pipeline's pure half is the `replay_transform` package, one module per
concern, screened by FOUR detectors plus the stuck-channel screen, per-car anchor
plans, and the Slice 16 pit-lane detector.
Quality state on the Slice 16 branch: `npm run check` green with 821 tests and 0
warnings; 320 pytest with 100% lines + branches on every module; drawcall md5s
re-baselined DELIBERATELY (the first canvas change since 9e — +1,402 calls =
2 pit strokes × 701 frames, +1 Path2D, before-md5s reproduced the ledger
bit-for-bit first); fps-probe over the 22-car red flag at 2× — 120 fps, 0 frames
over 20 ms, callback p95 4.10 ms.

**What is open, and what is blocked.** **Slice 16 is BUILT, pending the human's
watch** (2026-09-10): pit-lane geometry end to end — detector, schema field,
regenerated assets (pit cycle, rain, red flag gain `pitLane`; restart regenerated
byte-identical and the finale reverted to its committed bytes, the negative
controls holding), the second ribbon, and the geometry-gated PIT label. The
pre-registered acceptance is in the PLAN entry: NOR and LEC drive a drawn Monza
lane, the rain window's three stops sit in a drawn Silverstone lane, LAW/ALO
launch from a drawn lane at the red flag — and, flagged from measurement rather
than smoothed, the red-flag FIELD never leaves the racing line before its window
ends, so it files toward the drawn lane, never inside it. Before this, **Slice 21
was ACCEPTED** (2026-09-10, watch PASS): FLIP tower animation, `TOWER_MOVE_MS =
300` ratified. **The board after 16 merges: 9k → 18 → 20.** **Nothing is
blocked**; the standing constraint remains: `build_replay.py` runs only from the
human's home network (CLAUDE.md Gotchas).

**What happens next.** **Slice 9k** (adjudicate NOR's declined relocation
structurally, consuming Slice 16's lane geometry) per the board: 9k → 18 → 20,
with the backlog's headline **fixture asymmetry overhaul** behind them. The
housekeeping re-record of the 2024 assets is now HALF closed: pit cycle and rain
picked up their missing `trackStatus` in this slice's regeneration; only the
finale still carries the drift (its fresh build was reverted to keep Slice 16's
diff free of unforced changes).
