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

### [x] Slice 5 — Transport controls + HUD (keyboard-operable, ≤30fps reads)
- `src/components/`: Transport (play/pause, restart, 0.5/1/2/4× multiplier, scrub) and
  HUD (speed, gear, throttle, brake, lap clock, speed-trace sparkline + playhead).
- HUD reads an **interpolated snapshot ≤30fps**, never per frame; canvas stays out of
  React's render path. Seek/scrub writes `seekTarget`; the rAF loop applies it.
- **DRS indicator renders only when the data carries `drs`** — no year branching.
- **Keyboard**: space=play/pause, arrows=seek/restart, etc.; visible focus rings.
- **Amendment (this slice):** the HUD reads through a **telemetry channel**
  (`src/telemetry/channel.ts`), not the store. Per-frame values in the store are what
  rule 1 forbids, so a separate module makes the boundary structural. The rAF loop calls
  `publish(nowMs, clock, cars)` every frame — a plain function call, never a `setState` —
  and the channel emits only when **both** a 30 Hz window has elapsed **and** a displayed
  value actually changed. Components read it with `useSyncExternalStore`.
  - The changed-value condition is what makes reduced-motion's paused start cost **zero**
    HUD renders instead of 30/sec of identical digits.
  - The first publish emits immediately (`lastEmitMs` starts `null`) so the HUD paints on
    mount rather than sitting blank for 33 ms; the cadence window starts from that emit.
  - `nowMs` is the rAF timestamp, so cadence is measured on the same clock as the frames
    and is deterministic under the existing `installRafDriver`.
  - `TrackCanvas` publishes and subscribes to nothing; `Hud` and `TransportBar` are its
    **siblings**, never ancestors. `commits === 1` is pinned in `TrackCanvas.test.tsx`;
    `App.test.tsx` adds the complementary bound — commits scale with the 30 Hz cadence,
    never with frame rate.
- **Amendment (this slice):** the scrubber commits **live** (`seek` on every change) and
  holds a local value only while a pointer drag is in flight, so the 30 Hz snapshot cannot
  yank the thumb backwards under the finger during playback. On release it returns to
  snapshot-driven: no snap-back, and `isPlaying` is never touched, so playback resumes
  from where it was let go. `step` is set explicitly to one grid step (`1/sampleRateHz`) —
  left unset it defaults to 1 s, ten times coarser than every other seek path.
