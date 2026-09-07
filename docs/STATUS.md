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

**What is open, and what is blocked.** One slice is open and nearly done: **9i —
anchor placement to the timing loops; retire the global ratio.** Phase 0 (the
`replay_transform` package split) is merged; Phases 1–2 are implemented on
`feat/slice-9i-loop-anchored-placement`: the ruled remedy is **C-UNION** — per-lap
S/F loop-crossing anchors union pit-span brackets, both WITHHELD for a car carrying
a declined displacement (NOR's 41.7 m stays declined and reported, per ruling) —
chosen from a four-candidate simulation table scored by the committed instruments
under a pre-registered held-out scheme (sector marks never anchor). Every
regenerated gallery asset is byte-identical to its scored simulation; held-out
placement lands at 10.6–15.7 m on the pitting cars (from 19.6–47.6), the dry
finale tightens, and NOR-rain is untouched by design. **Open before merge: the
human browser pass at 0.5x** (pre-registered per candidate, including the expected
NOR-pair S/F gap regression and one flagged rain-L cell awaiting eyes'
ratification). One standing constraint applies to all pipeline work: F1 blocks
datacentre IPs from live timing, so `build_replay.py` runs only from the human's home
network (see CLAUDE.md Gotchas).

**What happens next.** The human's 0.5x browser pass on all three scenarios closes
Slice 9i: all three rain pit entries against the 2026-08-13 severity baseline
(**VER < HAM < NOR**), finale and Monza checked for no visible regression since
every asset changed, the pre-registered expectations in the PLAN entry (including
the accepted NOR-pair S/F gap regression) judged by eyes. A pass merges the slice;
any numeric miss triggers the pre-registered mechanical revert. After 9i comes
the backlog's headline item, the **fixture asymmetry overhaul** (four recorded
instances of the symmetric fixture hiding defect classes — Slice 14 worked around the
same limitation again by putting its asymmetry in test tables rather than the fixture).
