# STATUS — read this before PLAN.md

The front page, not the ledger. PLAN.md holds every slice with its evidence; this page
holds where the project stands right now, in three paragraphs, for a new reader or a
fresh session. It is updated in the PR that changes what it says — if it disagrees with
PLAN.md, PLAN.md wins and this page is the bug.

**Where the project is.** v1 (one car, one lap) and v2 (multi-car race replay on the
same engine and schema) are both shipped: every slice through **14 — laps and tyres**
is merged, plus **15 — speed-trace comparison** (a "vs" control on each tower row
overlays a second car's dashed, team-coloured speed line on the focused car's trace,
same window and union y-scale, `comparisonCarIndex` in the transport store with
default none and keep-and-suppress on focus collisions), `main` deploys to production
via Vercel, and the site opens on a three-scenario gallery of real F1 data
(Silverstone 2024 finale and rain, Monza 2024 pit cycle) that carries per-car `laps`
and `stints` — a leader-lap counter in the transport bar, a compound dot per tower
row, and a compound chip with tyre age in the focused readout, all additive within
`schemaVersion` 1. Quality state at the last merge: `npm run check` green with 639
tests and 0 warnings, 220 pytest with `replay_transform.py` at 100% lines + branches,
drawcall md5s unchanged on both render modes, and the trace overlay measured at its
predicted bound (2x points, 36 µs/tick = 0.108% of the HUD budget). **Both pre-registered browser passes are done (2026-09-07, one
sitting): PASS.** Slice 14's pass confirmed the finale tyre story against its survey
table, the first-ever 375px layout, and the HARD-white vs UNKNOWN-grey dot
distinction; 9h-b's rain re-watch at 0.5x held its prediction — severity ranking
**VER < HAM < NOR** unchanged, which is the baseline Slice 9i re-ranks against.
Slice 15's own browser acceptance (finale, HAM focused vs VER, 375px with the new
"vs" buttons) is pre-registered in its PLAN entry and awaits the human's pass.

**What is open, and what is blocked.** One slice is open: **9i — the global fraction
mapping drifts, and pit stops are where** (placement error 31–149 m for every car that
pits vs 6.6–11.7 m for every car that doesn't; `resample_positions_by_travel`'s single
global path/travel fraction is the mechanism). It carries three riders — (a) record
gap-level impact alongside absolute placement, (b) re-verify the timing-loop reference's
noise floor in 9i's own context, (c) attribute HAM's residual zigzag read-only before
choosing a remedy — plus NOR's genuine 41.7 m uncancelled relocation, inherited from
9h/9h-b with its vectors (no return jump at ±30/±60 s; the below-`min_speed` blind spot
is clear; Slice 14's asset regeneration reproduced it unchanged). **Nothing is
currently blocked.** One standing constraint applies to all pipeline work: F1 blocks
datacentre IPs from live timing, so `build_replay.py` runs only from the human's home
network (see CLAUDE.md Gotchas).

**What happens next.** **Slice 15 — speed-trace comparison** was implemented ahead of
9i on the human's explicit direction (the ordering note is in its PLAN entry). The
next session implements **Slice 9i**, in the
instrument-first order this line of slices has banked six times: the read-only riders
and attribution first, and the attribution decides the remedy. 9i's browser acceptance
is already written: all three pit entries read clean at 0.5x, with VER as the untouched
control and the 2026-08-13 severity ranking (**VER < HAM < NOR**, matching the
instrument's 17.8 / 33.8 / 47.6 m) as the baseline to re-rank against. After 9i comes
the backlog's headline item, the **fixture asymmetry overhaul** (four recorded
instances of the symmetric fixture hiding defect classes — Slice 14 worked around the
same limitation again by putting its asymmetry in test tables rather than the fixture).
