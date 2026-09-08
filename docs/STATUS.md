# STATUS — read this before PLAN.md

The front page, not the ledger. PLAN.md holds every slice with its evidence; this page
holds where the project stands right now, in three paragraphs, for a new reader or a
fresh session. It is updated in the PR that changes what it says — if it disagrees with
PLAN.md, PLAN.md wins and this page is the bug.

**Where the project is.** v1 (one car, one lap) and v2 (multi-car race replay on the
same engine and schema) are both shipped, `main` deploys to production via Vercel, and
the site opens on a three-scenario gallery of real F1 data (Silverstone 2024 finale
and rain, Monza 2024 pit cycle) with per-car laps and stints, a leader-lap counter, a
speed-trace comparison overlay (Slice 15's "vs" control), and — since Slices 9i/9j —
placement anchored to the timing loops. The pipeline's pure half is the
`replay_transform` package, one module per concern (Slice 9i Phase 0), screened by
three detectors: frame-displacement repair, the impossible-fix ratio screen, and the
reversal screen (Slice 9j) — plus per-car anchor plans (S/F crossings union pit
brackets, withheld for a car carrying a declined displacement). Quality state at the
last merge: `npm run check` green with 650 tests and 0 warnings; 241 pytest with 100%
lines + branches on every module; drawcall md5s unchanged on both render modes; every
shipped asset byte-identical to the simulation its acceptance table was scored on;
placement adjudicated by the committed instruments (`placement-error.py`,
`gap-error.py`) under a held-out scheme in which sector marks are never anchors.

**What is open, and what is blocked.** **Slices 9i and 9j are DONE and PASSED.** 9i
(2026-09-07): held-out placement on pitting cars fell from 19.6–47.6 m to
10.6–15.7 m; NOR's 41.7 m relocation stays declined by ruling. 9j (2026-09-08):
HAM's residual pit-entry zigzag was attributed to a sub-bar single-fix excursion —
legs individually legal to the ratio screen while the pair reverses at 250 km/h — and
the reversal screen removed it; **HAM now rates 97% at 0.5x, level with VER, and the
re-watch baseline is 97 (VER) / 97 (HAM) / NOR unchanged-by-ruling.** One slice is
open: **16 — draw the pit lane any car in the file uses** (the ribbon comes from
`cars[0]`, so Monza's pit cycle shows LEC and NOR pitting on an undrawn lane).
**Nothing is blocked.** One standing constraint applies to all pipeline work: F1
blocks datacentre IPs from live timing, so `build_replay.py` runs only from the
human's home network (see CLAUDE.md Gotchas).

**What happens next.** The next session implements **Slice 16**: decouple the ribbon
from `cars[0]` and draw the pit lane whenever any car uses it — an app render slice
whose scope sketch is in its PLAN entry (the lane's geometry from the cars that
traverse it; no schema change expected but to be argued, not assumed), with a
deliberate drawcall re-baseline since it is the first canvas change since the 9e
family. After 16 comes the backlog's headline item, the **fixture asymmetry
overhaul** (four recorded instances of the symmetric fixture hiding defect classes).
