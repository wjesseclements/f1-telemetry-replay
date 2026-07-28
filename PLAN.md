# PLAN — F1 Telemetry Replay

Ordered vertical slices. **One slice per session; `/clear` between slices.** Each is a
short-lived branch off `main`, PR opened early, squash-merged (Conventional-Commit
title). A slice is done only when typecheck + lint + test + build are green and the
diff is self-reviewed against CLAUDE.md and PRD §Load-bearing decisions. Cross-cutting
concerns (keyboard, reduced-motion, error/empty states, schema-validation-at-load) are
built **into** the slice that introduces them — never deferred to a late audit.

## Phase v1 — one car, one lap

### [x] Slice 1 — Scaffold app/ + green CI quality gate
- Scaffold Vite + React 18 + TS **into the existing `app/`** (keep `app/vercel.json`
  when prompted about the non-empty directory). Add `package.json` scripts: `dev`,
  `build`, `typecheck` (`tsc --noEmit`), `lint` (ESLint), `test` (Vitest).
- TypeScript **strict**. ESLint + Prettier (Prettier matches the PostToolUse hook).
  Tailwind + a CSS-custom-property token layer (port the prototype's `C{}` palette to
  `:root` vars; no scattered hex). Vitest + React Testing Library, jsdom env.
- Minimal `App.tsx` placeholder + one trivial smoke test so `test` is non-empty.
- Confirm `.gitignore` covers `node_modules/`, `dist/`, `app/public/data/*`,
  `.f1cache/`, `pipeline/.venv/`, `.env*` (it is currently empty — populate it).
- Do **not** touch `ci.yml` job name `verify` or `ruleset.json`.
- **Verify:** `cd app && npm run typecheck && npm run lint && npm run test -- --run &&
  npm run build` all green; `npm run dev` serves the placeholder. Push branch → Vercel
  preview + `verify` check go green (this is what makes Vercel's first deploy succeed).

### [x] Slice 2 — Engine: Zod schema + fixture + loader (validation at load)
- `src/engine/schema.ts`: the **single contract** as one Zod schema; export the TS type
  via `z.infer`. `cars` is an array (len ≥ 1). Core kinematics required
  (`t,x,y,speed,throttle,brake,gear`); `drs` **optional**. `meta` includes
  `sampleRateHz`, `duration`, `rotation`, `units`.
- `src/engine/load.ts`: `parseReplay(json) → Replay` that validates and **fails loudly**
  with an actionable error on mismatch.
- `src/engine/__fixtures__/sample-lap.json`: tiny committed fixture. Generate it once
  from the prototype's synthetic generator (ported to a throwaway dev script — the
  generator is fixture/dev material, **not** production code), then commit the JSON.
- `src/engine/drs.ts`: isolate the undocumented pre-2026 DRS integer→bool mapping
  (values 10/12/14 = open) in one function.
- Vitest: schema **accept** (fixture) + **reject** (missing core field, wrong type,
  empty `cars`); DRS mapping; `drs`-absent accepted.
- **Verify:** `npm run test -- --run` green; engine has zero React/DOM imports.

### [x] Slice 3 — Engine: interpolation + geometry + color (pure, ≥90% cov)
- `src/engine/interpolate.ts`: O(1) `sampleAt(clock)` via `index = clock * sampleRateHz`
  (no scanning); lerp continuous channels, carry discrete; heading from neighbours;
  correct boundary + wrap behaviour.
- `src/engine/geometry.ts`: `rotateWorld(pts, rotationDeg)`, `computeBounds`,
  `fitTransform(bounds, w, h, pad)` → scale/offset. Pure functions only.
- `src/engine/color.ts`: `speedColor(v)` thermal stops + bucketing helpers (port
  `THERMAL`/`bucketOf` from prototype).
- Vitest covering: O(1) lookup correctness, interp at boundaries/wrap, rotation/fit
  math, speed→color stops. Target **≥90%** line coverage across engine modules **that
  exist as of this slice** (re-assert ≥90% in Slice 8 when `align.ts` lands).
- **Amendment (this slice):** the ≥90% bar became mechanical — a `perFile` vitest
  threshold on `src/engine/**` (lines/branches/functions) in `vite.config.ts`, wired
  into `npm run check` and `ci.yml`. Slice 8's `align.ts` is now gated automatically;
  no re-assertion needed.
