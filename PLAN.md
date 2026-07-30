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
  both goldens and exit-1 with named paths on a deliberately broken one.
- **Verified against real data (2026-07-28, 2024 Monza Q VER, 797 samples @ 10 Hz):**
  the lap renders true — layout recognisably Monza, corner badges on corners,
  start/finish perpendicular to the track, thermal ramp hot on the straights and cold
  through the chicanes, DRS pill behaving. **`meta.rotation`'s sign convention is
  CORRECT as-is** (FastF1 gave 95.0° for Monza; `geometry.rotateWorld` consumes it
  unchanged). No negation needed — this was the slice's one open question and it is
  closed. Slice 6 is done.

### [x] Slice 6b — Arc-length reparameterization (dot velocity agrees with speed)

**Promoted from Backlog, ahead of Slice 7.** Four reasons, recorded so the ordering is
not re-litigated: it is the single most **user-visible** quality issue in the app; it is
**fully diagnosed with numbers** (below), so it is scoped work rather than an
investigation; it is **pipeline-only with one golden refresh**, so the blast radius is
small and known; and it should land **before any real-data lap becomes someone's demo**
— the surging dot is the first thing a viewer notices and the hardest to un-see.

- **Symptom:** on a real lap the car marker's apparent velocity surges and eases on the
  straights, outside any braking zone, visibly disagreeing with the speed the HUD shows.
- **Measured cause** (`monza_ver.json` + raw FastF1 streams, 2026-07-28). The first
  hypothesis was piecewise-constant velocity from a low-rate position stream; the
  numbers refuted the mechanism while confirming the premise:
  - Position and car telemetry are independent channels, each ~**4.2 Hz** median
    (240 ms) and **irregularly** spaced (p10 160 ms, p90 400 ms, min 40 ms);
    `get_telemetry()` merges them to ~7.4 Hz (308 `pos` + 300 `car` + 2 interpolated).
  - **Not stair-stepping:** in the emitted 10 Hz file the implied velocity changes at
    **742 of 795** step boundaries (run lengths `[(1,695),(2,40),(3,5),(4,1)]`). Noise,
    not held segments. `|Δxy|/Δt` vs the speed channel is **r = 0.697**, implied speeds
    reaching **740 km/h** against a true max of **348**, ratio range 0.28–2.41.
  - **Inherited, not introduced:** the raw position stream alone scores **r = 0.704**;
    our 10 Hz resampling nudges it to **0.737**.
  - **High-frequency jitter:** widening the differencing window from ~240 ms to ~1.3 s
    takes r from **0.707 → 0.974** and the implied/actual ratio's sd from
    **0.280 → 0.070**. Real motion survives smoothing; the error averages out.
- **Well-posed:** path length from the position stream (**5742.6 m**) and ∫speed·dt
  (**5732.8 m**) agree to **0.17%** — the channels agree on distance and disagree only
  on timing, which is exactly what makes speed the better parameterization.
- **Scope:** variable-step resampling driven by **∫speed·dt** — each 10 Hz sample
  advances the distance the car actually covered, with position supplying the path
  shape and speed supplying the progress along it. Includes a decision, written down,
  about which channel wins where they disagree. **Pipeline-only:** `x`/`y` are
  re-derived before they are written, so `schema.ts`, `src/engine/` and the renderer are
  untouched; cost is one golden refresh (`python tests/regenerate_golden.py`).
- **Prior art:** `prototype/TelemetryReplay.jsx:85` `resampleByArcLength(pts, step)`
  walks a polyline emitting points at **equal** arc-length steps. That is the geometry
  half only — this needs the variable-step form.
- **Verify:** post-fix, recompute implied-vs-actual speed correlation at **k = 1** (the
  single-step window, no smoothing): **target r > 0.97**, matching what the k = 5 window
  already recovers from the same data — i.e. the fix should make one step as truthful as
  a 1.3 s average is today. Plus the eyeball check on a real lap: the dot no longer
  surges on the straights, and marker motion tracks the HUD speed. Pytest covers the new
  resampling against synthetic frames to the usual ≥90% lines+branches bar.
