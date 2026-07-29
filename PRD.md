# PRD — F1 Telemetry Replay

## Overview

A web app that replays Formula 1 cars driving around a circuit from real telemetry.
The track and motion are reconstructed from FastF1 position/telemetry data, rendered
as an animated top-down view with live speed, gear, throttle/brake, and DRS readouts.
v1 ships a single car running one lap. The architecture is built so the same engine
scales to a full 20-car race replay (v2) with no frontend rewrite.

## Goals

- Reconstruct a circuit and animate a car around it from real F1 telemetry.
- Live HUD: speed, gear, throttle, brake, DRS, lap clock, speed-trace with playhead.
- Transport controls: play/pause, restart, speed multiplier, scrub.
- A speed-colored trail painted on the track as the car laps (the signature element).
- A reproducible Python pipeline that turns a (year, GP, session, driver) into the
  app's JSON, runnable offline with caching.
- Quality bars met (see Acceptance Criteria) and deployed on a real host with CI.

## Non-goals (defend these against scope creep)

- **No live/real-time streaming.** Post-session data only. The pipeline is batch.
- **No backend or server.** Static SPA; the pipeline runs offline and emits JSON.
- **No WebGL/3D in v1.** Canvas 2D only. WebGL is a documented escalation path,
  taken *only* if measured 20-car performance demands it — not pre-emptively.
- **No accounts, auth, betting, predictions, or ML.**
- **v1 is one car, one lap.** Multi-car race replay is v2 (same schema, same engine).
- **No mobile-native app.** Responsive web is in scope; native is not.

## Tech stack (with justifications)

- **Vite + React 18 + TypeScript** — matches the existing toolchain; fast HMR; typed
  engine contracts.
- **Zustand** for transport state — one small store; avoids prop-drilling the clock;
  lets the canvas stay out of React's render path. (See load-bearing decision #1.)
- **Tailwind CSS + CSS custom properties** for chrome and design tokens. Canvas 2D
  for the visualization itself.
- **Zod v4** for the replay schema — one runtime validator that is *also* the TS type via
  `z.infer`. Single source of truth; catches pipeline/frontend drift at load time.
  v4 (not v3) for its unified error API — `error.issues` plus top-level
  `z.prettifyError`, which turns a mismatch into a path-annotated, human-readable
  message instead of v3's nested `.format()` object. That is what makes "fails loudly
  with an actionable error" cheap to deliver.
- **Vitest + React Testing Library** — engine gets thorough unit tests; components get
  light smoke tests.
- **ESLint + Prettier** — enforced in CI; Prettier-on-save via a PostToolUse hook.
- **Pipeline:** Python 3.10+, FastF1 3.8+, numpy/pandas. Emits the JSON schema below.
- **Deploy:** GitHub repo connected to **Vercel** via the Vercel for GitHub app.
  Merges to `main` → production; every other branch/PR → preview URL. No deploy
  scripts. Monorepo: set Vercel **Root Directory = `app`** (auto-detects Vite, output
  `dist`). **GitHub Actions** runs the quality gate (typecheck + lint + test + build)
  on PRs and `main`; branch protection requires it green before merge, so production
  is test-gated even though Vercel itself only runs the build. Actions does NOT deploy —
  Vercel owns deployment.

## Load-bearing design decisions (NON-NEGOTIABLE)

These are the choices that, if "simplified," break everything. An agent will collapse
whatever isn't defended — defend these.

1. **One clock owns time, and it lives in a ref — never in React/store state.**
   The playback clock is a mutable ref inside the render engine, advanced by a single
   `requestAnimationFrame` loop. The Zustand store holds only *discrete* transport
   state (isPlaying, speedMult, seekTarget, loaded replay). The HUD reads an
   interpolated snapshot at **≤30fps**, never per frame. If the live clock is put in
   React state, 20 cars at 60fps will melt. This is the single most important rule.

2. **The replay schema is the only contract, and `cars` is an array from day one.**
   v1 emits `cars` of length 1. Nothing in the app may branch on car count or
   special-case "the single car." The 1→20 transition is purely additive data.