- **Amendment (this slice):** `schema.ts` gained two replay-level refinements, both
  load-time guards for assumptions the engine makes and cannot check itself:
  - **uniform grid** — every sample's `t` within 2 ms of `k / sampleRateHz`. The O(1)
    lookup never reads `t`, so irregular spacing had to fail loudly rather than
    silently misplace the car.
  - **span agreement** — every car's `samples.length / sampleRateHz` within one grid
    step of `meta.duration`. The engine wraps on the car's own grid and the transport
    wraps on `meta.duration`; pinning them together turns a slow car-vs-scrubber
    desync into a load failure, and rejects v2 multi-car replays whose drivers carry
    different sample counts before Slice 9 can meet one.
- **Verify:** `npm run test -- --run` green with coverage ≥90% on engine modules present
  as of this slice; still zero React/DOM imports anywhere in `src/engine/`.

### [x] Slice 4a — Store + single rAF loop + bare car on track
- `src/store/` (Zustand): **discrete transport only** — `isPlaying`, `speedMult`,
  `seekTarget`, loaded `replay`. **No clock in the store.**
- `src/render/`: canvas component + one `requestAnimationFrame` loop owning a
  `clockRef`. Advance `clock` by `dt * speedMult`; wrap at `duration`. Reads the engine
  (`sampleAt`); never subscribes to per-frame state.
- Draw the faint full track ribbon + a single car marker moving along the fixture lap.
  No trail/corners/start-finish yet.
- App loads + `parseReplay`s the committed fixture on startup (schema validation at load).
- **Amendment (this slice):** the clock's advance rule moved into the engine as
  `src/engine/clock.ts` (`frameDelta`, `advanceClock`, `MAX_FRAME_DT_S`) instead of
  living inside the rAF callback. The loop keeps the clock ref; the engine owns the
  arithmetic, so the discipline is unit-tested and under the `perFile` coverage gate:
  scaled deltas accumulate (never derived from an absolute timestamp, so a speed
  change cannot rescale elapsed time), `dt` is clamped to 100 ms (a backgrounded tab
  resumes without teleporting), and wrapping goes through the existing `wrapClock`
  rather than a second implementation.
- **Amendment (this slice):** `geometry.rotateHeading(headingRad, rotationDeg)` was
  added to fix a world-vs-screen mismatch found in review. Positions are rotated by
  `meta.rotation` before drawing, but `sampleCarAt` returns a WORLD-space heading, so
  anything that points — the marker's heading tick now, the car body later — was off
  by exactly the rotation. Invisible in the car's position, which is why the pin test
  measures the drawn tick against successive *screen-space* marker positions.
- **Verify:** `npm run dev` shows the car animating the fixture lap; the clock lives in
  `clockRef` (not React/store state); no per-frame `setState`; one car, no count
  special-casing; smooth 60fps.

### [x] Slice 4b — Full track render + load/error states + reduced-motion
- Complete the render: speed-bucketed **trail** (the signature), start/finish line, and
  corner markers — all reading the engine, drawn in the same rAF loop.