- **Amendment (this slice):** `replay_transform.resample_positions_by_travel` replaces
  the two `interp_continuous` calls that produced `x`/`y`. Position supplies the path
  shape (`cumulative_arclength` over the recorded polyline), speed supplies the progress
  along it (`cumulative_travel`, trapezoid). Nothing else in the pipeline moved, and
  `schema.ts`, `src/engine/**` and the renderer were not touched — confirmed by the
  golden diff, in which the ONLY sample fields that changed are `x` and `y`.
  - The travel integral runs over the **raw** speed samples and is then interpolated
    onto the grid, not built by integrating the already-resampled `gspeed`. It uses the
    source samples that fall *between* grid points, which is where a braking zone keeps
    its detail; and integrating `gspeed` would make the k = 1 verification metric
    exactly constant by construction, measuring nothing.
- **Amendment (this slice) — the scale decision, settled.** Progress is normalised onto
  path length as a **fraction** (`s_k = d_k / d_total * s_total`), not carried across as
  a raw metric distance. Recorded so it is not re-litigated:
  - **It makes the transform unit-agnostic.** FastF1's X/Y are in 1/10 m and Speed in
    km/h, both undocumented. A raw metric mapping would need a hard-coded `0.1` and
    `1/3.6` in `replay_transform.py`; wrong by either factor — or right until FastF1
    changes one — and every sample lands at a wildly wrong arc position. A
    dimensionless ratio cancels both, and a test pins it (`Speed` in mph emits
    identical positions).
  - **The lap provably closes,** so total distance was never the question — only its
    distribution in time, which is the one thing speed is being trusted for.
  - **It is free on the metric and buys the boundary.** r and the ratio's sd are
    scale-invariant, so normalising cannot flatter the result. What it buys: a raw
    mapping leaves the last sample ~9.8 m short of the path end and dumps that
    shortfall into the wrap step at the start/finish line, where the natural step is
    ~7 m. Measured after the fix the wrap chord is **6.17 m** against 6.27 m before —
    unchanged, no lurch at the line.
  - The 0.17% path-vs-speed disagreement is not resolved by this, it is **distributed**:
    0.17% spread over every step, finer than the 1 dp `x`/`y` are emitted at.
