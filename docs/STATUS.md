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
Since the 2026-10-07 whole-project review, a headless-Chrome layout check gates every
build (Slice 22), the six defects visible on the live gallery are fixed (Slice 23), and
the reference lap is explicit in the contract — `track.referenceLap`, chosen by the
pipeline and read by the gap circuit, the tower's pace and the ribbon (Slice 24).
Quality state on `main`: `npm run check` green with 960 tests and 0 warnings, engine
coverage 100% per file, the layout check 51/51 locally and on ubuntu-latest; 401 pytest
with 100% lines + branches on every module; draw-call fixture digests unchanged since
Slice 16.

**What is open, and what is blocked.** **Slices 22, 23 and 24 are MERGED**
(2026-10-08, #77 → #78 → #79), inserted ahead of the board on the human's direction
after the review, and all thirteen of their decisions were ruled by the human before
merge (PLAN records each). Slice 24 regenerated all five gallery assets offline from
the FastF1 cache, changing only `track.referenceLap`, two start/finish lines (the red
flag's moves off the pole slot onto the timing line) and the finale's missing
`trackStatus`. Open, by ruling: **Slice 25** (short and landscape phones: reconcile the
layout's 200 px track floor with the check's 30% rule, which disagree by 0.1 px at
375x667, then a landscape layout). In the backlog: a pit stop on the focus car's edge
lap is replayed (rain, focus HAM), heading noise on arrival at a stop, `pit_lane`'s
racing line still from `cars[0]`, a timing-line guard for declined cars' reference
laps, and the fixture asymmetry overhaul. **Nothing is blocked**; the standing
constraint remains: `build_replay.py` fetches only from the human's home network
(CLAUDE.md Gotchas) — offline rebuilds from the FastF1 cache work on that machine.

**What happens next.** **The board: 18 → 20**, with Slice 25 filed beside them (not yet
ranked against them by the human) and the fixture asymmetry overhaul behind them.
