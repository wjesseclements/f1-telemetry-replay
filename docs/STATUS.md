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

**What is open, and what is blocked.** Two slices are open. **Slice 17 — the 2026
Monza red-flag scenario (track-status flags, the first 2026 session this app has
loaded, and the gallery asset policy/LFS ruling) — runs FIRST, ordered ahead of
Slice 16 by the human's explicit direction.** It runs in phases: Phase 1 (survey of
the 2026 Italian GP + design cards) is done and sits at its checkpoint awaiting the
human's rulings; nothing is built until then. **Slice 16 — draw the pit lane any
car in the file uses** — follows (the ribbon comes from `cars[0]`, so Monza's pit
cycle shows LEC and NOR pitting on an undrawn lane), and **Slice 9k** (adjudicate
NOR's declined 41.7 m relocation structurally, against the pit-lane geometry 16
produces) is filed to run after it. **Nothing is blocked.** One standing constraint
applies to all pipeline work: F1 blocks datacentre IPs from live timing, so
`build_replay.py` runs only from the human's home network (see CLAUDE.md Gotchas).

**What happens next.** Slice 17 Phase 2 builds per the checkpoint rulings:
track-status intervals as additive schema + pipeline emission, a ≤30 Hz flag UI,
the LFS/budget decision executed, and the new gallery scenario(s) — acceptance is
clicking the new entry and watching the start, LEC's Parabolica off, the RED flag,
and the restart, with the existing three scenarios unchanged. Then Slice 16 (with
its deliberate drawcall re-baseline), then Slice 9k, then the backlog's headline
item, the **fixture asymmetry overhaul** (four recorded instances of the symmetric
fixture hiding defect classes).
