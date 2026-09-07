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
tests and 0 warnings, 220 pytest with the `replay_transform` package — split into one
module per concern by Slice 9i Phase 0, byte-identical outputs — at 100% lines +
branches on every module,
drawcall md5s unchanged on both render modes, and the trace overlay measured at its
predicted bound (2x points, 36 µs/tick = 0.108% of the HUD budget). **Both pre-registered browser passes are done (2026-09-07, one
sitting): PASS.** Slice 14's pass confirmed the finale tyre story against its survey
table, the first-ever 375px layout, and the HARD-white vs UNKNOWN-grey dot
distinction; 9h-b's rain re-watch at 0.5x held its prediction — severity ranking
**VER < HAM < NOR** unchanged, which is the baseline Slice 9i re-ranks against.
Slice 15's browser acceptance (finale, HAM focused vs VER, 375px with the new
"vs" buttons) also PASSED 2026-09-07, after three legibility findings — control
visibility, a contrast floor for dark team colours, the metres column yielding to
the vs pill per the row's surrender order — were each fixed in-branch and
re-verified on a fresh preview; the findings and fixes are amendments in its
PLAN entry.

**What is open, and what is blocked.** **Slice 9i is DONE and PASSED** (2026-09-07,
0.5x on the PR #66 preview): the ruled remedy is **C-UNION** — per-lap S/F
loop-crossing anchors union pit-span brackets, both WITHHELD for a car carrying a
declined displacement — chosen table-first from four simulated candidates under a
pre-registered held-out scheme, with every shipped asset byte-identical to its
scored simulation. Held-out placement on pitting cars fell from 19.6–47.6 m to
10.6–15.7 m; the pass graded **VER 97% / HAM 85% / NOR unchanged (declined by
design)**, ranking **VER < HAM < NOR** holding — those percentages are the new
re-watch baseline. Two slices are open, both filed by that pass: **9j — attribute
HAM's residual pit-entry zigzag** (read-only attribution first: cancellation-seam
residual vs 9i's own anchor noise vs unknown; 85% is the number to beat, 97% the
target) and **16 — draw the pit lane any car in the file uses** (the ribbon comes
from `cars[0]`, so Monza's pit cycle shows LEC and NOR pitting on an undrawn
lane). **Nothing is blocked.** The datacentre-IP constraint on `build_replay.py`
stands (see CLAUDE.md Gotchas). One standing constraint applies to all pipeline work: F1 blocks
datacentre IPs from live timing, so `build_replay.py` runs only from the human's home
network (see CLAUDE.md Gotchas).

**What happens next.** The next session implements **Slice 9j** in the
instrument-first order: read-only attribution of HAM's remaining zigzag (the 9h-b
cancellation seams, 9i's own anchor noise, or something new), and the attribution
decides the remedy — nothing is designed before it. After 9j: **Slice 16** (the
pit lane drawn for any car that uses it — an app render slice that deliberately
re-baselines the drawcall captures), then the backlog's fixture asymmetry
overhaul. After 9i comes
the backlog's headline item, the **fixture asymmetry overhaul** (four recorded
instances of the symmetric fixture hiding defect classes — Slice 14 worked around the
same limitation again by putting its asymmetry in test tables rather than the fixture).
