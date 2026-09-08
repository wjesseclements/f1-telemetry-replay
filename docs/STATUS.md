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
anchored to the timing loops (9i/9j). The timing tower now carries broadcast
semantics (Slice 19): per-car RETIRED/OFF-LINE/STATIONARY states derived at the
≤30 Hz tick from data the file already carries, a retired car at the bottom in grey
saying OUT, no gap quoted unless both cars are moving on the racing line, a standing
field showing grid order with no numbers until it launches, and a pit-lane car
keeping its row with an em dash instead of a phantom number. The pipeline's pure
half is the `replay_transform` package, one module per concern, screened by three
detectors plus per-car anchor plans. Quality state on the Slice 19 branch:
`npm run check` green with 768 tests and 0 warnings; 273 pytest with 100% lines +
branches on every module; drawcall md5s IDENTICAL on both render modes (the canvas
is untouched); assets, schema and pipeline untouched on disk; the whole tower
derivation measured at 6.7 µs per tick on the 22-car asset.

**What is open, and what is blocked.** **Slice 19 is built and awaiting the human's
watch** (2026-09-08, branch `feat/slice-19-tower-states`, not pushed): the three
recorded exhibits are reproduced BEFORE and resolved AFTER — numerically through the
shipped engine, as committed tests, and as screenshots — and the acceptance is
pre-registered per scenario in the PLAN entry. One deviation is FLAGGED there rather
than smoothed over: "the 2024 scenarios unchanged" cannot hold verbatim inside pit
windows, because the goal sentence (a pit-lane car never mistaken for a car on
track) applies to the 2024 pit lanes too — the finale is bit-identical everywhere,
rain and pit-cycle change only while a car is actually in the pit. **The board
after 19: 21 (tower reshuffle animation) → 16 (pit-lane drawing) → 9k (NOR's
relocation, adjudicated against 16's pit-lane geometry) → 18 (corner lore) →
20 (Aston/Cadillac colour).** **Nothing is blocked**; the standing constraint
remains: `build_replay.py` runs only from the human's home network (CLAUDE.md
Gotchas).

**What happens next.** The human watches Slice 19 against the pre-registered
acceptance (PLAN): the red-flag scenario — LEC drops to the bottom in grey with
OUT at ≈2:55 and every other gap blanks while the order keeps updating, with the
pit-lane starters at the bottom rather than on top before the start; the restart —
grid order with no gaps at all until the ≈1:19 launch (RUS −37 is gone); the
rain — identical to today everywhere except the three pit stops, where the
pitting car's row now keeps its place with an em dash. After the ruling:
**Slice 21** (tower reshuffle animation — a retired car's row now knows where it
belongs, 21 teaches it to travel there), then 16 → 9k → 18 → 20 per the board,
and the backlog's headline **fixture asymmetry overhaul** behind them.