3. **Samples are on a uniform time grid; current-sample lookup is O(1) index math.**
   `index = clock * sampleRateHz`. Never scan or search for the active sample.

4. **The engine is pure and headless.** Everything in `src/engine/` (schema,
   interpolation, geometry/rotation, speed→color, multi-car alignment) imports no
   React, no DOM, no canvas, and is unit-tested. Rendering and UI consume it.
   Logic before pixels.

5. **Multi-car alignment is on `SessionTime`, not per-lap `Time`.** For the race
   replay, every driver's telemetry is resampled onto one shared session-time grid so
   all cars are shown at the same instant. Per-lap `Time` is valid only for the
   single-lap v1 mode. (Source [3].)

6. **Resampling respects channel type:** continuous channels (Speed, X, Y, RPM) are
   linearly interpolated; discrete channels (nGear, DRS, Brake) are forward-filled.
   (Source [2].) **Throttle counts as continuous** and is interpolated — settled in
   Slice 3; the prototype carried it forward, which made the HUD bar step.
   - **Refined in Slice 6b: X/Y interpolate against DISTANCE, not time.** Position and
     car telemetry are independent FastF1 channels; the position channel's shape is
     trustworthy and its ~4.2 Hz timestamps are not, so interpolating X/Y against time
     placed each sample at the wrong distance along a correct path and the car marker
     surged on the straights (implied vs actual speed correlated at only r = 0.70).
     The pipeline now parameterises the recorded polyline by arc length and advances
     along it by the cumulative speed integral — position supplies the path shape,
     speed supplies the progress. They remain continuous, linearly interpolated
     channels; only the parameter changed. This is a **pipeline** concern: the app
     receives x/y and never re-derives them.
   - **Refined in Slice 7: the lap the pipeline resamples is the CLOSED lap, laid over
     the whole grid.** `meta.duration` is `n / sampleRateHz`, and the app closes the
     loop by wrapping the last sample back to the first across one full grid step, so
     that step has to carry a full step of travel. Two things stopped it doing so, and
     both are corrected before x/y are written: samples are emitted at `k / rate` but
     READ at `k · lap / n` (`source_times`), and `lap` includes the time to cover the
     chord from the last recorded fix back to the first (`closing_time`) — real laps
     stop a metre or two short of closing. Cost: a uniform time base stretch of
     `duration / lap`, ≤0.125% on an ~80 s lap at 10 Hz, printed on every pipeline run.
     Still pipeline-only — no schema, engine or renderer change.

## Data model — the replay schema

The single contract between pipeline and app. Defined once in `src/engine/schema.ts`
as a Zod schema; the loader validates against it; the Python pipeline emits it.

```jsonc
{
  "meta": {
    "schemaVersion": 1,        // breaking-change guard; unknown keys are stripped
    "year": 2024, "event": "Monza", "session": "Q",
    "track": "Italian Grand Prix",
    "rotation": 75.0,          // degrees, from circuit_info; applied at render
    "sampleRateHz": 20,
    "duration": 84.6,          // seconds
    "units": { "speed": "km/h" }
  },
  "track": {
    "startFinish": { "x": 0, "y": 0, "angle": 0 },
    "corners": [ { "number": 1, "letter": "", "x": 0, "y": 0 } ]
  },
  "cars": [
    {
      "driver": "VER", "team": "Red Bull", "color": "#3671C6",
      "samples": [
        // uniform time grid at sampleRateHz — ENFORCED by the schema since Slice 3:
        // every t must be within 2 ms of k / sampleRateHz, and every car's span
        // (samples.length / sampleRateHz) must match meta.duration to within one
        // grid step. The O(1) lookup never reads t, so irregular spacing has to fail
        // at load, not misplace the car; and equal spans are what keep all cars on
        // the same instant in v2.
        // Core kinematics are always required. `drs` is OPTIONAL and present
        // only for 2018-2025 data; it is absent for 2026+ (see notes).
        // `drs` carries the RAW FastF1 code (12 here), decoded by engine/drs.ts.
        { "t": 0.0, "x": 0, "y": 0, "speed": 0,
          "throttle": 0, "brake": 0, "gear": 1, "drs": 12 }
      ]
    }
  ]
}
```