- **Amendment (this slice):** degenerate inputs. A **partially** zero speed channel is
  ordinary data and needs no special case — the travel integral goes flat, the car holds
  position, motion resumes. **Duplicate position fixes** are dropped before the lookup
  (zero-length segments carry no direction and would otherwise leave the interpolation
  leaning on numpy's undocumented NaN fallback for a zero-width interval). An
  **entirely** zero speed channel, or a path covering no distance, raises
  `TelemetryShapeError` — falling back to time interpolation would silently reship the
  exact bug this slice removes, and the module's standing rule is that impossible data
  fails loudly (the same reason `clamp_throttle` does not clamp speed).
- **Verified against real data (2026-07-28, 2024 Monza Q VER, 797 samples @ 10 Hz),**
  k = 1, implied `|Δxy|/Δt` vs the speed channel, true max 348 km/h:

  | | r | ratio mean | ratio sd | ratio range | implied max |
  |---|---|---|---|---|---|
  | before | 0.6983 | 1.0018 | 0.2717 | 0.28–2.41 | 740 km/h |
  | after | **0.9998** | 1.0026 | **0.0070** | 0.96–1.06 | 349 km/h |

  Target r > 0.97 met with room to spare, and the ratio's sd — the metric the diagnosis
  used — is 39× tighter. **Nothing else moved:** `meta`, corners and every non-position
  sample field are byte-identical, so lap time, HUD, gears and trail colours are
  untouched; the emitted polyline's length is unchanged at 5754.8 m, i.e. the samples
  moved *along* the path, not off it. Mean position shift 3.7 m, max 18.4 m, sample 0
  exactly 0.
- **Known artifact this does NOT fix, flagged for Slice 7:** `meta.duration = n/rate`
  rounds the lap up to a whole grid step (Monza: 79.7 s against a real 79.667 s), so the
  wrap step traverses ~6.2 m of ground over a full 0.1 s — one slow step per lap, at the
  line. It is inherited from the grid, not introduced here (the wrap chord is the same
  before and after), and fixing it means touching `duration` and the schema's
  span-agreement refinement.
- **Unrelated pre-existing wart, noticed while regenerating:** `fastf1.plotting` is not
  bound by a bare `import fastf1` in 3.8.3, so `build_replay.py`'s team-colour lookup
  always fails and every real lap gets `DEFAULT_COLOR` with an empty team. Present in
  the pre-fix file too. One import line, but undiscussed, so not touched here.

### [x] Slice 7 — v1 acceptance & polish (measure built-in concerns)
- ~~Carried in from Slice 6: verify `meta.rotation`'s sign against a real lap.~~
  **Settled 2026-07-28 — the convention agrees, no change needed.** FastF1's
  `circuit_info.rotation` (95.0° for Monza) feeds `geometry.rotateWorld` unchanged and
  the circuit renders true. Recorded here so nobody re-opens it: the pipeline must pass
  `ci.rotation` through **as-is**, and a future circuit rendering sideways is a bug in
  something else, not a missing negation.
- Responsive layout; final empty/error copy. Measure the numeric acceptance criteria:
  60fps with 1 car, cold-load < 2s on fixture, Lighthouse Perf ≥90 / A11y ≥95 / Best
  Practices ≥95. Fix regressions in the concerns already built (not new late work).
- **Verify:** Lighthouse + an fps check meet PRD thresholds; full keyboard pass; runs
  with zero network.

- **Amendment (this slice) — the wrap-step artifact is FIXED, not documented.** The
  decision Slice 6b deferred here, argued on the merits and settled:
  - **The severity is a lottery, and 6b's eyeball check drew a good ticket.** Let
    `r = lap·rate − floor(lap·rate)`, the fractional part of the lap in grid steps —
    uniform on [0, 1). The wrap step plays `r/rate` seconds of travel over `1/rate`
    seconds, so the car crosses the line at **`r` × its true speed**, every lap.
    `monza_ver` drew r = 0.70 and that is what "I watched for it and couldn't see it"
    was measured on. `E[r] = 0.5`; one lap in five draws `r < 0.2`; `r → 0` parks the
    car at the line for a tenth of a second. The synthetic test lap draws exactly 0.
  - **6b's own recorded principle decides it.** 6b rejected a raw metric mapping for
    "trading a 0.17% global bias for a ~230% local one at the most-watched point on
    the circuit". This is that trade again, same answer.
  - **No contract line moves** — the premise in 6b's flag ("fixing it means touching
    `duration` and the span-agreement refinement") was wrong. `t`, `meta.duration`,
    both schema refinements and all of `src/engine/**` are untouched; the golden diff
    shows `meta` byte-identical, sample counts identical, every `t` identical.
- **Amendment (this slice) — the approved plan was INCOMPLETE, and the measurement is
  what said so.** Recorded as history rather than smoothed over, because the sequence
  is the point. The plan approved one mechanism (the time base). Implemented and
  measured against both real laps, it fixed VER (**0.696× → 1.078×**) and made LEC
  **worse** (**0.849× → 1.241×**) — an overshoot larger than the undershoot it removed.
  That result was the diagnosis: an overshoot of exactly the wrong size means a second
  term, and measuring the raw fixes found it (the lap does not close). With both halves
  LEC lands at **1.001×**. The loop is 6b's own — measure, diagnose to a mechanism, fix
  with the numbers written down — run inside a single slice, and a fix that had shipped
  after the first measurement would have made one of the two real laps worse.
- **Amendment (this slice) — the fix is two halves, because the defect had two terms.**
  The second was found by measuring the first, which fixed VER and made LEC *worse*.
  - `replay_transform.source_times` — samples are EMITTED at `k/rate` (what the schema
    requires) but READ at `k·lap/n`, laying the whole lap over the whole grid so every
    step, wrap included, covers `lap/n` seconds of real motion. Cost: a uniform time
    base stretch of `duration/lap`, **≤0.125%** for an ~80 s lap at 10 Hz.
  - `replay_transform.closing_time` — a lap's recorded fixes stop **short of the fix
    they started from** (Monza Q: **0.67 m** VER, **2.12 m** LEC, both cleanly in the
    direction of travel), yet the app loops sample n−1 straight back to sample 0. That
    ground is inside the wrap step too, so the lap the grid covers is the recorded time
    **plus** the time to cover it. Signed along the direction of travel, so telemetry
    cut *late* shortens the lap instead. Unit-safe by the same travel/path ratio 6b
    established — no hard-coded 0.1 or 1/3.6.
  - Without the second half the wrap step overshoots by exactly the shortfall: VER
    0.696× → 1.078×, but **LEC 0.849× → 1.241×**, a bigger error than the one removed.
- **Amendment (this slice):** both corrections are **printed, not implied**.
  `build_replay.py` ends every run with `lap 79.662s recorded + 7ms to close the loop
  (+0.07 of a grid step) · time base stretched 1.00038x onto the grid`. A justified,
  negligible bias should still be impossible to be surprised by.
  - The closing cost is reported as a **fraction of a grid step** because that is the
    number with a threshold attached, and it is scale-free across sample rates and
    circuits. Monza Q: **+0.07** (VER) and **+0.24** (LEC) of one step.
  - **Tripwire:** exceeding **one whole grid step** of travel prints a loud warning.
    Past that the closing chord stops being a rounding correction — the samples nearest
    the line pile onto the final fix and the emitted lap length is a guess built on the
    gap. Loud, not fatal: the output is still schema-valid and still worth looking at.
    This is the pathological-lap and wrong-sign case that synthetic tests can only
    simulate; every real lap now announces where it sits against the bound.
- **Verified against real data (2026-07-28, 2024 Monza Q, both drivers regenerated
  from the warm cache):**

  | | wrap chord ÷ previous step | implied at the line | speed channel | stretch |
  |---|---|---|---|---|
  | VER before | 6.17 / 8.87 = **0.696×** | 222 km/h | 319 | — |
  | VER after | 8.88 / 8.86 = **1.003×** | 320 km/h | 319 | 1.00038× (+7 ms) |
  | LEC before | 7.56 / 8.90 = **0.849×** | 272 km/h | 321 | — |
  | LEC after | 8.91 / 8.90 = **1.001×** | 321 km/h | 321 | 1.00019× (+24 ms) |

  **6b's metrics are undisturbed:** r = 0.9998 on both laps before and after; ratio sd
  0.0070 → 0.0069 (VER) and 0.0062 → 0.0064 (LEC); implied max unchanged at 349/351
  against true 348/351. Sample shift mean 1.13 m / max 2.71 m (VER) and 0.57 m /
  1.36 m (LEC) — smaller than 6b's own 3.7 m / 18.4 m — with sample 0 at exactly 0.00 m.
- **Amendment (this slice) — responsive layout.** The track and the HUD sit side by
  side above `md` and stack below it; the HUD's readout becomes a row, the transport
  bar wraps with the scrubber taking a full row of its own (`order-last`), and
  `h-screen` became `h-dvh` — `100vh` on mobile excludes the retracting address bar, so
  the transport bar sat under it. Verified by real 412×823 and 1350×940 renders
  (`docs/screenshots/slice-7-responsive-*.png`), not by class inspection.
- **Amendment (this slice) — Lighthouse found four real defects, all in concerns
  already built, all fixed rather than banked.** The first run already cleared every
  PRD threshold (Perf 100 / A11y 95 / BP 96), which is exactly when it is tempting to
  stop reading:
  - `errors-in-console` — no icon, so every load 404'd on `/favicon.ico`. Added
    `app/public/favicon.svg` (the THERMAL ramp as a painted corner) and an explicit
    `<link rel="icon">`. It is the one place a palette value is duplicated: the file is
    served before any script runs, so it can reach neither the CSS vars nor the engine.
  - `aria-allowed-role` + `definition-list` — `role="meter"` on a `<dd>` stops it
    counting as a `<dd>`, which is invalid on the element AND breaks the enclosing
    `<dl>`; a loose `<span>km/h</span>` broke it a second way. The meter moved to an
    inner `<div>` and the unit moved inside the `<dd>`, where it also reads better
    ("192 km/h", not "192").
  - `label-content-name-mismatch` — the speed buttons showed `0.5×` (multiplication
    sign) and were named `0.5x speed` (letter x), so voice control could not act on
    what a user can read (WCAG 2.5.3). The test now asserts the name contains the
    element's own `textContent`, so the two cannot drift apart again.
- **Measured (2026-07-28), `vite preview` on the production build:**
  - **Lighthouse 12.8.2 — mobile 100 / 100 / 100, desktop 100 / 100 / 100**
    (Performance / Accessibility / Best Practices), against thresholds of 90 / 95 / 95.
    Zero failing audits of any kind.
  - **Cold load:** FCP = LCP = TTI **0.3 s** desktop, **1.4 s** mobile (throttled), CLS
    0, TBT 0 ms — against a < 2 s bar.
  - **Zero network:** exactly three requests, all same-origin — document, JS, CSS. No
    data fetch, no external host.
  - `npm run check` green with **0 warnings** (313 tests, engine coverage 100%);
    `pytest` green (**88 tests**, `replay_transform.py` 100% lines + branches);
    `validate:replay` green on both regenerated real laps and both refreshed goldens.
  - **Not measured by me: sustained fps.** The rAF sampler needs a foreground window
    (`document.visibilityState` was `hidden`, which throttles rAF to nothing), so the
    60fps check is the human pass's first item, not a claim made here.

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

### [ ] Slice 11 — Make the pipeline's colour fallback honest

Two halves of one idea, filed together from PR #31 and **not** done there — that PR was
deliberately one import. **A default that impersonates a plausible answer is the same
species of quiet wrongness PR #31 removed**, which is why this is a chore rather than a
nicety.

- **`DEFAULT_COLOR` currently impersonates a real answer.** It is `#3671C6` — the hex
  widely published as Red Bull's brand blue — so a failed team-colour lookup renders as
  a plausible Red Bull lap instead of an obvious default. That is precisely why the
  always-failing `fastf1.plotting` lookup survived a whole slice unnoticed: the wrong
  output looked right. Change it to an obviously-wrong neutral (e.g. `#888888`) so a
  failed lookup *looks* failed.
- **Decide whether the `except` around the colour lookup should warn loudly.** Broad and
  non-fatal was the right original call — a colour is not worth failing a fetch over —
  but now that the guaranteed failure is gone, that path has effectively never been
  exercised. If it fires again it is a NEW condition worth looking at, not background
  noise, and it currently prints one line into the middle of FastF1's own log output.
- **Touches the golden ratchet:** `DEFAULT_COLOR` lives in `replay_transform.py`, so
  expect a golden refresh alongside. Both goldens pass an explicit `#3671C6`, so the
  emitted colour may not move at all — check rather than assume.
- **One small PR**, single-purpose, same protocol as PRs #23 and #31.
- **Verify:** `pytest` green with `replay_transform.py` still at 100% lines+branches
  (`test_normalise_color` parameterises `DEFAULT_COLOR` and will need its expectations
  re-read, not just re-run); `npm run check` green; and a real lap built for a driver
  whose team colour cannot be confused with the new fallback — **not VER**, whose blue
  is what made the original bug invisible.

## Backlog (ideas — not committed)
- WebGL/3D escalation **only** if measured 20-car perf demands it (documented path).
- Track-surface niceties: kerbs, sector coloring, mini-map.
- Ghost/delta vs a reference lap; multi-lap stints.
- Per-team color tokens sourced from FastF1 plotting.
- Shareable deep-links (session + driver in URL).
- Pipeline: cache warming + a committed "golden" small real fixture for visual tests.
