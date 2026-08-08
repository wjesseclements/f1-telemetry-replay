# F1 Telemetry Replay — Project Summary

A browser-based Formula 1 telemetry replay application that turns publicly available
F1 timing data into a broadcast-style race visualization: up to nineteen real cars
lapping a real circuit on one shared clock, with a live timing tower, per-car
telemetry, thermal speed trails, and full transport controls — sustained at
120 fps. Built end to end through spec-driven, AI-assisted development across
fifty pull requests, with every design decision, defect, and lesson recorded in
the repository itself.

**Live app:** deployed on Vercel · **Data:** generated locally from official F1
timing data via FastF1 · **Repo:** github.com/wjesseclements/f1-telemetry-replay

---

## What was built

**The player.** A React/canvas application that replays validated telemetry JSON:
a track ribbon derived from the racing line, corner badges with leader lines, a
start/finish marker, and per-car markers with heading ticks. The focused car wears
a thermal trail (full covered-portion trail on single closed laps; a bounded
2-second thermal comet on multi-lap race windows); unfocused cars carry short
team-color tails. A timing tower shows true running order — including lapped cars
in both signs (+1 LAP / −1 LAP) — with gaps in seconds and metres computed by
projecting each car onto the focused car's own path. The HUD shows speed, gear,
throttle, brake, and DRS state at a bounded 30 Hz cadence, alongside a scrolling
heart-monitor speed trace with a fixed playhead. Transport: play/pause, an exact
seek scrubber, speed multipliers, and complete keyboard operation with visible
focus states and screen-reader labels.

**The engine.** A pure TypeScript core with zero React or DOM imports: a Zod
schema that is simultaneously the runtime validator and the TypeScript type
system's source of truth; a loader that fails loudly with human-readable,
path-precise error messages; O(1) frame interpolation over a uniform time grid;
geometry, thermal color mapping, gap/running-order computation with lap
unwrapping, and DRS decoding — all at 100% per-file test coverage, enforced
mechanically.

**The pipeline.** A Python data pipeline (FastF1 + numpy) split into a pure,
fully tested transform module and a thin network CLI. It fetches any session,
resamples every car's channels onto one shared 10 Hz grid, reparameterizes
positions by travelled distance so on-screen motion agrees with the speed
channel, handles real-data mess (retirements, pit stops, missing channels,
out-of-range values) with named, actionable errors, and validates its own output
through the app's actual schema before a human ever loads it. Golden-file
ratchets and a committed synthetic generator keep the pipeline and the schema
provably in agreement in CI, with no network.

**The instruments.** Committed measurement tooling in `docs/perf/`: an fps probe
(frame-time percentiles, honest fps), a draw-call capture harness (md5-comparable
call sequences for pixel-equivalence proofs), and a HUD-tick profiler for the
30 Hz telemetry path. Each was built when a claim needed evidence and committed
when it earned reuse.

## Stack

Vite 8 · React (render layer only — the hot path never enters React's render
cycle) · TypeScript · Zod 4 · Zustand · Canvas 2D · Vitest 4 with per-file
coverage thresholds · ESLint/Prettier gated in CI · Python 3.10+/3.12, FastF1,
numpy, pytest with branch coverage · GitHub Actions (one required `verify` check
spanning both languages) · Vercel with config-as-code deployment rules ·
Dependabot with a written major-version policy.

## Architecture principles

- **The schema is the single contract.** All data — fixtures, goldens, real
  sessions, test mutations — crosses one Zod boundary. The pipeline is checked
  against the app's own `parseReplay`, not a second copy of the rules.
- **Pure core, thin shell.** The engine imports nothing from React or the DOM;
  the render layer subscribes to nothing per-frame. The replay clock lives in a
  ref, advanced by one rAF loop; React commits exactly once per canvas mount —
  a property pinned by a Profiler test that has survived every slice.
- **Bounded rendering.** Trails, comets, and tails batch by color bucket and
  alpha band; per-frame stroke counts are constant and asserted, independent of
  window length or field size.
- **Offline-first.** Tests and CI never touch the network — enforced, not merely
  intended, by a stub that throws on any unmocked `fetch`. The app boots with zero
  network and has exactly one exception: fetching its own committed gallery
  assets from its own origin. Real data is generated deliberately by a human and
  enters through a file picker or one of three curated featured replays.
- **Fail loudly, in sentences.** Validation errors name the exact path
  (`cars[0].samples[3].speed`); pipeline guards name the driver and the fix;
  a failed color lookup renders an unmistakable neutral instead of impersonating
  a real livery.

## Development methodology

