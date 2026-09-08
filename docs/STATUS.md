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
anchored to the timing loops (9i/9j). The pipeline's pure half is the
`replay_transform` package, one module per concern, screened by three detectors plus
per-car anchor plans; Slice 17 added `status.py` (track-status intervals) and revised
a doctrine by measurement (out-of-range gear is dirty, not impossible — a wrecked
car's gearbox counter is emitted as neutral and reported). Quality state on the
Slice 17 branch: `npm run check` green with 714 tests and 0 warnings; 260 pytest with
100% lines + branches on every module; drawcall md5s IDENTICAL on both render modes
(the canvas is untouched); the 2024 assets byte-identical; the 22-car frame cost
measured on-instrument at 762.8 draw calls/frame against the linear law's 764.

**What is open, and what is blocked.** **Slice 17 is BUILT and awaiting the human's
browser acceptance** (pre-registered: click the red-flag entry, watch the start,
LEC's Parabolica off, the RED flag, the event card, and the restart; copy pass on
the card and hooks; the branch is unpushed until then). Its checkpoint rulings are
recorded in PLAN, including the asset-policy reversal: **plain git, the 6 MB gallery
budget retired by measurement, LFS declined** (escalation now 50 MB/file or ~100 MB
pack). After 17: **Slice 16 — draw the pit lane any car in the file uses** (the
undrawn lane is now also visible in the red-flag entry's final seconds, accepted
pending 16), then **Slice 9k** (adjudicate NOR's declined relocation against 16's
pit-lane geometry), then **Slice 18 — corner lore** (filed, not built). **Nothing is
blocked.** One standing constraint applies to all pipeline work: F1 blocks
datacentre IPs from live timing, so `build_replay.py` runs only from the human's
home network (see CLAUDE.md Gotchas).

**What happens next.** The human's acceptance pass on Slice 17's Vercel preview,
then merge. Then Slice 16 (with its deliberate drawcall re-baseline — and a filed
candidate rider: flooring the canvas's dark liveries, which shares that re-baseline),
then 9k, then Slice 18, then the backlog's headline item, the **fixture asymmetry
overhaul** (four recorded instances of the symmetric fixture hiding defect classes).