Notes pinned to sources:
- Position X/Y are in 1/10 m in raw FastF1; the app only fits bounds, so units are
  display-irrelevant. (Source [2].)
- `rotation` comes from `circuit_info`; it is manually maintained and approximate —
  fine for display, not for precision overlays. (Source [1].)
- **DRS is removed in 2026** (replaced by active aero — movable front/rear wings,
  plus Overtake Mode for energy boost). Critically, **F1 does not publish active-aero
  or ERS state**, so there is no replacement channel: in 2026+ data the `DRS` column
  exists but is **all zeros**, and X-mode/Z-mode, Overtake Mode, Boost, and ERS are
  **not available via FastF1 or any tool**. (Sources [5], [6].)
- Consequence for design: **`drs` is an optional, season-dependent channel**, not a
  core field. The **pipeline** omits it when the column is all-zero/absent; the HUD
  renders a DRS indicator only when the data carries one. Do **not** plan features on
  active-aero or energy state — that data does not exist publicly. Core kinematics
  (X/Y, Speed, Throttle, Brake, nGear, RPM) are unaffected across all seasons.
- For pre-2026 data, the DRS integer encoding is **not formally documented** (FastF1
  calls it only a "DRS indicator"; community reading is values ≥10 mean open). Isolate
  that mapping in one function and validate against a known lap. (Source [2].)
  Decided in Slice 2: the JSON carries the **raw** code and `src/engine/drs.ts` is the
  single decoder, so the guess lives in one function with a real caller rather than
  being duplicated in Python. The schema keeps `drs` all-or-nothing per car — a
  partially present channel is drift and fails loudly.
- The schema is versioned by `meta.schemaVersion`. Unknown keys are **stripped**, so
  additive pipeline channels never break an older app build; a *breaking* change bumps
  the version and the loader rejects mismatched JSON outright.

## UX flows

- **Load:** app loads a committed sample fixture (no network). Car sits at the
  start/finish line. If `prefers-reduced-motion`, it starts paused; otherwise it plays.
- **Replay:** play/pause toggles motion; speed multiplier (0.5/1/2/4×); scrub seeks;
  restart returns to the line. HUD and speed-trace playhead track the clock.
- **(v2) Car selection:** choose drivers to show/highlight; relative gaps appear.

## Acceptance criteria (numeric, enforceable)

- **60fps** sustained with 1 car on a mid-tier laptop. v2 target: **≥50fps** with 20.
- Engine modules: **≥90%** line coverage; zero React/DOM imports.
- Loader **rejects** non-conforming JSON with a clear, actionable error.
- Lighthouse: **Performance ≥90, Accessibility ≥95, Best Practices ≥95**.
- Transport is **fully keyboard-operable**, visible focus, `prefers-reduced-motion`
  respected (no ambient motion; starts paused).
- Cold load to interactive **< 2s** on the committed fixture.
- **Runs with zero network** for app + tests + CI (committed fixture; no F1 API).
- CI green (typecheck + lint + test + build) is required before merge.

## Continuous delivery

Trunk-based development with everything-as-code:

- **One trunk (`main`), always releasable.** Work happens on short-lived branches; each
  push gets a Vercel preview URL and runs the `verify` CI check; merge to `main` ships
  production automatically.
- **Gate, config-as-code:** `.github/ruleset.json` (applied by `scripts/setup-repo.sh`)
  requires a PR, the `verify` check (strict: branch up to date), linear history, and
  blocks force-push/deletion. **Zero required approvals** — a solo author can't approve
  their own PR, so the gate is CI + PR, not human review. Admins may bypass in
  emergencies.
- **Clean history:** squash-merge only; the Conventional-Commit PR title becomes the
  commit. Merged branches auto-delete; auto-merge can land a PR the moment `verify` is
  green.
- **Fast pipeline:** typecheck + lint + format + test + build, then `pytest` on Python
  3.10 and 3.12 — all inside the one `verify` job, because that is the name the ruleset
  requires and a second job would not block a merge. Dependency-cached, with in-progress
  runs cancelled on new pushes. Least-privilege `permissions:` (read-only). CI installs
  `requirements-dev.txt` only, so FastF1 is not importable there and the gate stays
  network-free.
