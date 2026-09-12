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
plans, the Slice 16 pit-lane detector, and — new in Slice 9k — a STRUCTURAL
ADJUDICATION input: a named, per-session ruling can hand the frame-displacement
repair an out-jump the ratio gate cannot see, and the machinery's own unchanged
cancellation test still decides.
Quality state on the Slice 9k branch: `npm run check` green with 821 tests and 0
warnings (zero app-code changes — the slice is pipeline + one asset); 329 pytest
with 100% lines + branches on every module; drawcall baselines untouched (canvas
and fixture untouched).

**What is open, and what is blocked.** **Slice 9k is DONE and ACCEPTED**
(2026-09-12, watch PASS — NOR rated 99%, new baseline VER 97 / HAM 97 / NOR 99,
9i's severity ranking retired). NOR's declined 41.7 m relocation was adjudicated
against Slice 16's geometry, read-only and pre-registered, and the answer was
decisive — with a reframe: the flagged jump is the RETURN of a bounded
displacement whose out step (30.3 m at 1.96× its own allowance) hid under the
ratio-3 gate, so once that step is admitted on the geometry's evidence the pair
CANCELS under the standard test (13.6 m of 18.8 m allowed) and the standard
translation runs — no bespoke repair path exists. Results: NOR's held-out
placement 38.9/47.6 → 11.8/9.6 m (the instrument's noise floor), reversal
7 → 0 windows over 2.0, the HAM-NOR S/F gap error 0.59 → 0.07 s (9h's broken
correlation repaired by fixing, as its entry predicted), HAM and VER
byte-identical, all other assets untouched. One pre-registered deviation,
flagged and both RATIFIED: `track.pitLane` re-elected to NOR's (longest)
traversal — same lane, 0–3.8 m from VER's — and no label at 6:19 (the repaired
car is on the racing line there; PIT runs ≈6:30–6:57). The watch confirmed the
zigzag gone and the entry clean. Before it, **Slice 16 was ACCEPTED**
(2026-09-11, PR #73, re-watch PASS): pit-lane geometry end to end,
envelope-joined ends ratified. **The board: 18 → 20.** **Nothing is blocked**;
the standing constraint remains: `build_replay.py` runs only from the human's
home network (CLAUDE.md Gotchas).

**What happens next.** **Slice 18** per the board: 18 → 20, with the backlog's
headline **fixture asymmetry overhaul** behind them. Housekeeping unchanged:
only the FINALE still carries the `trackStatus` drift (pit cycle and rain picked
theirs up in Slice 16's re-record; 9k's rain rebuild keeps it).
