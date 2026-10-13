# STATUS — read this before PLAN.md

The front page, not the ledger. PLAN.md holds every slice with its evidence; this page
holds where the project stands right now, in three paragraphs, for a new reader or a
fresh session. It is updated in the PR that changes what it says — if it disagrees
with PLAN.md, PLAN.md wins and this page is the bug.

**Where the project is.** v1 (one car, one lap) and v2 (multi-car race replay on the
same engine and schema) are both shipped, `main` deploys to production via Vercel, and
the site opens on a five-scenario gallery of real F1 data: the 2026 Italian GP
red-flag pair (Slice 17 — the first 2026 session, a full 22-car field, track-status
flags on the transport bar, and a chained event card narrating the stoppage) plus the
Silverstone 2024 finale and rain and the Monza 2024 pit cycle — with per-car laps and
stints, a leader-lap counter, a speed-trace comparison overlay, and placement anchored
to the timing loops (9i/9j). The timing tower carries broadcast semantics (Slice 19) —
per-car RETIRED/OFF-LINE/STATIONARY states at the ≤30 Hz tick, DNF rows at the bottom,
no gap quoted unless both cars are racing — and its reorders ANIMATE (Slice 21, FLIP
slides, reduced-motion honoured, the 9m "NO SIG" rider folded in). The canvas now
draws the PIT LANE (Slice 16): the pipeline detects per-car pit traversals (off-line
span + a real stop + real extent, every threshold inside a measured empty band), emits
`track.pitLane` as the union of polylines cars actually drove (declined cars excluded
— 9k's adjudicator must not be built by the car it will judge), and the app renders it
as the circuit ribbon in miniature, under the ribbon, one retained Path2D, +2 draw
calls per frame regardless of car count; the tower's PIT label is now gated by that
geometry where a file carries it, so a genuine off-track moment reads an em dash
instead. The pipeline's pure half is the `replay_transform` package, one module per
concern, screened by FOUR detectors plus the stuck-channel screen, per-car anchor
plans, the Slice 16 pit-lane detector, and — new in Slice 9k — a STRUCTURAL
ADJUDICATION input: a named, per-session ruling can hand the frame-displacement repair
an out-jump the ratio gate cannot see, and the machinery's own unchanged cancellation
test still decides. Since the 2026-10-07 whole-project review, a headless-Chrome
layout check gates every build (Slice 22), the six defects visible on the live gallery
are fixed (Slice 23), and the reference lap is explicit in the contract —
`track.referenceLap`, chosen by the pipeline and read by the gap circuit, the tower's
pace and the ribbon (Slice 24); short and landscape phones get a usable track and
tower (Slice 25), phones get a full-screen gallery and a modal overlay (Slice 26), and
phones get thin bars with 44 px touch targets (upright up to 800 px tall), an
installable home-screen app, and — on the shortest landscape phones — the header above
the tower so the track runs the full height (Slice 27). Quality state on `main`: `npm
run check` green with 1092 tests and 0 warnings, engine coverage 100% per file, the
layout check 186/186 over ten viewports, Safari's landscape 724x257 now among them
(Slices 26–27); 401 pytest with 100% lines + branches on every module; draw-call
fixture digests unchanged since Slice 16.

**What is open, and what is blocked.** **Slices 22, 23 and 24 are MERGED**
(2026-10-08, #77 → #78 → #79), inserted ahead of the board on the human's direction
after the review, and all thirteen of their decisions were ruled by the human before
merge (PLAN records each). Slice 24 regenerated all five gallery assets offline from
the FastF1 cache, changing only `track.referenceLap`, two start/finish lines (the red
flag's moves off the pole slot onto the timing line) and the finale's missing
`trackStatus`. **Slice 25** (short and landscape phones) is built as ruled on
2026-10-08: track and tower side by side on any screen 5:4 or wider, a 256 px sub-md
sidebar that keeps the wrapping readout, the header's meta line on one row on 5:4+ or
≤ 700 px-tall screens, the layout meeting the check's canvas floor with the check
unchanged, and seven gated viewports. In the backlog: scrolling the focused car into
view on focus change, the md column readout on 768 px+ landscape phones, a pit stop on
the focus car's edge lap is replayed (rain, focus HAM), heading noise on arrival at a
stop, `pit_lane`'s racing line still from `cars[0]`, a timing-line guard for declined
cars' reference laps, and the fixture asymmetry overhaul. **Nothing is blocked**; the
standing constraint remains: `build_replay.py` fetches only from the human's home
network (CLAUDE.md Gotchas) — offline rebuilds from the FastF1 cache work on that
machine.

**What happens next.** **Slice 26** (phone-first, measured against Safari's real
viewports, from the human's 2026-10-11 phone check) is built with every ruling of
2026-10-12 applied and is PR #81: on phones the gallery and the event card cover the
whole screen with a pinned 44 px Close and the page behind them inert; a screen at
most 480 px tall counts as a phone (a Plus/Pro Max iPhone held sideways); the track's
margins scale with the canvas; the tower scrolls the focused car into view; and the
layout check gains 375x626 and 814x312 and a direct "panel covers the viewport" row on
every phone viewport (167 rows over nine). **Slice 27** (compact bars with 44 px touch
targets, and Add to Home Screen as "F1 Telemetry") is built on top of it as PR #82
with icon A and two batches of the human's rulings applied; the compact controls' look
waits for the human's phone check and the "Load replay JSON" wording for the human's
pick. A real-iPhone check is the missing evidence for both. Then **the board: 18 →
20**, with the fixture asymmetry overhaul behind them.