- **Deps & rollback:** Dependabot opens weekly grouped PRs (which flow through the same
  gate); rollback is a revert of the merge commit, which Vercel restores instantly.

The one required-check name (`verify`) must match across the CI job and the ruleset —
that mismatch is the most common reason PRs hang "waiting for status."



## Project structure

```
f1-telemetry-replay/
├─ PRD.md  CLAUDE.md  PLAN.md            # PLAN.md generated in plan mode
├─ .gitignore
├─ .claude/settings.json
├─ .github/
│  ├─ workflows/ci.yml                   # quality gate (job: verify)
│  ├─ ruleset.json                       # branch protection as code
│  ├─ dependabot.yml                     # weekly grouped dep updates
│  └─ pull_request_template.md
├─ scripts/setup-repo.sh                 # applies ruleset + merge settings via gh
├─ app/                                  # Vite + React + TS
│  ├─ vercel.json                        # framework + skip-unchanged build
│  ├─ public/data/                       # generated replay JSON (gitignored)
│  └─ src/
│     ├─ engine/                         # PURE, headless, unit-tested
│     │  ├─ schema.ts                    # zod schema = single source of truth
│     │  ├─ interpolate.ts               # O(1) sample lookup + lerp
│     │  ├─ geometry.ts                  # rotation, bounds, fit transform
│     │  ├─ color.ts                     # speed→thermal color
│     │  ├─ align.ts                     # (v2) session-time multi-car alignment
│     │  └─ __fixtures__/sample-lap.json # tiny committed fixture for tests/app
│     ├─ store/                          # zustand transport state
│     ├─ render/                         # canvas draw + rAF loop (reads engine)
│     └─ components/                     # Header, HUD, Transport
└─ pipeline/                             # Python FastF1 → JSON
   ├─ build_replay.py                    # fetch + CLI (the only networked module)
   ├─ replay_transform.py                # PURE resample/clamp/assemble (numpy only)
   ├─ tests/                             # pytest + committed goldens (no network)
   ├─ requirements.txt                   # fastf1/pandas — human's machine
   └─ requirements-dev.txt               # pytest/numpy — what CI installs
```

The existing `TelemetryReplay.jsx` prototype and `build_replay.py` are starting
material: the prototype's engine logic (interpolation, geometry, color, synthetic
generator) gets extracted into `src/engine/` as pure, tested modules; the synthetic
generator becomes a test/dev fixture source, not production code.

## Roadmap (high level — slice detail lives in PLAN.md)

- **v1:** scaffold + CI + deploy; pure engine + tests; canvas render + transport + HUD;
  wire the real pipeline for one lap; validate visuals against a known lap.
- **v2:** session-time alignment in the pipeline; multi-car store/render; driver
  selection; relative gaps. (Engine and schema already support it.)

## Sources

1. FastF1 docs — telemetry, position data 2018+, `circuit_info` rotation/corners,
   ±10 m overlap error: https://docs.fastf1.dev/core.html
2. FastF1 telemetry channel reference — Speed/Throttle/Brake/nGear/DRS, X/Y in 1/10 m,
   continuous vs discrete interpolation: https://docs.fastf1.dev/api_reference/telemetry.html
3. FastF1 `SessionTime` (time since session start) — the alignment key for multi-driver
   replay: https://docs.fastf1.dev/core.html
4. FastF1 project / install (3.8+, Python 3.10+, jolpica-f1 backend):
   https://github.com/theOehrly/Fast-F1
5. FastF1 maintainer — 2026 active aero & ERS not published; DRS column all-zeros,
   no replacement channel: https://github.com/theOehrly/Fast-F1/discussions/861
6. F1 2026 regulations — DRS replaced by active aero (X-mode/Z-mode) + Overtake Mode:
   https://www.formula1.com/en/latest/article/2026-regulations-explained-all-you-need-to-know-about-f1s-new-aerodynamics.7IAt0auc32UkCEFE5ypkTB