- **Amendment (this slice):** relative keyboard seeks are based on the last published
  clock (the UI cannot read the loop's ref) and the hook remembers the target it last
  issued, so key-repeat does not compound 33 ms of staleness into a short landing. The
  handler stands down whenever the event landed on an element that already handles that
  key natively — otherwise arrowing the focused scrubber would seek twice per press.
- **Amendment (this slice):** `prettier --check` joined `npm run check` as `format:check`.
  Prettier was a devDependency wired into nothing, so the PostToolUse hook and the repo
  had silently drifted — 8 files on `main` failed it, all from Slice 4b. Fixed here, and
  now gated in CI via `verify`.
- **Verify:** every control is keyboard-operable with visible focus; HUD + playhead
  track the clock; DRS pill absent on a `drs`-less fixture; no per-frame `setState`.

### [x] Slice 6 — Wire real data via pipeline (offline app stays on fixture)
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
- **Amendment (this slice):** the pipeline split along the seam that made it untestable.
  `pipeline/replay_transform.py` is **pure** — numpy and the stdlib only, no FastF1, no
  pandas, no I/O — and holds every resampling/clamping/assembly decision;
  `build_replay.py` is the only module that touches the network. This is the Python
  mirror of rule 4, and it is what lets pytest run in CI with no network at all.
  `pytest.ini` gates `replay_transform.py` at **≥90% lines AND branches**
  (`--cov-branch --cov-fail-under=90`), the same bar `vite.config.ts` holds the engine
  to. Currently 100%/100% over 57 tests.
- **Amendment (this slice):** the schema is enforced against pipeline output in **two**
  places, because each is blind to the other's failure mode:
  - `app/scripts/validate-replay.ts` (`npm run validate:replay -- <file>`, via
    `vite-node`) runs the app's **real `parseReplay`** over a file. `build_replay.py`
    invokes it on what it just wrote and exits non-zero on failure — a missing
    toolchain is a hard error with instructions, not a silent skip, and `--no-validate`
    is the explicit escape hatch. This catches *this* file, on the human's machine.
  - `pipeline/tests/golden/lap-{drs,nodrs}.golden.json` are committed real pipeline
    output, validated through `parseReplay` by `src/data/pipelineContract.test.ts` in
    CI. This catches *future* files — a pipeline edit nobody ran, or a schema
    tightening that invalidates existing output.
  - `pipeline/tests/test_golden.py` keeps the goldens honest about the pipeline
    (regenerate + compare), so the vitest half cannot be fooled by a stale file.
    Its equality is **structural** (`json.loads`), never bytes: byte equality would be
    hostage to key order and float repr. The files are nonetheless *written* through
    one canonical `dump_json` (sorted keys, indent 2) so a refreshed golden diffs line
    by line — formatting for review, structure for the assertion.
- **Amendment (this slice):** real data reaches the app through a **file picker**
  (`ReplayFilePicker` + `data/loadReplayFile.ts`), not a fetch. `app/public/data/` is
  gitignored, so a `fetch("/data/…")` path would work in `npm run dev` and 404 on the
  deployed site; the picker works identically in dev and production with zero network,
  on a file that by policy cannot be committed. A failed pick keeps the replay already
  on screen and renders the validation message **verbatim** (the Slice 4b rule).
  `TrackCanvas` zeroes its clock ref when the replay's *identity* changes — the ref
  deliberately outlives a resize, and a picked lap must start at the line, not most of
  the way round someone else's circuit.
- **Amendment (this slice):** the picker forced the keyboard handler's native-first rule
  to generalise. It exempted Space for `tagName === "BUTTON"` only, which was every
  control that existed at the time; `<input type="file">` is the first control that
  activates on Space without being a button, so one keypress would have opened the file
  dialog **and** toggled playback. `nativelyActivatable()` now covers
  BUTTON/SUMMARY/`[role=button]`/`a[href]`/Space-activating input **types**. It is a
  type list rather than the `INPUT` tag on purpose: `<input type="range">` — the
  Scrubber — does *not* activate on Space, so exempting the tag would have silently
  removed play/pause from the control most likely to hold focus during playback. Pinned
  by a test in both directions.
- **Amendment (this slice):** `verify` now runs `format:check` (Slice 5 recorded this as
  done; it was only in `npm run check`, never in CI) and the Python suite on **3.10 and
  3.12** as step pairs *inside* `verify` — not a separate job, because
  `.github/ruleset.json` names `verify` as the required check by that exact string and a
  separate job would not block a merge until a human edited branch protection. CI
  installs `requirements-dev.txt` only, so FastF1 is not even importable there.
- **Verify:** `npm run check` green (313 tests, engine coverage 100%); `pytest` green
  (57 tests, `replay_transform` 100% lines+branches); `npm run validate:replay` green on
  both goldens and exit-1 with named paths on a deliberately broken one. **Outstanding —
  needs a networked human:** run the pipeline command from CLAUDE.md against a real
  session and check the render (corner count, lap time, top speed) and in particular
  `meta.rotation`'s sign, which cannot be verified offline — see the note in Slice 7.

### [ ] Slice 7 — v1 acceptance & polish (measure built-in concerns)
- **Carried in from Slice 6 (needs network, so it could not be settled there):** check a
  real lap end to end. `meta.rotation` comes from FastF1's `circuit_info.rotation` and is
  applied by `geometry.rotateWorld` (a standard rotation matrix on canvas' y-down axes);
  whether the two conventions agree in SIGN is unverified, because no real circuit info
  exists offline to check against. If a known circuit renders mirrored or on its side,
  the fix is a negation in the pipeline — decided by looking at the render, then
  documented. Also confirm corner count, lap time and top speed are plausible.
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
  - **The speed trace joins this.** `Hud` sources its sparkline from `cars[0]`, which —
    unlike the track ribbon's `cars[0]` — is **not** a choice-of-source argument. Track
    geometry is shared, so any car's lap is the circuit; a speed trace is per-car data
    with no such equivalence. It is a placeholder for *the focused car*, well-defined
    today only because there is exactly one. Slice 9 binds it to the selection mechanism,
    same as the thermal trail.
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