The project was built with Claude (planning and review) and Claude Code
(implementation) under a spec-driven slice methodology: each slice began with a
written kickoff carrying scope, constraints, and a definition of done; Claude
Code produced a plan in read-only mode; the plan was reviewed and amended before
any code existed; implementation ran under tiered permissions with destructive
actions gated; and every slice closed with a seven-item `/review` checklist
demanding evidence — gate output grepped in full, scope proven by diff,
architecture rules checked against the actual changes, and tests verified by
mutation (break the logic, watch the named test fail) rather than by rerunning
green suites. Human review was stationed where judgment lives: schema shape,
design semantics, visual acceptance, and constant tuning by eye — with
measurement instruments covering everything else.

## Selected challenges and findings

**The surging dot.** Real F1 position and speed data come from different sensors
at different rates; linear interpolation of jittery position timestamps made the
car marker visibly surge on straights. Diagnosis was empirical — a stair-step
hypothesis was refuted by run-length statistics, and the true mechanism
(timestamp jitter amplified by finite differencing) was isolated by a
window-widening correlation sweep. The fix reparameterizes positions by the
integral of the speed channel, raising implied-vs-actual speed correlation from
r = 0.70 to r = 0.9998 with the two sensors' independent distance totals agreeing
to 0.17%.

**The tower that lied at field density.** Gap computation designed for three
cars reported cars half a lap behind as ahead (the shorter-way-round convention),
and cars near the boundary flickered the sort order faster than names could be
read. The rework replaced instantaneous folded gaps with unwrapped cumulative
progress over a measured reference lap — a pure function of the clock with no
accumulator, so seeks are exact by construction — fixing running order, lapped-car
display in both signs, a 22.5% unanswerable rate (to 0.0%), and 45 sign flips per
window (to 0) in one mechanism. Mid-build, measurement refuted part of the
approved design itself: the planned fallback definition reintroduced a
19-second jump at pit stops and was replaced before shipping.

**The instrument that lied first.** A 20-car frame-budget measurement initially
showed implausibly clean numbers; investigation revealed the display's 120 Hz
refresh ceiling was hiding the signal. Dropping the monitor to 60 Hz exposed a
3.6× p99 spread between 3 and 19 cars — the cost curve the measurement existed
to find. The project's recurring lesson, encountered as truncated logs, a
`[warn]`-vs-`warning` grep, 37 false grep misses, and a refresh cap: **the
instrument is always the first suspect.**

**A toolchain swapped under a proof of stillness.** Vite 5→8 and Vitest 2→4
migrated as one atomic interlocked bump with zero source changes — verified by a
byte-identical md5 of 79,213 recorded draw calls across the bundler swap, a
coverage gate re-probed in both directions after the provider rewrite silently
changed per-file threshold semantics, and npm audit going 7→0.

**Tests that could not fail.** A closing audit found an assertion whose expected
value was the constant under test — it passed identically whether the fallback
fired or a coercion happened to produce the same hex, at 100% line coverage the
entire time. The generalized finding is recorded in the repo: such shapes are
invisible to coverage and to re-runs, and surface only on re-reads.

**Honest failure modes as a design principle.** A default color that happened to
match Red Bull's livery let a completely broken lookup ship unnoticed — the
wrong output looked right. The fix pins an achromatic invariant (r == g == b),
not a hex, so a failed lookup is unmistakable and a future plausible-looking
default fails the suite.

## By the numbers

Fifty pull requests, linear history, every merge squash-gated by one required CI
check. 650+ tests across TypeScript and Python; engine and pipeline transform at
100% per-file line and branch coverage, with the gates probed to prove they
bite. 120 fps sustained with 19 cars, zero frames over 20 ms; motion fidelity
r ≥ 0.9997 per car on real race data; validated real sessions from a warm local
cache in seconds. Zero lint suppressions in the application tree. Every slice's
acceptance evidence — before/after tables, screenshots, mutation results —
recorded in PLAN.md alongside the decision it justified.

## Transferable lessons

The durable output alongside the app is a working playbook for AI-assisted
engineering: law files the agent reads every session (CLAUDE.md), specs that
define done before work begins, review rituals that demand evidence over
narration, mutation testing as the standard of proof, committed instruments over
re-derived ones, permission tiers that keep destructive actions gated, and human
judgment stationed exactly where measurement cannot reach — visual acceptance,
design semantics, and the tuning of constants by eye. Several of the project's
recorded findings (perceived time vs. data time in visual constants, the
unfalsifiable-test shape, instrument-first debugging) generalize well beyond
this codebase.
