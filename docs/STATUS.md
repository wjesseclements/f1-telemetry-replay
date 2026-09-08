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

**What is open, and what is blocked.** **Slice 17 is BUILT, on PR #68, awaiting the
human's re-check of the preview** after the first browser pass returned three
findings, all fixed in-branch: entry 2 lands at clock 0 (the restart was STANDING —
a survey misreading corrected by the watched race), the flag treatment is A+B (a
canvas-overlay banner joins the transport chip under abnormal flags), and LEC's
post-impact "limp" was diagnosed read-only as the telemetry feed dying at the wall
— the card now tells the true story and the manifest's new `provenance.note`
discloses the artifact. The pass also filed **Slice 9l** (freeze a car when its
telemetry collapses — the diagnosis and why it needs its own measured-threshold
slice are in 17's entry), **Slice 19** (retired/stopped/pit-lane semantics in
tower + gaps), and **Slice 20** (colour distinction under the luminance floor).
Checkpoint rulings stand as recorded, including plain git with the 6 MB budget
retired. Queue after 17: **16**, **9k**, **18**, with 9l/19/20 sequenced by the
human. **Nothing is blocked**; the standing constraint remains: `build_replay.py`
runs only from the human's home network (CLAUDE.md Gotchas).

**What happens next.** The human's re-check on PR #68's preview (auto-merge off),
then merge. Then Slice 16 (with its deliberate drawcall re-baseline — and a filed
candidate rider: flooring the canvas's dark liveries, which shares that re-baseline),
then 9k, then the filed follow-ups and Slice 18, then the backlog's headline item,
the **fixture asymmetry overhaul**.