- Render an **error/empty state** if fixture load/parse fails (don't crash on bad data).
- **`prefers-reduced-motion`**: start paused (no ambient motion); otherwise autoplay.
- **Amendment (this slice):** the trail is **retained and append-only**, not rebuilt per
  frame. `src/render/trail.ts` holds one `Path2D` per speed bucket per car and appends
  only the segments the clock has newly crossed — 0 or 1 per frame at 60fps on a 10 Hz
  grid. The prototype's approach (nine fresh `Path2D`s and a full re-walk every frame)
  was the first real per-frame allocation pressure in the app, and 4a's `drawRibbon` was
  already allocating ~585 point objects per frame to redraw a line that had not moved.
  Both are gone: `src/render/paths.ts` projects world→screen once per **resize** into a
  retained ribbon path and a flat `Float64Array`, so the frame callback allocates nothing
  but one point per car.
  - The only rebuild is a BACKWARDS clock (lap wrap or a backwards seek) — a `Path2D`
    cannot be un-drawn — plus a resize. That accounting is now a test, not a comment:
    `Path2D` construction is counted and asserted flat across 120 frames, +1 build on
    resize, +1 reset on wrap/back-seek, and **zero** on a forward seek.
  - A resize rebuilds the painters, which resets them; the next frame refills to exactly
    the covered portion at the current index. Pinned by test at the new scale, with a
    negative assertion that it is not the old projection.
  - **Trail semantics: covered-portion.** The trail shows where the car has been THIS
    lap and resets at the line. Confirmed over two laps against the alternative
    (persist a completed lap, reset only on a backwards seek): at steady pace
    lap-over-lap variation is minimal, so persistence preserves redundant information,
    while the reset reads as a clean lap-rhythm marker. Slice 5's scrubber can assume
    this.
  - Draw order is `ribbon → trail (head segment included) → start/finish → corner
    badges → car markers`, pinned by a test on the recorded call order. The head
    segment belongs with the rest of the trail: drawn after the chrome it would paint
    over badges every other trail segment passes under, and at 20 cars each car's head
    would paint over its neighbours'. Car positions are computed once per frame into a
    `Float64Array` allocated at measure time, so splitting the passes stays free.
- **Amendment (this slice):** corner labels are offset off the racing line via a new pure
  `geometry.labelDirection` — the local track normal, sign-disambiguated by the lap's
  centroid. Drawn at their own coordinates (as the prototype does) they sit on top of the
  trail, which is the one thing on the canvas worth looking at. The offset is applied in
  SCREEN pixels after the transform, so a badge stays a constant distance clear at any
  zoom. Start/finish uses the schema's own `track.startFinish.angle` through
  `rotateHeading` — the same world-vs-screen correction 4a added for the heading tick.
- **Amendment (this slice):** the bootstrap error does **not** live in the transport store
  (rule 1: discrete transport state only). `src/data/bootstrap.ts` returns a result
  instead of throwing, `main.tsx` passes it to `App` as a prop, and
  `components/ReplayError.tsx` renders `ReplayValidationError.message` **verbatim** in a
  `<pre>` — the message is newline-structured and its `→ at cars[0].samples[3].speed`
  lines are the whole point, so it is shown, not summarised.
- **Amendment (this slice):** reduced motion is read once at store-construction time
  (`src/store/motion.ts`), turning AUTOPLAY off rather than the feature — play/pause and
  seek keep working. Re-reading it live would yank playback from someone who had just
  pressed play. `matchMedia` is guarded because jsdom has none and the store would
  otherwise throw at import, taking every test with it.
- **Verify:** trail paints by speed; corners + start/finish render correctly; reduced-motion
  starts paused; a deliberately broken fixture shows the error state instead of a blank canvas.

### [ ] Slice 5 — Transport controls + HUD (keyboard-operable, ≤30fps reads)
- `src/components/`: Transport (play/pause, restart, 0.5/1/2/4× multiplier, scrub) and
  HUD (speed, gear, throttle, brake, lap clock, speed-trace sparkline + playhead).
- HUD reads an **interpolated snapshot ≤30fps**, never per frame; canvas stays out of
  React's render path. Seek/scrub writes `seekTarget`; the rAF loop applies it.
- **DRS indicator renders only when the data carries `drs`** — no year branching.
- **Keyboard**: space=play/pause, arrows=seek/restart, etc.; visible focus rings.
- **Verify:** every control is keyboard-operable with visible focus; HUD + playhead
  track the clock; DRS pill absent on a `drs`-less fixture; no per-frame `setState`.

### [ ] Slice 6 — Wire real data via pipeline (offline app stays on fixture)
- Refactor `pipeline/build_replay.py` so output conforms **exactly** to `schema.ts`
  (continuous interp; discrete forward-fill; **omit `drs` when all-zero/2026+**).
  **Inherited from Slice 2** (decided there, not optional here): emit
  `meta.schemaVersion: 1`; forward-fill the **raw** DRS code instead of decoding it
  (drop `np.isin(drs_raw, [10,12,14])` — `src/engine/drs.ts` owns that mapping now);
  **clamp** throttle into 0–100, since real FastF1 data occasionally exceeds 100 and the
  schema will reject it. Add a
  step that **prints the actual telemetry columns** for the loaded session and validates
  shape before trusting any channel. Pin `requirements.txt` (FastF1 3.8+, Py 3.10+).
- Generate a real lap (default: `2024 Monza Q VER`) into `app/public/data/` (gitignored)
  and let the app optionally load it; the committed fixture stays the default so app +
  tests + CI run fully offline. Pipeline needs network → **human runs it locally**,
  never in CI/sandbox.
- **Verify:** run the pipeline command from CLAUDE.md locally; app loads the JSON and
  validates clean; visuals checked against a known lap (corner count, lap time, top
  speed plausible). CI remains network-free and green.

### [ ] Slice 7 — v1 acceptance & polish (measure built-in concerns)
- Responsive layout; final empty/error copy. Measure the numeric acceptance criteria:
  60fps with 1 car, cold-load < 2s on fixture, Lighthouse Perf ≥90 / A11y ≥95 / Best
  Practices ≥95. Fix regressions in the concerns already built (not new late work).
- **Verify:** Lighthouse + an fps check meet PRD thresholds; full keyboard pass; runs
  with zero network.

## Phase v2 — multi-car race replay (engine & schema unchanged)

### [ ] Slice 8 — Session-time alignment in the engine + pipeline
- `src/engine/align.ts`: resample every driver onto one shared **SessionTime** grid
  (not per-lap `Time`) so all cars show the same instant. Pure + unit-tested.
- Implement `build_race_replay()` in the pipeline emitting `cars[]` length > 1 on that
  shared grid. **No changes to `schema.ts` or the existing engine** should be required.
- **Verify:** unit tests for session-time alignment; a multi-car JSON validates against
  the unchanged schema.

### [ ] Slice 9 — Multi-car render + driver selection + gaps
- Render iterates the existing `cars[]` (already an array — no count branching). Driver
  show/highlight selection; relative gaps in the HUD.
- **Design constraint (decided in Slice 4b, not open for re-debate):** the full thermal
  trail is a property of the **selected car only**. Unselected cars get at most a short
  fading tail in team colour. Twenty full-lap speed trails on near-identical racing lines
  is visual mud — the trails overlap, the thermal ramp stops encoding anything legible,
  and the signature of the app becomes noise. Settled here so Slice 9 inherits it as a
  constraint rather than rediscovering it. `TrailPainter` already supports this: trail
  length is whatever range of segments gets appended, so a short tail is a bounded
  `syncTo` window, not a different mechanism.
- **Verify:** multi-car replay shows all cars at the same instant; **≥50fps with 20
  cars** on a mid-tier laptop; selecting/highlighting drivers works by keyboard.

## Maintenance (not phase-bound — schedule after the slices above)

### [ ] Slice 10 — Toolchain: Vite 8 + vitest 4 migration
- `vite` 5→8, `vitest` + `@vitest/coverage-v8` 2→4. These are **interlocked** — vitest 4
  requires a Vite 6+ peer — so they move together or not at all.
- `@vitejs/plugin-react` 4→5 (v5 supports Vite 8; v6 is optional, later).
- Clears **all 7 `npm audit` advisories**, including the transitive `brace-expansion`
  copies pinned by `minimatch` under `eslint` and `@vitest/coverage-v8`.
- **Expect config work, not a version bump.** PR #9 (vite 5→8) had its Vercel build
  **fail**; budget for Vite config and plugin-API changes.
- **Hand-rolled PR** per the PR #20 pattern — `.github/dependabot.yml` ignores all npm
  majors, so no bot PR will arrive for these.
- **Verify:** `npm run check` green; `npm audit` clean (or only dev-only residual, stated
  explicitly); a **real Vercel preview build** succeeds — not an "Ignored Build Step" skip.

## Backlog (ideas — not committed)
- WebGL/3D escalation **only** if measured 20-car perf demands it (documented path).
- Track-surface niceties: kerbs, sector coloring, mini-map.
- Ghost/delta vs a reference lap; multi-lap stints.
- Per-team color tokens sourced from FastF1 plotting.
- Shareable deep-links (session + driver in URL).
- Pipeline: cache warming + a committed "golden" small real fixture for visual tests.
