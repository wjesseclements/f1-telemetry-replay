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

### [x] Slice 8 — Session-time alignment in the engine + pipeline
- ~~`src/engine/align.ts`~~ — **no such module was needed, and that is the finding.**
  Alignment is not a transform the app applies; it is a property the pipeline builds
  in. Every driver is resampled onto one grid at emit time, so by the time the app
  sees a replay, `cars[k]` is already the same instant for everybody and `sampleAt`
  needs no new code at all.
- Implement `build_race_replay()` in the pipeline emitting `cars[]` length > 1 on that
  shared grid. **Done.** `--laps A-B` switches `build_replay.py` into window mode.
- **Verify:** unit tests for session-time alignment; a multi-car JSON validates against
  the schema.

- **Amendment (this slice) — what a v2 replay IS.** A shared session-time **window**
  containing N cars on one grid, not a per-car lap. The window is named by a
  **reference driver's lap range** (`--drivers VER,LEC,NOR --laps 20-22`), and that is
  a correctness choice rather than an ergonomic one:
  - a whole-lap window starts on the start/finish line, so `track.startFinish` —
    taken from the reference car's `samples[0]` — is the line. Measured on the real
    excerpt: VER's sample 0 is **exactly 0.00 units** from it.
  - `paths.ts` closes the ribbon with `closePath()` from `cars[0]`, which only closes
    for a whole number of laps. An arbitrary `t0` draws a chord across the infield.
  - A full race is arithmetically out: ~4400 s × 20 cars ≈ **75 MB** through a file
    picker. Three laps × three cars is 1.6 MB.
- **Amendment (this slice) — additive within `schemaVersion` 1, argued against the
  refinements rather than asserted.** Uniform grid holds by construction (one shared
  grid). Span agreement holds **exactly**, not to within one step — Slice 3 wrote that
  refinement to "reject v2 multi-car replays whose drivers carry different sample
  counts", and it passes. The only contract line that moved is one new `meta` field
  with a **default**, so every replay written before it still loads and still means "a
  lap". Bumping to 2 would have invalidated every generated lap on disk to describe
  something none of them do differently.
- **Amendment (this slice) — the engine changed, and it is one field and one line.**
  `interpolate.ts`'s header claimed "a replay is a closed lap" as a standing fact. It
  is a fact about the DATA, so it now lives in the data: `meta.loop: "closed" | "open"`.
  `sampleCarAt` gains a required 4th parameter and one line
  (`j = loop === "open" ? min(i+1, n-1) : (i+1) % n`); `headingAt` already held the
  previous direction on a zero-length step, so it was correct for free. `clock.ts`,
  the store, `scene.ts`, `paths.ts`, `trail.ts` and `TrackCanvas.tsx` are **untouched**.
  - **The transport still loops, so the window's end is a HARD CUT** — cars jump back
    to their start positions in one frame, trails reset. Video-loop semantics, stated
    in the header because it is easy to mistake for the bug it replaces.
  - **Measured on the real excerpt, both modes:** through the final grid step every car
    sits **0.00 units** from its last sample (held). Closed mode would put LEC **1504
    units** away — halfway through a **3008-unit (~300 m)** glide across the circuit in
    0.1 s. In the browser the HUD freezes at `142/210/0 km/h` for the whole final step
    and then jumps to `277/263/0` in a single frame: a cut, not a glide.
  - Note VER's own closing chord is only **257 units**, because the reference car
    starts *and* ends at the line. The reference car nearly masks the defect; it is the
    other cars that expose it.
- **Amendment (this slice) — the two flagged span assumptions, settled.** One fact
  (`loop`) settled all three flags, which is the check that the shape is right:
  - **6b's travel/path normalisation: KEPT.** Its load-bearing reason (the
    dimensionless unit bridge cancelling FastF1's undocumented 1/10 m and km/h)
    survives verbatim. Its "the lap provably closes" clause was never doing the work —
    restated correctly, the premise is that the recorded polyline is ground the car
    covered and the position channel's total distance is trustworthy while its timing
    is not, which holds for any contiguous slice.
  - **`closing_time` and `source_times`: NOT CALLED for a window.** Both exist solely
    to give the app's cyclic wrap step a full step of travel. An open window has no
    cyclic wrap step, so there is no closing chord and the time base stretch is
    **1.000000** by construction.
  - **Degenerate cases:** partially-zero speed (pit box, grid), pit-lane excursions,
    retirements mid-window and data starting late all need **no special case** —
    the travel integral goes flat and `np.interp`/`forward_fill` clamp, so a car parks
    at its last known fix and nothing extrapolates. Only an **entirely** stationary car
    is new, via `covers_ground`: the same condition means *corrupt* for a lap (the lap
    builder still raises) and *parked in the box* for a window.
- **Amendment (this slice) — `covers_ground`'s threshold is on the SPEED channel, and
  that is the whole design.** A distance threshold in position units would embed
  FastF1's undocumented 1/10 m convention — the assumption the module exists to avoid.
  So the two tests are asymmetric on purpose: the path test is strict positivity (no
  threshold, no unit), and the travel test carries the bound (`PARKED_TRAVEL_M = 5 m`
  via `KMH_S_PER_METRE = 3.6`), because `SPEED_UNIT` is pinned by the schema on both
  sides of the contract. The scale bridge cannot be used to derive it — for a parked
  car the bridge is itself meaningless, which is exactly why the predicate exists.
  Pinned by tests at the boundary in both directions, including a position-rescaling
  test that is the executable form of "no position-unit assumption".
- **Amendment (this slice) — the approved plan's cross-car decision rule was BUILT ON
  A WRONG MODEL, and was dropped rather than followed. RATIFIED.** Recorded in the
  `closing_time` style, because the sequence is the point: a rule that fires is not
  the same as a rule that is right, and this one fired.
  - **The approved rule.** The plan claimed each car carried a per-car "unit bridge"
    (`path / travel`) into its placement, so cars with different ratios would drift
    apart along the track, and Slice 9's relative gaps would inherit that error. The
    rule, written down in advance so it could not be re-litigated afterwards: *if the
    spread implies more than one car length (~5 m) of along-track error over the
    window, switch to a single shared bridge taken from the best-conditioned car — in
    this slice.*
  - **It fired.** 2024 Monza R, VER/LEC/NOR over VER laps 20-22: ratios 2.787433 /
    2.783735 / 2.786036, a relative spread of 0.13% over an 18.2 km window =
    **24.15 m. Over the bar.** The remedy was specified, in scope, and ready.
  - **The experiment that refuted the mechanism.** Run before acting, precisely
    because a five-fold overshoot of the bar is either a real defect or a wrong model.
    `resample_positions_by_travel` places sample k at `(d_k / d_total) * s_total` — a
    FRACTION of the car's own path — so the ratio cancels algebraically and never
    reaches the output. Multiplying **one** car's speed channel by 1.5 moves that
    car's ratio by **33%** and leaves every emitted coordinate, its own and its
    neighbours', **byte-identical**. A quantity that can move a third of its value
    with zero effect on the output is not a source of positional error. This is 6b's
    unit-agnosticism working exactly as designed.
  - **Following the rule would have been a regression**, not a no-op: a shared bridge
    reintroduces the scale dependence 6b removed, unpins each car's endpoint from its
    own last recorded fix, and reopens the overrun 6b rejected. The rule was therefore
    **dropped, not satisfied and not quietly ignored**, and the refutation is kept as
    a named regression test
    (`test_one_car_s_speed_scale_changes_nothing_for_it_or_its_neighbours`) so that
    anyone who reintroduces an absolute or shared scale fails on it.
  - **The replacement diagnostic**, measuring something the output actually carries:
    **`motion_fidelity`** — 6b's own k = 1 implied-vs-actual check (`r` and the ratio's
    coefficient of variation), computed per car on every build instead of by hand
    once, with 6b's `r > 0.97` bar as a printed tripwire. Both halves are scale-free,
    so no hard-coded 0.1 or 1/3.6 anywhere. Real Monza race data scores
    r = 0.9998–0.9999 per car, matching 6b's post-fix lap numbers.
  - **Slice 9 inherits the corrected model:** gap accuracy rests on per-car motion
    fidelity, and there is no cross-car scale term to carry forward.
- **Amendment (this slice):** DRS inclusion is decided **once per replay**, not per
  car. Over a short window a driver who never opened DRS has an all-zero channel and
  would silently lose the HUD indicator while their team-mate kept it — two cars in one
  file disagreeing about whether the season has DRS. No schema refinement for it: the
  schema guards assumptions the ENGINE makes, and the engine makes none here.
- **Amendment (this slice):** `parse_lap_range` lives in `replay_transform.py`, not
  next to the argument parser. `build_replay.py` imports FastF1, which CI does not
  install, so nothing in it can be tested — anything with a quiet failure mode (a
  mis-parsed range is a different window, silently) belongs on the testable side.
- **Verified (2026-07-31):**
  - `npm run check` green with **0 warnings** (330 tests, engine coverage 100%).
  - `pytest` green (**149 tests**, `replay_transform.py` 100% lines + branches).
  - `validate:replay` green on all three goldens; a deliberately broken multi-car file
    exits 1 naming `cars[1].samples` (span) and `cars[2].samples[5].t` (grid).
  - **Real data — 2024 Monza R, VER/LEC/NOR, VER laps 20-22**, 260.61 s window →
    2607 samples per car @ 10 Hz, 1.6 MB, `loop: "open"`, time base 1.000000×:

    | | distance | motion fidelity r | spread |
    |---|---|---|---|
    | VER | 17408 m | **0.9998** | 0.0084 |
    | LEC | 18190 m | **0.9998** | 0.0067 |
    | NOR | 18195 m | **0.9999** | 0.0063 |

    6b's post-fix lap numbers were r = 0.9998, sd 0.0070 — the window builder holds
    the same quality on race data. Three distinct real team colours (`#0600ef`,
    `#e8002d`, `#ff8000`), so PR #31's binding works across teams.
  - **Rendered in the app through the existing picker, no UI changes:** Monza
    recognisable with 11 corners and S/F on the main straight, VER on the line at
    t = 0 while LEC and NOR sit 3106 and 3571 units away (the alignment being real,
    not three copies), three HUD readouts at one instant (312/322/320 km/h, all 8th
    gear).

### [x] Slice 9 — Multi-car render + driver selection + gaps
- Render iterates the existing `cars[]` (already an array — no count branching). Driver
  show/highlight selection; relative gaps in the HUD.
- **Inherited from Slice 8, so it is not rediscovered:**
  - `buildScene`'s ribbon and `track.startFinish` both come from `cars[0]`. That is
    only safe because Slice 8 restricts windows to whole laps of the reference driver.
    **Decoupling them from `cars[0]` is what would unlock arbitrary time-range
    windows** — which is the feature request behind "show me this overtake", so it
    belongs here rather than as a later cleanup.
  - Gap accuracy rests on **`motion_fidelity`**, not on any cross-car scale term —
    Slice 8 proved the per-car ratio cancels out of the placement entirely (see its
    regression test). Real Monza race data scores r = 0.9998–0.9999 per car.
  - A 3-lap window is 2607 samples per car. `TrailPainter` at 20 cars over that span
    is the first place the retained-`Path2D` accounting from Slice 4b gets a real
    test, and the full thermal trail is already settled as selected-car-only (below).
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

- **Amendment (this slice) — what a GAP is, and the two things it deliberately never
  does.** For a car `C` at clock `now`, project `C`'s position onto the FOCUSED car's
  own sampled path and read off the time `t*` the focused car `F` was at that point:
  `seconds = now − t*` (positive = behind), `metres = travel_F(now) − travel_F(t*)`.
  - **It never compares distance axes across cars.** VER covered 17408 m to LEC's
    18190 m over the same window — two numbers measured from two different points on
    the circuit with no common origin. They never appear in the same expression: only
    `F`'s path and `F`'s own travel integral are read, and `C` contributes one point.
    This is Slice 8's corrected model — no cross-car scale term — carried forward.
  - **It assumes no position unit.** Metres come from the SPEED channel (pinned by the
    schema as km/h on both sides of the contract) integrated over the gap, the same
    bridge Slice 8 used for `PARKED_TRAVEL_M`. Position units appear in exactly one
    place, the residual bound, converted through a ratio measured from the car's own
    data. Pinned by a test: scaling every `x`/`y` by 10 leaves seconds, metres and the
    residual bit-identical (6b's rule, in Slice 8's regression-test style).
  - **`null` is a real answer** and renders as an em dash, never a zero. A car ahead has
    no gap near the END of a window; a car behind has none at the very start; a car off
    `F`'s path by more than `MAX_RESIDUAL_M` (25 m) has none at all.
- **Amendment (this slice) — the lap-period defect, found by real data and invisible to
  synthetic data.** Recorded because the *reason* the tests missed it is the point.
  - A multi-lap window passes each point several times, so candidates are filtered to
    within half a lap of `now` — and the lap period is measured from the path itself,
    since a v2 window carries no lap markers.
  - The first implementation took the SPATIALLY nearest other pass. On a perfect
    synthetic circle every lap passes at exactly zero distance, so that is a tie the
    tests kept winning by luck. Real laps vary by a metre or two: on 2024 Monza R the
    two-laps-later pass was nearer than the one-lap-later pass, NOR's period came back
    **167 s instead of ~84**, the search window doubled, and LEC — one second behind —
    read **−82.80 s** on roughly half the samples.
  - Fixed by filtering to points the car genuinely returned to and taking the
    **soonest**, not the nearest. The regression test builds a circuit whose middle lap
    runs five metres wide, so the spatially-nearest return is two laps away while the
    soonest is one — the synthetic form of what the real lap did.
  - The value now comes back systematically ~0.4 s UNDER a lap (the return is timed
    from where the path first re-enters the residual bound). It is only ever halved
    into a search width, and erring narrow is the safe direction.
- **Amendment (this slice) — a white screen that predates this slice, made reachable by
  it.** Loading a one-car lap after a three-car window took the whole app down:
  `setReplay` swaps the replay immediately while the last published frame still holds
  the PREVIOUS replay's cars, so the HUD indexed `replay.cars[2]` of a one-car replay.
  The single readout indexed `replay.cars[i]` the same way, so this was always there —
  the tower just makes multi-car files normal. A frame whose car count disagrees with
  the replay is stale by definition and is dropped rather than partially rendered; the
  next frame is consistent within 16 ms. **Found in the browser in one action**, doing
  exactly what the slice asks a user to do.
- **Amendment (this slice) — selection lives in the transport store, and CLAUDE.md rule
  1's enumeration moved with it.** Two arguments settled it, neither of them taste:
  - the render loop already reads that store with `getState()` *inside the frame
    callback* and subscribes to nothing, so focus costs one property access and **zero**
    new subscriptions. Held in React and passed as a prop it would re-render
    `TrackCanvas` on every focus change, which `TrackCanvas.test.tsx`'s `commits === 1`
    test exists to forbid — that test now also writes `setFocusedCarIndex`;
  - the invariant "focus is a valid index into the current replay's cars" is enforced
    inside `setReplay`, atomically, instead of in an effect that has to notice.
  - Rule 1's parenthetical listed the store's four fields and was now wrong, so it was
    updated rather than left to rot: the prohibition is on PER-FRAME values, not on
    non-transport ones.
  - **`focusedCarIndex` is an index into `cars`, never a row in the tower** — the tower
    sorts itself and reorders, so a stored row position would silently mean a different
    car after a resort. `cycleFocus` steps in `cars[]` order for the same reason.
- **Amendment (this slice) — NO schema change, argued and rejected.** Storing focus as a
  driver code would have wanted a uniqueness refinement to be safe. Slice 8 recorded
  that the schema guards assumptions the ENGINE makes, and the engine makes none here —
  so the identity is the `cars` index, which is unique by construction, and
  `schema.ts` is untouched.
- **Amendment (this slice) — the tower is ONE list in running order, focused entry
  inline.** Sorted by signed gap, which is focus-independent (changing the reference car
  shifts every gap by a constant), so rows move at overtakes and at nothing else. The
  focused car's full readout sits at its own place in that order rather than pinned to
  the top: row position means "ahead of", and lifting one car out of it would make the
  tower lie about where that car is. **This is also what keeps a one-car replay
  identical** — one car, focused, rendered as the full readout, from a map that happens
  to produce one. No count branch anywhere.
  - **Hysteresis, not a mechanism:** a car takes the place above it only when it is more
    than **0.05 s** better, a dead band of twice that around every crossing which cannot
    oscillate. Without it two cars running together strobe their rows at 30 Hz. Nothing
    is retained but the previous order.
  - Cars with no gap pin to the bottom in `cars[]` order — an unknown gap has no place
    in a running order, and inventing one would put a car where the data does not.
- **Amendment (this slice) — the tail is a bounded REBUILD, which is 4b's note honoured
  in substance rather than literally.** 4b predicted "a short tail is a bounded `syncTo`
  window, not a different mechanism". Half right: a `Path2D` cannot express it, because
  a tail's BACK end moves forward with its front and a retained path cannot have
  segments removed. So `TailPainter` rebuilds every frame — but over the last
  `TAIL_SECONDS = 1.5` of travel only, so its cost is a constant per car and does not
  grow with a three-lap window the way a trail's would. It shares the focused car's
  screen-space `Float64Array`, so the projection is not duplicated.
  - The fade is quantised into **4 alpha bands**, mirroring the trail's 9 speed buckets.
    Strokes per frame are `cars × 4`, never `cars × segments` — 80 against 380 at twenty
    cars.
  - **Unfocused `TrailPainter`s are never synced**, which is where the twenty-car saving
    actually is. Refocusing costs one O(samples) refill, the same one-off a lap wrap
    already pays.
  - The focused car's marker is unchanged and gains NO selection ring. Everything that
    marks focus is subtracted from the other cars, which is what makes the one-car
    canvas identical rather than merely similar.
- **Amendment (this slice) — `displaySignature` gained rounded `x`/`y`.** The tower's
  gaps derive from positions. In practice they cannot freeze (the clock is already in
  the signature and position is a function of the clock), but that is an argument about
  what the engine can emit, and the trap in `Hud.test.tsx` is meant to be mechanical.
  The coupling test is now run over a MULTI-CAR replay as well, because a lone car is
  focused and a focused row shows no gap — so the single-car suite could never have
  caught it. No extra emits: the clock term already changes on every one.
- **Amendment (this slice) — the team NAME renders on the focused entry only.** In a
  compact row the two gap columns leave about six characters and "Red Bull Racing"
  truncates to "R…", which carries less than the colour swatch already does. Measured at
  the sidebar's real width in the browser, not guessed. **Degradation path recorded
  before it is needed:** at twenty cars, `gap_m` is the column that drops next. `gap_s`
  never does — it is the unit the one-second DRS rule and every broadcast interval are
  quoted in.
- **Verified (2026-08-03):**
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full
    log = 0): 425 tests, engine coverage **100%** lines/branches/functions on every file
    including `gaps.ts`, `runningOrder.ts`, `selection.ts`.
  - **Tests mutation-checked, not taken on trust.** Removing the hysteresis dead band
    fails 2 tests; removing the off-path `null` fails 1; flipping the gap's sign fails
    9; unbounding the tail fails 1.
  - **Real data — 2024 Monza R, VER/LEC/NOR, through the SHIPPED `gaps.ts`**, focus NOR:
    lap period 83.400 s, and across the whole 2607-sample window

    | | gap range | residual mean / max | no answer |
    |---|---|---|---|
    | VER → NOR | −12.120 … −6.800 s | 0.09 m / 22.84 m | 68 (2.6%) |
    | LEC → NOR | +0.700 … +1.174 s | 0.09 m / 16.37 m | 7 (0.3%) |

    VER is ahead for the whole window and LEC behind for the whole window, with no sign
    flips — the sanity check the −82.80 s defect failed.
  - **The accordion, which was the acceptance check.** Focus NOR, LEC behind, through
    the chicane. The on-screen readout was sampled from the DOM in a real browser and
    agrees with the module **to the last digit at every point**:

    | t | NOR | LEC | gap_s | gap_m |
    |---|---|---|---|---|
    | 104.0 | 316 | 338 | +0.785 | 71 m |
    | 105.4 | 205 | 290 | **+0.723** ← min | 49 m |
    | 107.0 | 98 | 125 | +0.811 | 26 m |
    | 110.0 | 69 | 70 | +1.025 | **20 m** ← min |
    | 110.6 | 81 | 68 | **+1.042** ← max | 21 m |
    | 114.0 | 222 | 195 | +0.950 | 55 m |
    | 121.0 | 314 | 312 | +0.912 | 79 m |

    **Both columns accordion, in phase, and it recurs every lap.** Metres run
    80 → 19.5 → 79, a **4.1×** compression — that is the effect the eye measures.
    Seconds run 0.865 → 0.723 → 1.042: LEC genuinely takes **0.14 s** under braking and
    NOR genuinely takes **0.32 s** back on exit. The eye was right; the seconds column
    separates the real gain and loss from the part that is only speed.
  - **fps: 600 frames in exactly 5.00 s = 120 fps** with 3 cars, in a visible tab on a
    120 Hz display — the display's full refresh rate with no dropped frames. Measured
    with a visibility-gated rAF counter that does no DOM work inside the loop; a hidden
    tab throttles rAF to nothing and would have measured zero.
  - **Keyboard, live in the browser:** ArrowDown steps VER → LEC → NOR → VER (wraps),
    ArrowUp wraps back, the speed trace follows focus every time, and with the scrubber
    focused ArrowDown does **not** change the car — the native-first guard holds.
  - **One-car regression:** `monza_ver.json` renders as it did in Slices 7–8 — full
    thermal trail, one glowing marker, corner badges, S/F, DRS pill. Zero tail strokes
    (`TrackCanvas.test.tsx` pins that too). The only HUD change is the driver/team
    header line, which is this slice's scope.
  - Screenshots: `docs/screenshots/slice-9-{tower-chicane,focus-and-tails,one-car-regression}`.
- **Ratified in the human's gestalt pass on production (2026-08-03) — the inline
  focused readout, on a file that actually swaps.** The decision shipped untested: three
  cars in a clean 3-lap window rarely change places, so "does the big readout moving
  vertically read as truth or as churn?" was an open question at merge. Tested on a
  **lap 13-19 pit-window file where the running order genuinely cycles**: it reads as
  truth updating, not UI churn, and the hysteresis held with no strobing. **The inline
  design stands as built** — this is settled, not to be re-litigated by a later slice
  that finds the movement surprising.
- **NOT claimed: ≥50fps with 20 cars.** No 20-car file exists, so the bar is not met and
  is not asserted. What IS established is the cost structure: per frame, 1 full trail
  (≤1 appended segment + 9 bucket strokes) + (N−1) × 4 tail strokes + N markers —
  **O(cars) with a small constant, independent of window length** — and gaps cost the
  frame path nothing at all, being computed in the HUD at ≤30 Hz. Filed as Slice 12.

### [x] Slice 9b — Trail semantics follow `meta.loop`

**Found in the human's gestalt pass on production (2026-08-03), on a multi-lap endgame
file.** In an OPEN window the focused car's trail paints the entire circuit after one
lap and keeps repainting it, turning the app's signature into a static speed map that
sits on top of every car. The cars are the thing you are watching; by lap two they are
dots on a wall of colour.

- **As observed** (`monza_endgame.json`, Monza R, PIA/LEC/NOR, focus LEC, **9:39.200
  window ≈ 7 laps**, screenshot at 7:47 running at **4×**): the trail is a complete,
  saturated closed loop of thermal colour. It has visually REPLACED the track ribbon,
  the S/F line and the corner badges; one car marker is discernible and the other two
  are not. **The severity scales with window length**, which is the tell — this is an
  unbounded quantity being drawn, and 7 laps is simply further along than the 3-lap file
  Slice 9 was built and screenshotted on, where the same defect was present at 1.5 laps
  and went unrecognised.
- **The tower is unaffected and was correct throughout** — PIA +7.269 / 517 m, both
  resolved, no em dashes over a 7-lap window. This is a canvas defect only, which is
  what makes it a micro-slice.
  - **Correction (2026-08-04):** this entry originally also recorded NOR at
    **+18.492 / 796 m**, transcribed from the low-resolution screenshot. It was a
    misread. Re-measured live at the same clock (7:47) with the same focus, NOR reads
    **+10.484 / 788 m** — and the original figure was internally inconsistent with its
    own metres column: 279 m of separation from PIA over 11.2 s implies 90 km/h on the
    main straight, where 3.2 s implies 314 km/h. The metres were right, the seconds
    were misread, and nothing in the code changed between the two readings (9b touches
    only rendering; `gaps.ts` is untouched). Recorded rather than silently edited,
    because a wrong number in the plan is worse than no number.
- **The unfocused tails are working and are simply drowned out.** They are 1.5 s of team
  colour against a full circuit of thermal paint. That is the argument for the fix being
  the right shape: bring the focused car into the same bounded regime the other cars are
  already in, rather than inventing a third behaviour.
- **Watching at 4× is when it is worst**, and it is the speed a long window invites.

- **It is mechanical, not a tuning problem.** "Covered portion" (Slice 4b) means "this
  lap" only because `TrailPainter.syncTo` resets when the clock goes backwards, and in
  a `closed` replay `meta.duration` IS one lap, so the wrap fires every lap. An `open`
  window's `duration` is the whole window, so the only reset is at its end and every lap
  in it accumulates. Nothing is behaving incorrectly; a semantic that was defined for a
  one-lap replay was inherited by a three-lap one.
- **This EXTENDS Slice 4b's ruling, it does not overturn it.** 4b chose covered-portion
  over persistence on the grounds that "at steady pace lap-over-lap variation is minimal,
  so persistence preserves redundant information". That is the same argument, applied to
  the case 4b never had in front of it: within an open window, a covered portion spanning
  several laps IS persistence. The rule stands; the case is new.
- **Scope — composition of shipped mechanisms, no new machinery:**
  - `loop: "closed"` → covered-portion trail, **exactly as today, unchanged**.
  - `loop: "open"` → the focused car gets a bounded **thermal** tail: the existing
    `TailPainter`, wearing `bucketOf`/`bucketColor` instead of one team colour, and
    longer than an unfocused tail (**~6–10 s, tuned by eyeball**, against `TAIL_SECONDS`
    = 1.5).
  - **Unfocused tails are untouched** — 1.5 s, team colour.
  - The branch is on `meta.loop`, a fact about the DATA, which is the precedent Slice 8
    set when `sampleCarAt` gained the same parameter. It is NOT a branch on car count
    (rule 2): a one-car open window would get the thermal tail too, and correctly so.
- **The one open design question, to settle with the eyeball, not in advance.** The tail
  fades by alpha band; the trail encodes speed by bucket colour. Doing both means a
  segment's colour is a bucket times an alpha, and the thermal ramp's legibility is the
  single thing this slice may not trade away — it is what the trail is FOR. Either:
  - keep the fade and batch per band per bucket — **≤ `TAIL_BANDS` × `SPEED_BUCKETS` = 36
    strokes per frame** for the one focused car, still constant and still independent of
    window length; or
  - drop the fade for the thermal tail and batch by bucket alone — **≤ `SPEED_BUCKETS` =
    9 strokes**, identical to today's trail, at the cost of a hard end rather than a
    fading one.
  Whichever reads better on the endgame file wins. Record which, and why, as an
  amendment.
- **Watch for:** `paths.ts` currently builds both a `TrailPainter` and a `TailPainter`
  per car. Only one is now reachable per mode, so build what the mode needs rather than
  leaving a painter that can never be stroked.
- **Bonus the bounded form brings:** a backwards seek needs no rebuild at all. The tail
  is recomputed each frame from `[index − L, index]`, so it is always correct — the
  `Path2D`-cannot-be-un-drawn problem that shapes `TrailPainter` simply does not arise
  in open mode.
- **Verify:**
  - **Bounded strokes per frame**, asserted as a number, and constant as the clock runs
    deep into a multi-lap window — the same shape as `TailPainter`'s existing bound test.
  - **Closed-mode files are PIXEL-IDENTICAL.** The v1 laps on disk are the regression
    fixtures, as in Slice 9: a closed replay must draw the same call sequence it draws
    today, including the same `SPEED_BUCKETS` retained-path strokes and zero tail strokes.
  - An open-mode replay draws **no retained trail `Path2D` at all** — the positive form
    of the same guard.
  - **Human eyeball on the endgame file is the acceptance**: the cars are legible against
    the track for the whole window, and the thermal ramp still reads as speed.
  - `npm run check` green with 0 warnings; engine coverage unmoved at 100%.
- **Out of scope:** the unfocused tail's length or colour; `TAIL_BANDS`; anything in
  `schema.ts` (`meta.loop` already exists and already means this); the pipeline.

- **Amendment (this slice) — the open design question is SETTLED: the fade stays.**
  `COMET_BANDS = 4`, ≤ `COMET_BANDS × SPEED_BUCKETS` = 36 strokes per frame for the one
  focused car. What made it work rather than muddy is a decision inside the ramp:
  **`COMET_ALPHA`'s newest band is exactly 1.0**, at any band count. A comet's colour is
  a bucket multiplied by an alpha, and the spec named the ramp's legibility as the one
  thing not to trade away — so the fade dims only what is BEHIND the car, and the head,
  where the eye actually reads current speed, is undimmed. Verified on the endgame file:
  the comet reads cyan through Ascari and red on the back straight in the same frame.
  - **The fallback stays one edit.** `COMET_BANDS = 1` yields a single fully-opaque band
    — the ≤9-stroke hard-end version — with nothing else to change, because the alpha
    formula is written in terms of the band count rather than hard-coded per band.
- **Amendment (this slice) — `COMET_SECONDS = 2`, and the spec's 6–10 s band was
  WRONG.** Tuned by eye against the endgame file, which is what the constant exists for.
  The gap between 6–10 and 2 is not an arithmetic error, it is what the arithmetic was
  measuring: **the spec reasoned in DATA time, and what a viewer judges is PERCEIVED
  length, which runs about 4× longer at the speeds a long window is actually watched
  at.** At 2 s the comet reads as recent history attached to the car — roughly one
  braking zone — and the circuit stays legible nine minutes in; at 8 s it was already
  creeping back toward the wall of colour this slice exists to remove. Recorded because
  the next constant reasoned from data-time will be wrong the same way.
- **Amendment (this slice) — the mode is resolved at BUILD time, not per frame.**
  `ScenePaths.trails` became `ScenePaths.focus: readonly FocusPainter[]` — the painter a
  car gets when focused, chosen once in `buildScenePaths` from `scene.loop`. Two things
  fall out that the spec asked for separately:
  - the painter a mode cannot reach is **never built** (a closed lap has no comet, an
    open window has no retained trail), and
  - `drawFrame`'s per-car loop has **no mode branch at all** — it calls
    `paths.focus[i].paint(...)`. `FocusPainter` is a one-method interface both painters
    satisfy; `TrailPainter.paint` wraps its existing `syncTo` → `stroke` → `strokeHead`
    in that order, which is what let the closed-mode sequence stay byte-identical
    through a refactor that moved the call site.
- **Amendment (this slice) — a test that was passing vacuously, found by mutation and
  left honest rather than deleted.** `CometPainter` restores `globalAlpha` to 1 after
  painting, and a mutation removing that line **passed the entire suite** — because
  `COMET_ALPHA`'s newest band is already 1.0, so the context is opaque when the loop
  ends. The line stays (the head being opaque is a property of the ramp FORMULA, not of
  the method: change the formula to end at 0.9 and the corner badges render
  translucent), and both the code and the test now say plainly that the assertion guards
  the seam rather than the line. `TailPainter`'s identical line IS load-bearing — its
  brightest band is 0.8.
- **Verified (2026-08-04):**
  - **Closed mode is byte-identical, measured not asserted.** The draw sequence was
    captured from UNMODIFIED code before any file was touched — 701 frames including a
    lap wrap, **79,213 calls**, 19 `Path2D` builds — and re-captured after the change
    through the identical harness. **md5 `2a1656781b3c361032843e751d837e5f` both times.**
    That ordering was the point of the exercise: a diff against a real capture, not an
    assertion written after the fact.
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full
    log = 0): **440 tests**, engine coverage still 100%.
  - **Mutations caught:** unbounding the comet (reaching back to sample 0) fails 2
    tests; dimming the newest band below 1.0 fails 1. The `globalAlpha` restore is the
    one that is not caught, and that is recorded above rather than papered over.
  - **Bounded, at the integration level:** 30 s into an open window the frame draws
    fewer `lineTo` calls than the number of samples the clock has covered, and no more
    than the comet's own span plus the chrome — the property whose absence caused the
    defect.
  - **Backwards seek allocates nothing** in open mode (`pathsBuilt` unchanged across a
    seek from 20 s to 1 s): there is no retained path to rebuild, which is the free win
    the spec predicted.
  - **Eyeball on `monza_endgame.json`** (Monza R, PIA/LEC/NOR, 9:39.200 window, focus
    LEC): the ribbon, the S/F line, all eleven corner badges and every car are legible
    for the whole window, including 9 minutes in, and at 4×. The comet reads as speed
    and fades behind the car without dimming the head. **Human eyeball: PASS.**
  - **Before/after are a matched pair** — same file, same clock (5:01.99), same focus,
    same gaps (PIA +8.689 / 608 m, NOR +12.630 / 946 m), same speed (251 km/h, 6th).
    The only difference is the trail. The "before" was produced by temporarily forcing
    the closed-mode painter, so it is this build's own defect rather than a screenshot
    from a different commit: `docs/screenshots/slice-9b-before-full-lap-trail.jpg` and
    `slice-9b-after-comet-2s.jpg`, with `slice-9b-comet-fade-and-ramp.png` zoomed on the
    shipped 2 s comet.
  - **Closed mode spot-checked by the human on `monza_ver.json`: indistinguishable**,
    agreeing with the byte-identical capture diff.
- **Follow-up (2026-08-05) — `TAIL_SECONDS` 1.5 → 0.5, which closes this slice's own
  focus-ratio flag.** 9b listed "the unfocused tail's length" as out of scope and left
  the comet-vs-tail ratio open. The full-field file settled it, eyeball-tuned by the
  human on 19 cars (Monza R laps 20-22) — the same method `COMET_SECONDS` was set by,
  reached from the other direction:
  - **1.5 s was sized for the three-car window it was built on.** At nineteen the
    tails overlap into a continuous band of team colour along the racing line, and a
    car stops being separable from its own history — the same species of defect 9b
    fixed for the focused car, arriving via field density instead of window length.
  - **The ratio is the point.** Focus is marked *entirely by subtraction* from the
    other cars (Slice 9: the focused marker gains no selection ring), so trail length
    is the only thing on the canvas that says which car is focused. 1.5 s against a
    2 s comet is **1.3×** and reads as noise; 0.5 s is **4×** and reads at a glance.
  - **Pinned as a relationship, not a value.** Both constants are eyeball-tuned, so
    the test asserts `COMET_SECONDS / TAIL_SECONDS >= 3` and that the tail still
    carries at least one segment per `TAIL_BANDS`, rather than freezing either
    number. Restoring 1.5 fails it. Before this there was **no test that could
    observe `TAIL_SECONDS` at all** — the stroke-count bound is written against
    `TAIL_BANDS` and is value-independent, so the constant could have drifted to any
    value in silence.

### [x] Slice 9c — Raise the comet's colour resolution

**Found in the Slice 10 verification pass (screenshot on record, Turn 4 braking zone,
`monza_endgame.json`).** The comet's 9-bucket thermal quantisation reads as visible
**stripes** at comet scale.

- **Nothing is behaving incorrectly — the constant is being read at a scale it was not
  chosen for.** `SPEED_BUCKETS = 9` was tuned for the full-circuit trail, where a
  bucket boundary falls somewhere along a lap of track and reads as *texture*. The
  comet is **short, focal, and adjacent to a glowing marker**, so the same nine steps
  land within a couple of centimetres of each other in the one place the eye is
  already looking. A braking zone sweeps the whole ramp in ~2 s, which is exactly the
  comet's length — so every boundary is crossed inside it, at once. This is the same
  species of finding as 9b: a decision made for a one-lap, whole-circuit view
  inherited by something with different dimensions.
- **Scope — the BATCHING KEY only, not the ramp.** `speedColor` and `THERMAL` do not
  change; the comet gets a finer quantisation of the same continuous ramp (**~32
  buckets**), and the circuit trail stays at **9**. The ramp is already continuous —
  only the sampling of it is coarse.
  - `paths.ts` currently builds one `Uint8Array` of bucket indices per car, shared by
    `TrailPainter` and `CometPainter`. A second, finer key array is the honest cost:
    one extra byte per sample per car (≈50 KB for 19 cars over a 3-lap window), built
    once at measure time, never per frame.
  - `BUCKET_COLORS` is resolved at module load; 32 strings instead of 9 is still free.
    `CometPainter`'s `present` array widens with it.
- **The bounded-strokes architecture stays intact, and the bound gets TIGHTER, not
  looser.** `CometPainter` already skips buckets not present in a band, so the real
  bound was never `bands × buckets` — it is the number of distinct (band, bucket)
  pairs actually present, which cannot exceed the segment count. At `COMET_SECONDS = 2`
  on a 10 Hz grid the comet is **20 segments**, so **strokes ≤ 21** (segments + the
  head) whether there are 9 buckets or 32. Still constant, still independent of window
  length — which is the property 9b exists to protect.
  - **The existing bound test asserts `≤ COMET_BANDS × SPEED_BUCKETS` and would go
    vacuous at 32** (128 ≫ 21). It must be re-pinned against the segment count, or the
    slice quietly deletes its own guard while appearing to keep it.
- **Also assess: do the 4 alpha bands band visibly too?** `COMET_BANDS = 4` quantises
  the fade the same way the buckets quantise colour, over the same short focal span. If
  it does, it warrants the same treatment and for the same reason. Decide with the
  eyeball and record the answer either way — including "it does not", so the next
  person does not re-open it.
- **Verify:**
  - **Human eyeball at the Turn 4 braking zone on the endgame file** — the acceptance.
  - **Strokes counted**, asserted against the segment-count bound above, and constant
    as the clock runs deep into a multi-lap window.
  - **Closed mode untouched, proved by md5** — the v1 laps are the regression fixture.
    Follow Slice 10's protocol, which is the ordering that makes it evidence: capture
    the draw-call sequence on unmodified code **before** touching a file, then
    re-capture through the identical harness. The harness is not committed; Slice 10's
    entry records the parameters (701 frames at 100 ms over the 58.5 s fixture).
  - `npm run check` green with 0 warnings; engine coverage unmoved at 100%.
- **Out of scope:** `THERMAL`'s stops or the ramp itself; `SPEED_BUCKETS` for the
  circuit trail; the speed legend (it generates its gradient from `THERMAL`, so it is
  already continuous and unaffected); the unfocused tails, which are single-colour.

- **Amendment (this slice) — the mechanism is a PARAMETER, so there is still exactly one
  definition of speed→colour.** `bucketOf(kmh, buckets)` and `bucketColor(bucket,
  buckets)` take the count as a **required** argument; `COMET_BUCKETS = 32` sits beside
  `SPEED_BUCKETS = 9` in `color.ts`. `THERMAL`, `speedRgb`, `speedColor` and the
  `BUCKET_MIN/MAX_KMH` domain are untouched — the comet samples the same ramp more
  finely, and there is no second palette that can drift.
  - **Required, not defaulted.** A default would let a wrong-resolution call happen in
    silence: the two keys are byte-compatible `Uint8Array`s, so nothing downstream would
    notice. That judgement was vindicated within the slice — see the mutation finding
    below, where exactly that mix-up survived the suite.
  - The bucketing tests now run over BOTH resolutions (`describe.each`), plus a
    no-drift pair: every comet colour is `speedColor` of its own band's midpoint, and at
    any speed the two resolutions land within half a band of each other **on the same
    ramp** — an exact bound, derived, not a tolerance picked to pass.
- **Amendment (this slice) — why 32, measured rather than rounded to.** The spec said
  "~32"; the number is argued from `monza_endgame.json` (Monza R, 3 cars, ~7 laps):
  - **The mechanism, quantified.** Single-step |Δv| over the whole file is p50 **1**,
    p95 **8**, p99 **13**, max **29 km/h** — *every* step in nine minutes of racing is
    smaller than one 30.6 km/h `SPEED_BUCKETS` band. That is why adjacent comet segments
    are forced to share a colour: the stripe is not a tuning miss, it is arithmetic.
  - Over the hardest 2 s braking event (315 → 108 km/h), the comet's 21 segments draw:

    | buckets | band width | distinct colours | longest run |
    |---|---|---|---|
    | 9 | 30.6 km/h | 8 / 21 | **5** |
    | 16 | 17.2 km/h | 13 / 21 | 3 |
    | **32** | **8.6 km/h** | **19 / 21** | **2** |
    | 48 | 5.7 km/h | 21 / 21 | 1 |

  - **The floor is the data** (8.6 km/h is under the p95 step, so in the regime that
    makes the stripe nearly every step crosses a boundary). **The ceiling is the comet's
    own geometry** — it is 21 segments, so by ~48 every segment gets its own colour and
    the batching key stops batching anything. 32 keeps a constant-speed stretch
    collapsing to one stroke, which is what the key is FOR.
- **Amendment (this slice) — the stroke bound is re-pinned to the SEGMENT COUNT, which
  is tighter than what it replaced.** `strokes ≤ span + 1`, `span = min(index, length)`
  — **21** at `COMET_SECONDS = 2` on a 10 Hz grid, independent of the bucket count and of
  window length. The old `COMET_BANDS × SPEED_BUCKETS` (36) would have become 128 and
  passed on anything; the slice would have deleted its own guard while appearing to keep
  it. A companion test pins the other side: on a full-ramp braking sweep the comet
  resolves **more distinct colours than `SPEED_BUCKETS`** while still inside the bound —
  so "tighter bound" cannot be satisfied by the change quietly not working.
- **Amendment (this slice) — the alpha-band question is ANSWERED BY LOOKING, and the
  answer is "yes, but not here". `COMET_BANDS` stays at 4 in this diff, pending the
  human's call.** Three matched renders, same file, same focus (PIA), same clock, only
  the constant differing — `docs/screenshots/slice-9c-*`:
  - **At Turn 4 (the acceptance site, clock 1:54.000, comet spanning 307 → 128 km/h):**
    the fade does **not** read as banding. The colour is sweeping the whole ramp across
    those 20 segments, and at 32 buckets it now sweeps it smoothly; the alpha steps are
    invisible underneath it. At 9 buckets the same frame shows the photographed stripes —
    a flat olive block, a step, a step, and a long uniform cyan block at the head.
  - **On a constant-speed straight (clock 1:52.000, 307 km/h) it is plainly visible**,
    and that frame is the reason to look rather than reason: with the colour essentially
    constant, everything left is alpha, and the comet reads as **three brightness steps**
    down its length. The no-fade variant at the same clock is one uniform bar.
  - **So the fade bands do quantise visibly — just not at the braking zone this slice is
    about, and not in a way 32 buckets made worse.** It is a Slice 9b property, untouched
    here. Raising `COMET_BANDS` is a second decision on a second constant, and it is the
    human's, so it is **not** taken inside this slice.
- **Amendment (this slice) — the draw-call harness is COMMITTED, as
  `docs/perf/drawcall-capture.mjs`.** Slices 9b and 10 each built it, used it and threw
  it away; Slice 12 named that re-derivation as the thing committing `fps-probe.js` was
  meant to stop, and this slice is the one that paid the cost. Filed as **the brief's own
  inconsistency resolved** rather than as scope creep: the same brief that says
  "trail.ts and its constants/tests, nothing else" also demands md5 evidence, and the
  instrument that produces it did not exist.
  - Outside `app/` for Slice 12's reason: it can never run in CI, so `npm run check`,
    `eslint .` and `format:check` must never adopt it. Run through `vite-node`, so it
    measures the shipped modules rather than a copy.
  - **It reproduces Slice 10's recorded figures exactly on unmodified code** — closed
    **79,213 calls / 19 `Path2D`**, open **107,010 / 1** — which is how it is known to be
    the same capture under a different digest recipe, not a new measurement wearing the
    old numbers.
  - It also answers the draw-call half of a frame-budget check **without a browser** (see
    the sweep below), which is worth having: `fps-probe.js` measures zero in a hidden tab.
- **Amendment (this slice) — a mutation found a real hole, and the test that closes it is
  the wiring test the slice was missing.** Handing `CometPainter` the trail's coarse key
  (a one-word slip in `paths.ts`) **passed the entire suite**. Membership in the comet's
  colour set cannot catch it: indices 0-8 are valid in a 32-entry table too, so the comet
  strokes perfectly plausible colours that are simply the wrong ones. The new test asserts
  the **mapping** — the head segment carries `bucketColor(bucketOf(speed, COMET_BUCKETS),
  COMET_BUCKETS)` — with a companion assertion that at that sample the two resolutions
  genuinely disagree, so it cannot pass on a lucky speed. It now fails for the `paths.ts`
  slip and for the same slip made one level up in `scene.ts`.
- **Verified (2026-08-07):**
  - **CLOSED MODE IS BYTE-IDENTICAL, and the capture ordering is what makes it evidence.**
    Captured on unmodified `main` (f9fc65d) **before any file was touched**, then
    re-captured through the identical harness afterwards:

    | mode | before | after | calls | Path2D |
    |---|---|---|---|---|
    | closed | `23fa7006…a816f` | **`23fa7006…a816f`** | 79,213 | 19 |
    | open (comet) | `b8e199bd…3b543` | `f33499f3…58960` | 107,010 → 111,986 | 1 |

    Open mode moving is the change. **`moveTo`, `lineTo`, `arc`, `fill` and `fillText`
    are byte-identical across it** — the whole delta is `beginPath` +2,488 and `stroke`
    +2,488 over 701 frames, i.e. **the same geometry in more colour batches**, which is
    exactly what "the batching key only, not the ramp" should look like in a diff.
  - **`28·N` DID NOT MOVE, measured on the real 19-car file** rather than argued.
    `monza_full_field.json`, mean calls/frame over the same 701 frames, before vs after
    the bucket change and nothing else:

    | cars | 9 buckets | 32 buckets | delta |
    |---|---|---|---|
    | 1 | 169.49 | 175.59 | +6.10 |
    | 3 | 225.39 | 231.49 | +6.10 |
    | 7 | 337.18 | 343.29 | +6.11 |
    | 13 | 504.87 | 510.98 | +6.11 |
    | **19** | **672.56** | **678.67** | **+6.11** |

    The per-car slope is **27.95 both before and after** (Slice 12's 28.0, diluted only
    by the handful of window-start frames where a tail band is still empty). Slice 12's
    acceptance was "`total` should move by a single-digit constant and `28·N` must not
    move at all" — the delta is a **constant +6.1 at every car count**, **+0.9%** of the
    frame's canvas work at 19 cars. The `field_19` subset is md5 `95bad63f…`, identical
    to `monza_full_field.json`, so the sweep is the real file with cars removed.
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full log
    = 0): **474 tests**, engine coverage **100%** lines/branches/functions.
  - **Mutations caught:** `COMET_BUCKETS` back to 9 fails 2; the comet stroking from the
    trail's colour table fails 4; the coarse key passed to the comet fails 1 (the new
    wiring test), in `paths.ts` and in `scene.ts` alike.
  - **Sustained fps: measured by the HUMAN, because it could not be measured here.** The
    MCP browser tab reports `visibilityState: "hidden"`, where rAF is throttled to
    nothing and `fps-probe.js` refuses to start by design — the same split Slice 7
    recorded. The draw-call half above is exact and needs no browser; the frame-drop half
    needs a foreground window. Run on `monza_full_field.json` (19 cars), 600 frames over
    5.0 s: **119.8 fps, callback mean 1.13 ms (p95 2.6 / p99 2.8 / max 4.3), 0 frames >
    20 ms**, against Slice 12's baseline of 120 fps / 0.967 ms / p95 2.1 / p99 2.5 / 0.
    - **Recorded with its one moved number rather than rounded to "unchanged":** callback
      mean is **0.967 → 1.13 ms**, +0.16 ms, which is **13.6% of an 8.33 ms frame**
      against 11.6% before. The bar is ≥50 fps — a 20 ms budget — so this is **5.6%** of
      it, and no frame came within a factor of four of missing. The +6.1 calls/frame is
      invisible at the frame level, which is what the two instruments agreeing means.
  - **Human eyeball at Turn 4 on `monza_endgame.json`, clock 1:54.000, focus PIA: PASS.**
    The comet reads as a continuous ramp; the stripes are gone. Confirmed live on the
    preview build, not from a screenshot. **This is the slice's acceptance.**
- **Amendment (this slice) — `COMET_BANDS` stays at 4, and the straight-line fade
  quantisation is filed as an OBSERVATION, not a defect.** The human's ruling, recorded
  so it is not re-opened: the stepping is real and reproducible
  (`docs/screenshots/slice-9c-straight-4-bands.png` against `-straight-no-fade.png`), but
  **no eye has complained about it** — it was found by deliberately constructing the
  frame that isolates alpha from colour, which is not a frame anyone watches. The fix
  location is documented (one constant, `COMET_BANDS`, whose alpha formula is already
  written in terms of the band count), so if it is ever reported it is one edit. Chasing
  it now would be optimising a thing found by looking for it.

### [x] Slice 9d — Unwrap the gap so the running order survives a full field

**Found in the human's first full-field load (2026-08-05): 19 cars, Monza R, laps
20-22.** Two symptoms, filed as one slice because they are one defect — the second is
the first observed near its boundary, and a fix for either that is not this fix leaves
the other standing.

- **Symptom 1 — cars far behind report as far ahead.** Observed: **HUL reads +50 s
  against a focused VER when it is genuinely ~34 s behind.** The arithmetic identifies
  the mechanism exactly: the lap period is **~84 s**, and `84 − 34 = 50`. The reported
  value is the true gap's complement about one lap, not a wrong number — the fold is
  the answer to a different question.
- **Symptom 2 — the tower strobes.** Cars sitting near the half-lap boundary flip sign
  frame to frame, and since `runningOrder` sorts on the signed gap, the whole tower
  re-sorts faster than a name can be read. **Same boundary, same cause**: 9's hysteresis
  is a 0.05 s dead band built for genuine close-quarters swaps, and it cannot damp a
  discontinuity of ±84 s.
- **Why 3 cars could never have shown this.** `gaps.ts` documents the convention
  honestly — *"candidates are filtered to within half a lap of `now` … the reported gap
  is therefore always the shorter way round — the standard convention"* — and for three
  cars within a few seconds, shorter-way-round and true-running-order are the same
  answer. **A 19-car field spans ~60 s of an ~84 s lap**, so most of it sits past ±42 s
  and the two answers diverge for the majority of the grid. The module is not doing
  something wrong; it is answering the question it was written for, and a full field
  asks a different one.

- **Direction (the human's, to spec against):** **continuity-unwrap relative progress
  per car.** A car's ahead/behind measure must be *cumulative* rather than folded into
  ±half a lap — no teleports across the boundary, so the ordering is the true running
  order and the sign is stable through a lap boundary rather than at the mercy of one.
  Both symptoms then fall out of the same property: the sort is correct because the
  quantity is monotone, and the flicker is gone because the quantity is continuous.
- **The hysteresis STAYS.** It was never the wrong mechanism — it is what damps genuine
  close-quarters swaps, and it is still needed for them. Unwrapping removes the
  discontinuity it was being asked to absorb and could not. Do not tune it up to paper
  over the wrap; that is the failure mode this entry exists to prevent.
- **Watch for, so it is not rediscovered:**
  - **`null` must stay a real answer** (Slice 9's rule). Unwrapping must not manufacture
    a gap for a car genuinely off the focused car's path — the pit lane, a spin, a
    retirement. An unwrapped quantity that never returns `null` has hidden a failure,
    not fixed one.
  - **Lapped cars are the case the schema cannot see.** `gaps.ts` records that it never
    claims "+1 lap" because the schema carries no lap counter. Unwrapping is exactly
    the machinery that starts to distinguish them — decide explicitly whether a car a
    full lap down is reported as such or is out of scope here, and write the decision
    down either way. Do not let it be decided by whichever fallthrough the code takes.
  - **Continuity needs state across frames**, which the gap path has not needed until
    now. It is computed in the HUD at ≤30 Hz and not on the frame path (Slice 9), so
    this does not touch rule 1 — but a per-car unwrap accumulator must survive a seek,
    a focus change and a replay swap without lying. A backwards seek is the case to
    test, since that is where "cumulative" and "recomputable" part company.
  - The pure-engine boundary (rule 4) holds: this is `gaps.ts` and `runningOrder.ts`,
    both already headless and both already at 100% coverage under the ratchet.
- **Verify:**
  - The `84 − 34 = 50` case, as a regression test built from the real geometry: a car
    ~34 s behind reads ~−34, not +50.
  - A car crossing the half-lap boundary holds its sign across it — the synthetic form
    of the observed flicker, in the style of 9's lap-period regression test.
  - Sort stability: over a full-field window, row order changes at overtakes and at
    nothing else. Assert a bound on re-sorts per second, not merely that it "looks
    stable".
  - **Human eyeball on the full-field file is the acceptance:** order matches what the
    track shows, the tower is legible at 19 rows, no strobing.
  - `npm run check` green with 0 warnings; engine coverage unmoved at 100%.
- **Out of scope:** the tower's visual density at 19 rows beyond legibility of the
  order itself (Slice 9 already recorded `gap_m` as the column that drops next);
  anything in `schema.ts`; the pipeline.

- **Amendment (this slice) — the mechanism is ONE SHARED CIRCUIT, not a per-car
  accumulator, and that is what answers the spec's hardest question for free.** Every
  car's position is projected onto **one lap of `cars[0]`** and unwrapped into cumulative
  progress `P`, precomputed for the whole window at load. `t*` is then `P_F⁻¹(P_C(now))`:
  one answer, no candidates to choose between, no fold.
  - **One lap, not the window, and this was found by measuring rather than reasoning.**
    Against the full three-lap path the nearest-segment search hops between laps, and a
    car's "laps completed" over a 2.999-lap window came back as **18.1**. On one lap an
    arc-position is in `[0, L)` and is unambiguous. `buildScene` already takes the ribbon
    from `cars[0]` on the same grounds.
  - **The seed is a RING CUT at the field's largest empty arc.** A field that does not
    reach right round leaves a hole, and the hole is where the running order starts.
    Measured on the real file the hole is **0.30–0.39 lap** against a second-largest
    inter-car gap of **0.09–0.13** — `seedMargin` **3.00**, against a `SEED_MARGIN_MIN`
    tripwire of 2.
- **Amendment (this slice) — the state lifecycle the spec asked for is EMPTY, and that
  is the answer rather than an evasion.** `P` is precomputed, so a gap is a pure function
  of `(replay, focus, car, clock)`: a seek, a scrub, a wrap and a replay swap are an O(1)
  array lookup, and a **focus change is free** because `P` does not depend on focus.
  There is no accumulator to drift, so "cumulative" and "recomputable" never part
  company — pinned by a test that walks the window backwards and asserts bit-identical
  gaps to walking it forwards. The incremental projection cursor the brief wanted **does**
  get built, inside the precomputation, where a car genuinely cannot teleport.
- **Amendment (this slice) — the sort key STAYS `seconds` and `ORDER_HYSTERESIS_S` is
  untouched. Moving it to `ΔP` was considered and rejected as a unit bug.** Against a
  progress-denominated key the seconds constant reads either as ~0.9 mm of track
  (vacuous) or as a fraction of a lap (~4 s, enormous), and **both would have passed
  every test that existed**. It buys nothing anyway: `P_F` is monotone, so `P_F⁻¹` is
  monotone, so ordering by `ΔP` and by `seconds` are identical. `runningOrder.test.ts`
  now measures the dead band by bisection and asserts it equals the constant, plus a
  paired probe in each wrong unit.
- **Amendment (this slice) — THE APPROVED FALLBACK WAS REFUTED BY REAL DATA AND
  REPLACED.** Recorded in full because the sequence is the point, and because the plan
  said the two definitions "differ only by second-order pace effects" — which is exactly
  the claim that failed.
  - The approved design answered a car near the window's start with the mirror question
    ("when will THIS car reach where the focused car is now?"), because a car 57 s behind
    has no `t*` inside the window for its first 57 s. It took the unanswerable rate from
    **11.5 % to 0.0 %** as predicted.
  - **A PIT STOP is where the two questions stop being the same quantity.** On the real
    file SAI and STR each cross the boundary mid-window and the readout jumped **19 s in
    one tick** (STR 51.2 → 32.0 at t = 32 s) as the definition switched under it — the
    same species of discontinuity this slice exists to remove, reintroduced by its own
    fix. Found by disbelieving a 19 s range on a car nobody had overtaken.
  - **Replaced by extending the window instead of switching the question.** The focused
    car passed that ground one of its own laps earlier, so `timeAtProgress` walks back
    whole laps of its progress and its time (`MAX_LAP_EXTENSION` = 4, then `null`). One
    definition throughout, **0.0 % unanswerable, and zero discontinuities**. The
    assumption — that the focused car's lap either side of the window resembles the one
    inside it — is stated, and anchored on that car's own measured lap rather than an
    invented pace.
- **Amendment (this slice) — a projection tie tolerance that looked reasonable and froze
  the answer.** The first version treated candidates within `MAX_RESIDUAL_M` of the
  nearest as tied and broke ties by continuity. For a car running parallel to the
  reference — the pit lane, or a different line down a straight — every segment for
  ±36 m is inside that band, so continuity always won and the arc STUCK, advancing in
  quantised 8.5 m jumps. Fixed by making the tolerance **exact equality**: the seam at
  arc 0 / arc L does not need a fuzzy tie either, because the lap counter turns a flip
  there back into continuous progress. Caught by mutation: restoring the coarse
  tolerance fails **46** tests.
- **Amendment (this slice) — the lapped-car ruling, in writing.** `Gap.lapsDown` is
  signed the same way as `seconds`: **`+1 LAP`** a lap behind, **`-1 LAP`** a lap ahead
  (`+2 LAPS` / `-2 LAPS` beyond). Both signs, because focusing a backmarker is the
  configuration that produced the measured strobe and its leaders are a lap up.
  - **Lapping that HAPPENS in the window is observed** — `ΔP` crossing `L` is an ordinary
    reading of the precomputed series.
  - **Lapping that PRE-DATES the window is NOT derivable, and is declared so.** From one
    instant's geometry "34 s ahead", "51 s behind" and "137 s behind" are the same
    picture. The seed assumes no car starts a lap down; `seedMargin` is the tripwire when
    that assumption is doubtful.
  - **Nobody is lapped in the real file** (max deficit ZHO **0.73 lap**), so this whole
    path is covered by synthetic tests only — the position Slice 7 was in with
    `closing_time`. A `+`-only implementation fails **2** tests.
  - `metres` stays the true total rather than a within-lap remainder: the plan proposed
    the remainder, but computing it needs the position-unit bridge in the metres column,
    which Slice 9's doctrine keeps out of the answer. `+1 LAP / 5931 m` is unambiguous.
- **Amendment (this slice) — a gap no longer depends on the published snapshot, and one
  Slice 9 test was asserting the opposite.** Gaps read the replay's precomputed progress
  at `clock`; in production that is the same thing the snapshot carries, but a test can
  no longer move one without the other. `Hud.test.tsx`'s signature trap was aimed at the
  unfocused car's POSITION and would now be asserting a defect, so it was re-aimed at
  what the tower is actually a function of: the **clock** (every row) and the **focused
  car's channels** (the readout). **Consequence for 9e, flagged not fixed:**
  `displaySignature`'s rounded `x`/`y` term is no longer load-bearing for the tower.
- **Verified (2026-08-05):**
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full
    log = 0): **463 tests**, engine coverage **100%** lines/branches/functions per file.
  - **Mutations caught** (engine + components suites): removing the lap-unwrap increment
    fails **16**; seeding at `cars[0]` instead of the ring cut fails **6**; using the
    whole window as the reference fails **15**; restoring the coarse projection tie
    fails **46**; forcing `lapsDown` to 0 fails **3**; dropping the whole-lap extension
    fails **3**; rendering an ahead-by-a-lap car as `+1 LAP` fails **2**; removing the
    hysteresis dead band fails **6**.
  - **Real data — 2024 Monza R, 19 cars, VER laps 20-22, through the SHIPPED module**,
    sampled at the HUD's own 30 Hz across the whole 260.7 s window:

    | | before (Slice 9) | after (9d) |
    |---|---|---|
    | HUL against a focused VER | **≈ −33 s** ("ahead") | **+52.0 … +53.2 s** (behind) |
    | field-total unanswerable | **22.5 %** | **0.0 %** |
    | ±lap sign flips, focus HUL | PIA **45**, NOR 19, LEC 5 | **0** |
    | discontinuities > 5 s, any car | 1–45 per focus | **0** |
    | re-sorts, focus VER / HUL | 0.10 / 0.40 per s | **0.07 / 0.06** per s |
    | order under two different focuses | differed past half a lap | **identical** |
    | gap query cost | 1.8 µs/car/tick | **0.17 µs/car/tick** |

  - **The 3-car accordion is BIT-IDENTICAL to Slice 9's recorded table** — the physical
    signature this rework was not allowed to disturb. Focus NOR, LEC behind, through the
    chicane, every value matching to the last digit: `+0.785`/71 m, `+0.723`/49 m,
    `+0.811`/26 m, `+1.025`/20 m, `+1.042`/21 m, `+0.950`/55 m, `+0.912`/79 m.
  - **Live in the browser on the full-field file, focus HUL, 4× playback:** 900 frames
    in 7.49 s (**120 fps**), **0 row-order changes**, **0 frames showing an em dash**.
    The tower reads VER −52.684 … COL −3.614 above a focused HUL, ZHO +4.533 below —
    monotone, correctly signed, no strobing.
    Screenshots: `docs/screenshots/slice-9d-tower-focus-{ver,backmarker}.jpg`.
  - **The lapped-car display was SEEN, on a file built to contain one.** No real file
    has a lapped car, so one was made the only way the ruling permits — a car that loses
    the lap *inside* the window (the real 3-car window with NOR replaying VER's own line
    at 0.6×, so the geometry stays real and only the pace is synthetic). At 4:10.000 the
    tower reads **`LAP +1 LAP 6829 m`** below LEC; focus that car and the two ahead read
    **`LEC −1 LAP`** and **`VER −1 LAP`**. Both signs, on screen, through the shipped
    module. Screenshot: `docs/screenshots/slice-9d-lapped-car.jpg`.
  - **A reciprocal pair is NOT symmetric when the pace differs, and that is the
    definition rather than a defect.** On that file at t = 180 s, VER→LAP reads +72.0 s
    while LAP→VER reads −63.2 s. Each is measured at the QUERIED car's current point, so
    they cover different ground at different speeds; with a 40 % pace difference the two
    magnitudes diverge visibly. It is the same asymmetry that made the approved
    `C`-future fallback wrong, observed from the other side.
  - **Acceptance (b), `fps-probe.js` per the Slice 12 protocol — no regression, and the
    frame got cheaper:**

    | | Slice 12 baseline | Slice 9d |
    |---|---|---|
    | draw calls / frame @ 19 cars | 680 (`148 + 28·N`) | **680, method for method identical** |
    | fps | 120 | **120** |
    | frames > 20 ms of 600 | 0 | **0** |
    | callback mean | 0.967 ms | **0.734 ms** |
    | callback p95 / p99 | 2.1 / 2.5 ms | **1.7 / 2.2 ms** |

    The canvas is untouched, which the identical draw-call breakdown proves rather than
    asserts. The **24 % callback improvement is a side effect**, not a goal: the gap
    query is 10× cheaper and a focus change no longer rebuilds an index.
  - **The one cost that went UP, recorded rather than buried: load.** Precomputing every
    car's progress moved into the load path, so the 9.99 MB full-field file goes
    **53.8 ms → 118.8 ms** (one 121 ms long task), settling at 144 ms. Still far inside
    Slice 7's < 2 s cold-load bar, and it buys the per-focus-change rebuild (a measured
    1.38 ms, nineteen times to cycle a field) going to zero.

### [x] Slice 9e — Scrolling speed trace

**Also from the full-field load.** Canvas-side only, and independent of 9d — filed
separately because it shares neither a mechanism nor a file with the gap defect.

- **The defect is the same shape as Slice 9b's**, which is the argument for the fix:
  a quantity that grows without bound is being drawn into fixed space. `Hud`'s
  sparkline covers the WHOLE window, so on a 7-lap file it compresses seven laps into
  a few hundred pixels and every braking zone becomes one pixel of noise. Legibility
  degrades with window length, exactly as the focused car's trail did.
- **Scope:** a **fixed playhead** with a **windowed trace scrolling past it** — the
  last ~30-60 s of the focused car's speed, not the whole window. Broadcast /
  heart-monitor semantics: the present is always at the same place on screen, and
  history moves. The window length is a constant tuned by eye on the full-field file.
  - **Tune it in PERCEIVED time, not data time.** 9b's `COMET_SECONDS` spec asked for
    6-10 s and shipped **2**, and recorded why: what a viewer judges is perceived
    length, which runs ~4× longer at the speeds a long window is watched at. The 30-60 s
    band above is a starting point from the same kind of reasoning that was wrong then.
    Expect to land lower, and record the number and the reason.
- **Bounded cost, and say so as a number.** The trace is a per-frame rebuild over a
  bounded span, like `TailPainter` — its cost is a constant, independent of window
  length. That property is the whole point and belongs in a test, in the shape of 9b's
  bound test.
- **Follows focus** (Slice 9 bound the trace to the focused car; that does not change).
- **Verify:** the drawn span is bounded and constant as the clock runs deep into a
  multi-lap window; the playhead does not move; a one-lap closed replay still reads
  correctly (the v1 files are the regression fixtures, as in 9 and 9b); human eyeball on
  the full-field and endgame files; `npm run check` green, coverage unmoved.
- **Out of scope:** the HUD's other readouts; the tower; `schema.ts`; the pipeline.

- **Amendment (this slice) — the degradations are the CLAMP, not branches.** One formula
  covers every regime, and that is what keeps "a window longer than the replay" from
  needing a letterbox case:

      span = min(TRACE_SECONDS, duration)
      t0   = clamp(clock − PLAYHEAD_FRACTION × span, 0, max(0, duration − span))

  - **`duration ≤ TRACE_SECONDS`** — `span` collapses to `duration`, `t0` is 0 forever,
    and what is drawn is the whole replay with the playhead sweeping: the pre-9e
    behaviour, reproduced rather than approximated. Pinned by a test that asserts the
    degraded playhead equals the old `tracePlayheadX` mapping (`clock/duration × width`).
  - **`clock < span`** — the fill-in. The trace grows from the left and the playhead
    sweeps up to its fraction, then pins.
  - **End of an open window** — `t0` clamps at `duration − span` and nothing runs off.
- **Amendment (this slice) — `PLAYHEAD_FRACTION = 1`: history only, as a named constant.**
  The window ends at the present; what is COMING is already shown in the better
  representation, the track itself, where a car approaches a corner spatially. Shipped as
  a fraction rather than a hard-coded right edge so that trying 0.75 later is an eyeball
  test rather than a layout rework — the `COMET_BANDS` precedent, where the fix location
  is documented before anyone asks for it.
- **Amendment (this slice) — closed replays CLAMP AT THE LINE; the window does not reach
  back into the previous lap.** Argued from consistency rather than taste: crossing the
  line resets the covered-portion trail (4b) as a lap-rhythm marker, and a trace that
  fills in from the line is that same design language on the time axis — the lap starts,
  the picture starts. Wrapping would treat the loop as continuous exactly where Slice 8's
  hard-cut convention deliberately treats it as a fresh lap, and two visualisations
  disagreeing about what the line means is worse than either choice alone.
- **Amendment (this slice) — `TRACE_SECONDS = 20`, and for once the spec's band was not
  wrong by 4×.** The spec said 30-60 s and warned (from `COMET_SECONDS`) to expect lower.
  It lands at 20, but the argument that fixes it is arithmetic rather than the eye:
  - **The ceiling is one sample per pixel.** The sidebar gives the trace ~192 CSS px, so
    at 10 Hz anything past **19.2 s** asks the box for more samples than it has pixels —
    this slice's own defect, in smaller print. 20 s sits on that ceiling.
  - **The floor is one braking event plus its recovery.** Measured by matched render, not
    asserted: at the same clock on `monza_endgame.json` (8:59.100, focus PIA), **10 s
    shows a gentle wander** — the braking zone has already scrolled out and there is no
    event in frame at all; **20 s shows plateau → brake → minimum → recovery**, one whole
    event; **30 s shows two events** and is legible, but is 1.56 samples per pixel and is
    throwing away detail the rasteriser then has to guess at.
    `docs/screenshots/slice-9e-window-{10s,20s,30s}.png`, same file, same clock, only the
    constant differing.
  - Pinned mechanically as `TRACE_SECONDS × rate ≤ TRACE_W`, the `TAIL_SECONDS` lesson:
    before 9b's follow-up no test could observe that constant at all. Setting 60 fails.
    The pin is a **proxy** — `TRACE_W` user units stretch to the sidebar's real width —
    and says so; the real bar is the eye at that width.
- **Amendment (this slice) — the inherited `displaySignature` question is CLOSED: the
  rounded `x`/`y` term is REMOVED.** 9d flagged it as no longer load-bearing for the
  tower; 9e is the other thing that could have wanted it, and does not — the trace is a
  function of the clock and the focused car's static samples, so no published coordinate
  reaches anything the HUD draws.
  - **The evidence that it was dead cargo is that nothing had to change.** Both
    perturbation suites in `Hud.test.tsx` walk every `CarSnapshot` field asserting
    *rendered change ⇒ signature change*; they pass untouched, because perturbing `x`
    changes no pixel. That mechanical trap is also what makes removal safe going forward:
    the day a readout prints a coordinate, the suite fails until the signature moves.
  - **Emit cadence and change detection are untouched** — `publish`'s 30 Hz window and
    its changed-value condition are not edited, and production emit counts cannot move,
    since a car that moved is a clock that moved. Pinned in `channel.test.ts` by a pair
    differing only in `x`/`y` at one clock, which is documented there as a pair
    production cannot produce.
- **Amendment (this slice) — the ≤30 Hz path got its own instrument, committed as
  `docs/perf/hud-tick.mjs`.** Slice 12's addendum settled the principle in prose after a
  brief asserted a per-frame cost for gaps that was 400× wrong — *"a 30 Hz cadence needs
  its own instrument; the frame harness neither covers it nor contradicts it"* — and then
  measured it with a Node benchmark it threw away. This is the second slice to want that
  instrument, so it is committed rather than re-derived a third time (`fps-probe.js` and
  `drawcall-capture.mjs`, same reasoning, same place outside `app/`).
  - It reports **points per tick** (integer-exact, no measurement floor — the number that
    carries the argument) as well as µs, because Slice 12 had to re-design its own
    instrument mid-slice for exactly that reason.
  - It **spans the change**: a documented compat shim reads whichever trace API is
    shipped, so before and after come from one harness, which is what the
    `drawcall-capture` ordering discipline requires.
  - It states what it does not measure next to what it does: **no React**. That half is
    `fps-probe.js`'s callback p95/p99 in a foreground window.
- **Verified (2026-08-08):**
  - **THE CANVAS IS UNTOUCHED, and it was captured BEFORE anything was edited.** Both
    modes, through `drawcall-capture.mjs` on unmodified `main` (ceef25f), then re-captured
    afterwards through the identical harness:

    | mode | before | after | calls | Path2D |
    |---|---|---|---|---|
    | closed | `23fa7006…a816f` | **`23fa7006…a816f`** | 79,213 | 19 |
    | open (comet) | `f33499f3…58960` | **`f33499f3…58960`** | 111,986 | 1 |

    Both identical, which is the expectation this slice stated in advance rather than
    discovered: the trace is a DOM/SVG sibling of `TrackCanvas` and no file under
    `src/render/` is in the diff. The before-capture also reproduces 9c's recorded
    figures exactly, so the harness had not drifted.
  - **The ≤30 Hz cost, measured through `hud-tick.mjs` on the real files.** Before is the
    pre-9e API on unmodified `main`; after is the shipped one, same harness, 6000 ticks:

    | file | samples/car | points in DOM | points/tick | µs/tick | µs/focus change |
    |---|---|---|---|---|---|
    | sample-lap 58.5 s | 585 | 585 → **202** | 0 → 157.1 | 0.22 → **16.2** | 58.4 → **5.4** |
    | monza_race 260.7 s | 2607 | 2607 → **202** | 0 → 186.6 | 0.21 → **21.4** | 289.0 → **4.7** |
    | monza_full_field 260.7 s | 2607 | 2607 → **202** | 0 → 186.6 | 0.20 → **22.3** | 352.2 → **4.0** |
    | monza_endgame 579.2 s | 5792 | 5792 → **202** | 0 → 186.6 | 0.18 → **22.0** | 607.7 → **8.0** |

    - **The trade is stated rather than buried: per-tick work went UP** (a division became
      a ~200-point string build), **and the DOM went down 28×** on the endgame file. At
      22 µs a tick that is **0.066% of the 33.3 ms tick budget** and 0.66 ms per second of
      wall time; the per-focus-change cost fell **76×** because the O(samples) path build
      is gone and only the min/max scan remains.
    - **Independence from window length is MEASURED, not claimed:** points/tick is
      **186.63 on both the 260.7 s and the 579.2 s file** — 2.22× the window, identical
      figure — which is how Slice 12 proved 9b's bound. The fixture reads 157.06 because
      it is a closed 58.5 s lap that fills in again after every wrap, which is the
      fill-in showing up in a number.
    - Node through `vite-node`, so the µs are a bound on the pure-JS half, not a browser
      measurement.
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full log
    = 0): **502 tests**, engine coverage **100%** lines/branches/functions per file.
  - **Mutations caught:** unbounding the window (drawing from sample 0) fails **7**;
    pinning the playhead at the edge unconditionally fails **5**; `TRACE_SECONDS = 60`
    fails **7** (the density pin plus the bound tests); dropping the interpolated head
    fails **2**; scaling y to the visible window instead of the replay fails **1** — the
    "same sample, same y at two clocks" test, which exists for that mutation alone.
  - **Before/after are a matched pair**: `monza_endgame.json`, clock **8:59.100**, focus
    PIA, same gaps (LEC −6.341 / 393 m, NOR +3.883 / 242 m), same speed (253 km/h, 6th).
    The only difference is the trace. `docs/screenshots/slice-9e-before-full-window-`
    `sparkline.jpg` is a **picket fence** — 5792 samples in ~192 px, the finding's
    "texture, not signal" photographed — against `slice-9e-after-scrolling-20s.jpg`,
    where nine minutes in the trace reads plateau → brake → minimum → recovery.
  - **Closed one-car regression, live** (`monza_ver.json`, 1:19.700): at clock 10 s the
    trace is **filling in from the line** with the playhead halfway across
    (`slice-9e-closed-lap-fill-in.png`); by 40 s it is a full 20 s window scrolling with
    the playhead pinned (`slice-9e-closed-lap-scrolling.jpg`). The canvas is
    indistinguishable, which the md5 above already proved.
  - **Full field, 19 cars** (`monza_full_field.json`, clock 2:00.000, focus VER): the
    trace sits under a 19-row tower and reads the approach, plateau and brake into the
    corner VER is in. `docs/screenshots/slice-9e-full-field-19-cars.jpg`.
- **Sustained fps: measured by the HUMAN, because it could not be measured here.** The
  MCP browser tab reports `visibilityState: "hidden"`, where rAF is throttled and
  `fps-probe.js` refuses to start by design — the same split Slices 7, 9c and 12
  recorded. `monza_full_field.json` (19 cars), foregrounded, 600 frames over 5.0 s:

  | | 9c baseline | 9e |
  |---|---|---|
  | fps | 119.8 | **120** |
  | callback mean | 1.13 ms | **0.87 ms** |
  | callback p95 / p99 | 2.6 / 2.8 ms | **3.1 / 3.5 ms** |
  | max | 4.3 ms | **3.7 ms** |
  | frames > 20 ms of 600 | 0 | **0** |

  - **The tails went UP and it is recorded as measured, not rounded to "no regression":**
    p95 +0.5 ms, p99 +0.7 ms. That is exactly where a ≤30 Hz cost must land — at 120 fps
    only about one frame in four carries a HUD render, so the trace can only ever show in
    the top quartile, never in the mean. The prediction Slice 12 wrote for 9e ("lands in
    callback p95/p99 and in no canvas call count") is confirmed in both halves.
  - **The mean improving is NOT claimed as a win.** 1.13 → 0.87 ms is not attributable to
    anything in this diff — the removed `x`/`y` signature terms are ~30 string concats
    per emit — and is more likely machine state between runs. Recorded because it was
    measured, not because it means something.
  - **The two instruments together locate the cost, which is the payoff for having both.**
    `hud-tick.mjs` puts the pure-JS window build at **22 µs**; the browser tail moved
    ~**0.6 ms**, ~27× that. The difference is the React render and the DOM update of a
    200-point `d` attribute — precisely the half `hud-tick.mjs`'s header says it does not
    measure. **The trace's cost is dominated by React, not by the geometry**, which is
    where anyone optimising it later should start.
  - Against the ≥50 fps bar's 20 ms budget the worst frame observed is **3.7 ms — 18%**,
    and nothing came within a factor of five of a drop.
- **Human acceptance (2026-08-08): PASS.** On `monza_endgame.json` the trace is readable
  nine minutes in; the playhead is correct in **both** regimes — sweeping during the
  fill-in while the clock is younger than the window, pinned and scrolling in steady
  state — a scrub jumps it instantly, and closed mode reads consistently with the 4b
  trail rules. **`TRACE_SECONDS` stays at 20.**
  - Recorded because the sequence matters: an earlier pass reported the playhead as
    "unpinned". That was the **fill-in phase working as designed**, not a defect. The
    two regimes are one clamp and look different on purpose, so the next person to watch
    the first twenty seconds of a replay does not file it again.

## Maintenance (not phase-bound — schedule after the slices above)

### [x] Slice 10 — Toolchain: Vite 8 + vitest 4 migration
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

**The governing principle, and it is different from every feature slice: the suite is
the JUDGE, not the patient.** 440 tests, the `perFile` coverage ratchet, the golden
pipeline contract and Slice 9b's md5'd draw-call baseline exist in exactly the state
that makes a toolchain swap verifiable. So `app/src/**` and `pipeline/**` do not
change; config files are the entire migration surface. **They did not change** —
`git diff --stat -- app/src pipeline` is empty, and no breaking change in either major
forced a source edit.

- **Amendment (this slice) — PR #9 did NOT fail on Vite config, and the spec's
  "expect config work, not a version bump" was aimed at the wrong thing.** Read out of
  `gh run view 30201430595 --log-failed`, `verify` failed in **13 seconds** at `npm ci`,
  before a Vite config line was ever parsed:
  `ERESOLVE … peer vite@"^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0" from
  @vitejs/plugin-react@4.7.0 / Found: vite@8.1.5`. Vercel runs the same install in
  `app/` and died the same way. **PR #9 was Dependabot bumping `vite` alone** — the
  exact interlock violation this slice's first decision names. Zero Vite-8 config
  changes proved necessary: no `build.rollupOptions`, no `esbuild` block, no
  `manualChunks`, nothing to migrate to `rolldownOptions`.
- **Amendment (this slice) — the interlock is FIVE packages, not four. The fifth fails
  SILENTLY, which is why it is worth recording.** `vite-node` (`npm run validate:replay`)
  was not in the spec's list. `vitest@4` no longer depends on it, and `vite-node@2`
  depends on `vite@^5` as a **regular dependency, not a peer** — so it raises no
  ERESOLVE and instead installs a **nested second copy of vite@5**, running the schema
  validator on a different Vite from the app and keeping the vite@5 advisories alive
  under a green build. Bumped to `vite-node@6` (deps `vite@^8`), and the check that
  catches this class of defect is now written down: after install, `npm ls vite --all`
  must show **exactly one** Vite, with every consumer `deduped`.
  - Also: **`@vitejs/plugin-react` needs `^5.2.0`, not `^5`.** 5.1.4 and below cap at
    `vite@^7`; **5.2.0 is the first v5 whose peers include `^8.0.0`**. The spec's "4→5"
    is right but the floor is load-bearing. v6 stays deferred as the spec says (its
    peer is `vite: ^8.0.0` exactly and it moves the transform path; 5.2.0 is the
    minimal delta that already supports Vite 8).
- **Amendment (this slice) — one atomic bump, because the peer graph permits no clean
  intermediate.** Not a preference, and argued rather than assumed:
  - **vitest first is impossible** — `vitest@4` peers `vite >= 6`.
  - **vite 5→7 first** installs against `plugin-react@4`, but `vitest@2`'s
    `@vitest/mocker` and `vite-node@2` both depend on `vite@^5` directly, so that
    intermediate silently carries two Vites and its `npm audit` is unreadable.
  - **vite alone → 8** is precisely PR #9.

  So the bump is atomic and the **verification** is what gets staged: install →
  one-Vite check → typecheck → lint → format → tests WITHOUT coverage → tests WITH
  coverage → build → full `check`. Splitting the two test runs matters: it is what
  keeps a coverage-gate failure from being misread as a test failure.
- **Amendment (this slice) — the coverage gate survived a provider REWRITE, and it was
  proved two-sided because one-sided would not have proved it.** This was the slice's
  most dangerous failure mode, and it was a real risk rather than a ceremonial one:
  vitest 4 removes `coverage.all`/`coverage.extensions`, and **`@vitest/coverage-v8@4`
  drops the `test-exclude` dependency that implemented them** (visible in the lockfile
  diff). File selection is different code.
  - **Positive probe:** an uncovered `src/engine/__probe__.ts` → **exit 1**, naming the
    file, the glob key and all three metrics at 0%.
  - **Negative probe:** the same uncovered file with the threshold key pointed at
    `src/nowhere/**` → **exit 0**. This is what proves the `"src/engine/**"` key is
    doing the work, rather than a global threshold coincidentally covering an
    engine-only `coverage.include`. A positive probe alone cannot tell those apart.
  - Per-file numbers are **unmoved**: 12 engine modules, 100% lines/branches/functions
    each.
  - **A finding that looks like a defect and is not:** with every engine file at 100%,
    v4's `text` reporter prints an **empty table**. It omits fully-covered files, so
    `__probe__.ts` appeared the instant it was not 100%. An empty table now MEANS
    everything is at 100% — worth knowing before someone reads it as lost measurement.
  - `vite.config.ts`'s comment claimed "`coverage.all` defaults to true, so an untested
    module IS measured". That is now false, and `coverage.include` is what does it; the
    comment was rewritten rather than left to rot.
- **Amendment (this slice) — `engines.node: "22.x"`, config-as-code over a dashboard
  setting.** The ERESOLVE diagnosis clears Node of PR #9's failure entirely, so this
  is not a fix for a measured defect. It is taken because Vite 8's
  `^20.19.0 || >=22.12.0` is a **new constraint the repo now carries**, and Vercel's
  Node version was an unwritten out-of-repo setting — the class of thing this project
  converts to config-as-code on principle. It agrees with CI's existing
  `node-version: "22"`. No `.nvmrc`: nothing reads it (setup-node is given a literal
  `"22"`), and one pin machines honour beats two, one decorative.
  - **Consequence, recorded so it is not mistaken for a defect:** on a machine running
    another major, `npm install` prints one advisory `EBADENGINE` warning. It is
    advisory only — no `.npmrc`, `engine-strict` false — and `npm run check` does not
    run install, so the zero-warnings gate is untouched.
- **Amendment (this slice) — the audit residual I predicted DID NOT EXIST, and the
  spec's original claim was right.** Recorded as a correction of the working note
  rather than deleted, because the error was a method error worth not repeating. In
  planning I traced `eslint@9 → minimatch@3 → brace-expansion@1.1.15` and concluded
  the advisory could only be cleared by an eslint major, having read the published
  version list through `tail -c 200` — which cut off every 1.x entry. **`1.1.18`
  exists and is the 1.x fix.** A truncated view is not evidence about what is not in
  the list; this is the same discipline as grepping a full gate log instead of its
  tail. No eslint slice was filed, because no advisory drives one.
  - The clearing is in two parts, both lockfile-only: the bump removes `esbuild`,
    `rollup`, `test-exclude` and their brace-expansion copies; `npm audit fix` then
    moves the two remaining eslint-side copies (`1.1.15 → 1.1.18`,
    `5.0.8 → 5.0.9`), changing **2 packages and nothing else**. `npm install` alone
    does not do this — it will not upgrade an already-satisfied transitive.
- **Verified (2026-08-04):**
  - **Zero source diffs.** `git diff --stat -- app/src pipeline` empty. The migration
    is `package.json`, `package-lock.json`, `vite.config.ts` (comments only) and docs.
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full
    log = 0): **440 tests**, engine coverage **100%** lines/branches/functions per file,
    `vite v8.2.0` building 137 modules in 402 ms.
  - `pytest` green, untouched: **149 tests**, `replay_transform.py` 100% lines+branches.
  - `validate:replay` green on all three goldens **through `vite-node@6`**, and still
    exit-1 with the named path (`→ at cars[0].samples[3].speed`) on a broken file.
  - **The draw-call baseline is byte-identical across the bundler swap** — captured on
    the UNMODIFIED vite5/vitest2 tree before any file was touched, then re-captured
    through the same harness afterwards, as 9b did it:

    | mode | before | after | calls | Path2D |
    |---|---|---|---|---|
    | closed | `a4e64c6d…63f8` | **`a4e64c6d…63f8`** | 79,213 | 19 |
    | open (comet) | `67bf212b…4238` | **`67bf212b…4238`** | 107,010 | 1 |

    701 frames at 100 ms over the 58.5 s fixture, so a full lap wrap is inside it.
    Closed mode's **79,213 calls and 19 `Path2D` builds reproduce Slice 9b's recorded
    figures exactly**, so this is the same capture 9b made under a different digest
    recipe — 9b's harness was never committed, so its md5 literal is not comparable and
    is not claimed. **Slice 9b's comet is under the diff too**, which 9b's own capture
    was not. What this proves: the loop's output survived Oxc replacing esbuild in the
    transform path. What it does not: the production Rolldown bundle — that is the
    preview build's job.
  - **`npm audit`: 7 → 0.** No residual, dev-only or otherwise.
  - **Lockfile reviewed, not accepted: 423 → 370 packages.** `esbuild` (25 entries) and
    `rollup` (27) removed outright for `rolldown` (16) + `lightningcss` (13) + oxc
    types — the bundler swap, legible in the lockfile. `test-exclude` and its
    minimatch/brace-expansion copies gone, confirming the coverage finding above.
    **No production dependency moved**: react, react-dom, zod and zustand are absent
    from the added, removed and changed lists alike.

### [x] Slice 11 — Make the pipeline's colour fallback honest

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

- **Amendment (this slice) — the neutral is `#888888`, and ACHROMATIC is the property,
  not the hex.** Two bars had to clear at once and they exclude different things:
  - **Not a livery.** Every F1 team colour is a saturated hue and no current livery
    occupies mid-grey (silver and white are high-value, near-white). So the constant's
    invariant is `r == g == b`, and that is what the test asserts alongside the literal
    — a "neutral-ish" brand hex cannot slip in under a passing equality.
  - **Not a DELIBERATE CHOICE either**, which is what rules out the loud alternatives.
    A magenta is unmistakably not a livery, but sat on a dark canvas beside three team
    colours it reads as *selected*. A desaturated mid grey is what every UI already
    means by "no value" — and it is the one thing the old value could never be, since
    a failed lookup that renders as a plausible Red Bull lap is invisible by
    construction.
- **Amendment (this slice) — the warning is ruled IN, loud, and names the driver. The
  volume moved; the handling did not.** A colour is still not worth failing a fetch
  over, so the `except` stays broad and stays non-fatal — the same shape as Slice 7's
  closing-time tripwire. What changed is the conditions, and that is the whole argument:
  - Before PR #31 the path fired on **every single run**. A banner there would have
    been pure noise and the quiet one-liner was correct **for those conditions**.
  - It should now never fire. If it does it is NEW — FastF1 moved its API again (the
    defect PR #31 fixed, returning) or a team is missing from the colour map — and both
    silently paint every car in the file grey. A never-exercised path firing is news.
  - It prints into the middle of FastF1's own INFO log, so it joins the house
    `\nWARNING: …\n` format already used by the motion-fidelity, file-size and
    closing-time tripwires. The exception **type** is reported next to its message,
    because `AttributeError` and `KeyError` are those two diagnoses and they have
    different fixes.
  - **`color_lookup_warning` lives in `replay_transform.py`, not next to the `except`**
    that calls it, for the reason Slice 8 recorded when it moved `parse_lap_range`:
    `build_replay.py` imports FastF1, which CI does not install, so nothing in it can
    be tested — and a warning whose text is wrong is itself a quiet failure. Both call
    sites (`build_lap_replay`, `_team_and_color`) now print the same line; the lap one
    did not name the driver before.
- **Amendment (this slice) — the golden ratchet DID NOT FIRE, checked rather than
  assumed.** All three goldens are generated from `tests/synthetic.py`, which passes
  **explicit** colours (`META`/`META_NO_DRS` carry `#3671C6`; `TEAMS` carries three
  literals), so the fallback branch is never taken on the golden path.
  `regenerate_golden.py` rewrote all three files and `git diff` came back **empty** —
  byte-identical, which also confirms the canonical `dump_json` path is untouched.
  `synthetic.py` deliberately keeps `#3671C6` as its explicit colour: changing it would
  churn three goldens for nothing, and keeping it is what turns
  `test_build_replay_dict_always_emits_cars_as_an_array`'s colour assertion into a
  genuine **pass-through** check.
- **Amendment (this slice) — `test_normalise_color` re-read, and one row changed
  MEANING.** The parameterisation stays valid (invalid inputs still expect
  `DEFAULT_COLOR`, whatever it is), but `(0x3671C6, DEFAULT_COLOR)` was **ambiguous**
  while the fallback was itself `#3671C6`: it passed both if the fallback fired and if
  `normalise_color` had coerced the int to that hex string. It now discriminates the
  two, and tests what its comment always claimed. The same latent ambiguity sat in the
  emitted-colour assertion above. Both are annotated in place rather than rewritten —
  the rows were never wrong, they were unfalsifiable.
- **Verified (2026-08-08):**
  - `pytest` green: **153 tests** (149 + 4), `replay_transform.py` still **100% lines +
    branches**. The four are the achromatic pin, the warning's content, and the fallback
    exercised end-to-end on both builders — the window one asserting one car grey while
    its two neighbours keep their liveries, because grey only reads as "no data" when
    there is a real colour beside it.
  - `npm run check` green with **0 warnings** (`grep -ciE 'warn|error'` over the full
    log = 0): 502 tests, engine coverage 100%. The app is untouched this slice.
  - **A colour that RESOLVES still resolves — 2024 Monza Q LEC, rebuilt from the warm
    cache** (deliberately not VER): `color` = **`#e8002d`**, team `Ferrari`, no warning
    printed, `validate:replay` green. Against the pre-slice `monza_lec.json` the only
    field that differs anywhere in the file is `meta.loop` — added by Slice 8 — with all
    795 samples and every other `meta` field identical.
  - **A colour that FAILS now looks failed.** With `fastf1.plotting.get_team_color`
    forced to raise (a throwaway harness, not committed — the committed form is the
    pytest pair above), the same real lap emits `#888888` with an empty team, and prints
    `WARNING: LEC: team colour lookup failed (AttributeError: …); falling back to
    #888888, which is not a livery.` — legible against FastF1's log rather than lost in
    it. A 3-car race window with **only NOR's** lookup failing exercised the other call
    site: `#0600ef` / `#e8002d` / `#888888`, one warning naming NOR, motion fidelity
    unchanged at r = 0.9998–0.9999.
  - **Rendered in the browser**, which is where the claim actually lives: in that
    3-car window NOR's marker and HUD tower chip are plainly undecorated grey beside
    VER's blue and LEC's red — it reads as missing data, not as a team and not as a
    highlight. The old value could not have produced that image.

### [x] Slice 12 — Measure the 20-car frame budget — **answered at 19 cars**

**Filed by Slice 9 rather than claimed by it.** PRD/PLAN's bar is **≥50fps with 20 cars
on a mid-tier laptop**; Slice 9 shipped the presentation with three and measured 120fps
(600 frames in 5.00 s, 120 Hz display, no drops). Three cars do not test the bar, so it
is open.

- **Needs a 20-car file first**, which is a pipeline run, not a code change:
  `--drivers <20 codes> --laps A-B`. Note Slice 8's arithmetic — a 3-lap × 3-car window
  is 1.6 MB, so 20 cars over 3 laps is ~11 MB through a file picker. Consider a shorter
  window, and measure the LOAD as well as the frame rate.
- **What the cost structure predicts**, so the measurement has something to falsify:
  per frame it is 1 full trail (≤1 appended segment + 9 bucket strokes) + 19 tails × 4
  banded strokes + 20 markers ≈ **80 tail strokes** against today's 9, all independent
  of window length. Gaps are NOT on the frame path — they are computed in the HUD at
  ≤30 Hz, 20 × O(1) grid queries plus an O(N²) hysteretic sort with N ≤ 20.
- **Suspect first if it misses:** the 20 shadow-blurred markers (only the focused car
  has a glow, deliberately), then the tail stroke count — `TAIL_BANDS` is the dial, and
  dropping it to 2 halves the strokes for a fade nobody is looking at on an unfocused
  car.
- **Verify:** a visibility-gated rAF counter in a VISIBLE tab (a hidden tab throttles
  rAF to nothing and measures zero), on the production build via `vite preview`, over
  ≥5 s of playback. Record frames/seconds, not a smoothed figure.
- Backlog's "WebGL/3D escalation **only** if measured 20-car perf demands it" is
  downstream of this measurement — it is the thing that would authorise it.

- **Taken out of order, ahead of 9c/9d/9e, and that is the point.** This is a BASELINE:
  9c adds comet buckets and 9e adds a scrolling trace, both specified as bounded, and
  re-running the same instrument after them is what turns "bounded" into a before/after
  rather than a claim. Measuring afterwards would leave nothing to compare against.

- **Amendment (this slice) — the verdict is 19 cars, not 20, and it is written that way
  everywhere.** `monza_full_field.json` (the human's disk, gitignored) holds **19** cars,
  not 20: it is 2024 Monza R over VER laps 20-22 and the twentieth seat DNF'd out of the
  window. The bar as written therefore cannot be met by measurement on this file, and
  **"20-car bar met" is not claimed anywhere in this entry.** What is established instead
  is 19 measured cars plus a marginal cost for the twentieth that is bounded rather than
  assumed — see the exact-linearity result below, which is what licenses the bound.

- **Amendment (this slice) — the instrument is committed, as `docs/perf/fps-probe.js`.**
  The only code this slice ships. Argued rather than defaulted:
  - **Not in `app/`.** It can never run in CI — it needs a visible browser tab and a
    gitignored multi-megabyte data file — so it must not sit anywhere `npm run check`,
    `eslint .` or `format:check` would adopt it and then have to be told to skip it.
    `docs/` is outside all three, and the probe touches no app symbol, so it cannot rot
    from code drift either.
  - **Not the scratchpad, which is the actual change of practice.** Slices 9b and 10 both
    left their draw-call harness uncommitted and recorded only its parameters, and **9c's
    spec now has to rebuild that harness from prose** — the re-derivation this slice
    exists to remove. The subset-derivation snippet is in its header for the same reason.
    - **Closed by Slice 9c (2026-08-07):** it rebuilt that harness one last time and
      committed it as `docs/perf/drawcall-capture.mjs`, where it reproduces this slice's
      and Slice 10's figures exactly. The gap this paragraph names no longer exists.
  - It carries its own procedure, and its own **limits**, in the header: what each metric
    excludes is written next to the metric, not left for a reader to infer.

- **Amendment (this slice) — the approved instrument was HALF-BLIND, and re-designing it
  mid-slice is what produced the linearity result.** The plan fitted the car-count slope
  on callback time. Run, that turned out to be under **1 ms of an 8.3 ms budget**, i.e.
  inside `performance.now()`'s 100 µs quantisation, and the resulting curve is
  **sub-linear with ±0.07 ms residuals on a 0.8 ms signal** — a fit too soft to exclude
  anything, and reporting a slope from it would have been reporting noise.
  - So the instrument gained `countDraws()`: exact integer counts of the
    `CanvasRenderingContext2D` calls `drawFrame` makes, per frame. Draw calls have no
    measurement floor, and an O(N²) term in the render path lands in them immediately.
  - The result is not approximately linear, it is **exactly** linear (below). The timing
    was never going to show that at this scale, and a two-point fps check — the shape the
    spec started from — could not have shown it at all.
- **Amendment (this slice) — `countDraws` also settles the ordering assumption the
  timing rests on.** `performance.now() − rafTimestamp` is only the app's cost if the
  app's callback ran first in that frame. `drawFrame` calls `clearRect` first, so the
  patch timestamps it: the probe's callback started **0.2–0.3 ms after** the app's on
  every frame of every run, never before. Measured, not argued from registration order.

- **Amendment (this slice) — the load probe's first version measured the idle gap and
  reported it as the load.** Found by disbelieving the number, which is the only reason
  it was found: a 3.5 MB file "loaded in 35 ms" — about four frames. `ReplayFilePicker`'s
  handler is **async** (`await loadReplayFile(file)` → `file.text()`), so the frames
  straight after `change` are idle and a quiet-frame detector resolves in the gap
  **before** the parse starts. Fixed by waiting for the picker to report the new filename
  first. The corrected figures are ~5.4 ms/MB and are independently corroborated: at
  19 cars the browser's own `longtask` observer reports a **53 ms** task against a
  measured `changeToLoadedMs` of **53.8 ms**, two instruments agreeing.

- **Amendment (this slice) — the cost prediction in this entry was written before Slice
  9b and was wrong about the mechanism.** Corrected rather than left to mislead the next
  reader: the full-field file is `loop: "open"`, so the focused car's painter is
  `CometPainter`, **not** `TrailPainter` — there is no retained trail and no appended
  segment. And `TAIL_SECONDS` moved 1.5 → 0.5 on 2026-08-05, so an unfocused tail spans
  5 segments, not 15. The prediction's stroke arithmetic survives (bands, not segments,
  set the stroke count); its `lineTo` count was ~3× too high. Measured structure below.

- **Verified (2026-08-05), `vite preview` on the production build, visible tab, 120 Hz
  display, canvas 1176×657 CSS px at dpr 2. Every run is 600 frames, unsmoothed.**

  **The verdict.** **19 real cars sustain 120 fps** — the display's full refresh rate,
  **0 frames over 20 ms and 0 over 33 ms** in 600 — **against the ≥50fps bar**. The
  20th car's marginal cost is bounded by **exactly 28 draw calls per car**, measured, so
  the twentieth adds **+4.1%** to the frame's canvas work (680 → 708 calls). **The file
  holds 19 because the 20th seat DNF'd out of the window; the 20-car bar is not claimed.**

  | cars | speed | fps | int p50 | int p95 | int p99 | cb mean | cb p95 | cb p99 | >20ms |
  |---|---|---|---|---|---|---|---|---|---|
  | 1 | 1× | 120 | 8.3 | 9.2 | 9.3 | 0.670 | 1.3 | 1.5 | 0 |
  | 1 | 4× | 120 | 8.3 | 9.3 | 9.4 | 0.671 | 1.4 | 1.6 | 0 |
  | 3 | 1× | 120 | 8.3 | 9.2 | 9.4 | 0.718 | 1.4 | 1.8 | 0 |
  | 3 | 4× | 120 | 8.3 | 9.2 | 9.3 | 0.693 | 1.4 | 1.8 | 0 |
  | 7 | 1× | 120 | 8.3 | 9.1 | 9.3 | 0.872 | 1.7 | 2.1 | 0 |
  | 7 | 4× | 120 | 8.3 | 9.3 | 9.4 | 0.870 | 1.8 | 2.4 | 0 |
  | 13 | 1× | 120 | 8.3 | 9.2 | 9.3 | 0.956 | 2.0 | 2.3 | 0 |
  | 13 | 4× | 120 | 8.3 | 9.0 | 9.3 | 0.938 | 2.1 | 2.7 | 0 |
  | **19** | **1×** | **120** | 8.3 | 9.3 | 9.4 | **0.967** | 2.1 | 2.5 | **0** |
  | **19** | **4×** | **120** | 8.3 | 9.1 | 9.3 | **0.961** | 2.2 | 2.7 | **0** |

  Times in ms. `int` = rAF interval; `cb` = the app's per-frame callback, `drawFrame`
  plus the `telemetry.publish` that synchronously renders the HUD.

  - **fps is CLAMPED and says so.** 120 is the display, not a ceiling the app found:
    `int p50` is 8.3 ms at every car count, and even `int p99` (9.4 ms) is 106 fps. This
    is why the linearity check is not run on fps — both ends of the sweep sit on the
    same ceiling. It is still the metric the ≥50fps bar is written against, and it clears
    it by **2.4×** with no dropped frames.

- **The car-count sweep varied car count and NOTHING else**, and the derivation is
  checked rather than asserted. Subsets `cars[:N]` are sliced off the one full-field
  file, so every point shares a window, a duration and `cars[0]` — hence the same ribbon,
  bounds, fit and corner chrome. The **N=19 subset is md5-identical** to
  `monza_full_field.json` (`95bad63f…`) and the **N=3 subset structurally equal** to the
  shipped `monza_race.json`. The series is the real files with cars removed.
  - The 3-car point deliberately is NOT `monza_endgame.json`, which would have confounded
    car count with window length. That file is used as a separate control instead.

- **PER-FRAME CANVAS WORK IS EXACTLY LINEAR IN CARS — `total = 148 + 28·N`, residuals at
  floating-point zero.** This is the result the slice exists for.

  | cars | total | beginPath | moveTo | lineTo | arc | stroke | fill | fillText |
  |---|---|---|---|---|---|---|---|---|
  | 1 | 176 | 34 | 34 | 34 | 13 | 34 | 13 | 12 |
  | 3 | 232 | 48 | 44 | 48 | 17 | 44 | 17 | 12 |
  | 7 | 344 | 76 | 64 | 76 | 25 | 64 | 25 | 12 |
  | 13 | 512 | 118 | 94 | 118 | 37 | 94 | 37 | 12 |
  | 19 | 680 | 160 | 124 | 160 | 49 | 124 | 49 | 12 |

  Successive per-car slopes are **28.0, 28.0, 28.0, 28.0** — not a fit, the same integer
  four times. **There is no O(N²) term anywhere on the frame path**, so the hypothesis
  this measurement was designed to expose is refuted rather than assumed away.
  - **Every column matches the code, which is what makes it a confirmed model rather
    than a curve.** Per added (unfocused) car: `TailPainter` = 4 `beginPath` + 4 `moveTo`
    + 6 `lineTo` + 4 `stroke` = 18, and `drawUnfocusedCar` = 3 `beginPath` + 2 `arc` +
    2 `fill` + 1 `moveTo` + 1 `lineTo` + 1 `stroke` = 10. **18 + 10 = 28**, and the
    per-column slopes (7, 5, 7, 2, 5, 2, 0) are each exactly what those two functions
    add. `fillText` is flat at 12 — 11 corner numbers and `S/F`, which no car touches.
  - The constant 148 is the chrome plus the focused car: ribbon, 11 corner badges, S/F,
    the focused marker, and the comet's ~58 calls.
  - **Extrapolating the 20th car is therefore arithmetic, not optimism:** +28 calls,
    680 → 708, +4.1%, and the same +28 for the 21st.

- **Callback time is SUB-linear, and the honest reading is that it is near the floor.**
  Slope 0.0171 ms/car with residuals of ±0.063 ms on a ~0.8 ms signal, and successive
  per-car slopes **declining** (0.024 → 0.039 → 0.014 → 0.002). Recorded as a bound, not
  a law: the timing never rises faster than the exactly-linear draw-call count, and at
  these magnitudes the fixed per-frame costs dominate. **The linearity claim rests on the
  draw calls; the timing only has to not contradict it, and it does not.**

- **HEADROOM, which is the number that transfers off this machine.** At 19 cars the app
  uses **0.967 ms of the 8.33 ms** frame budget — **11.6%**. Against the bar's 20 ms
  budget it is **4.8%**, so hardware **~20× slower** than this one would still hold
  50 fps on the main thread. Stated with its limit: callback cost excludes GPU paint and
  composite, so that multiple bounds the main-thread side only, and this is a 120 Hz
  machine that is better than the bar's "mid-tier laptop".

- **Playback rate is free, as predicted, and the prediction was falsifiable.** In an open
  window the comet and the tails span a fixed number of SAMPLES, so 4× should cost the
  same per frame as 1×. Measured difference in callback mean across all five car counts:
  **+0.001, −0.025, −0.002, −0.018, −0.006 ms** — zero within noise, at every N.

- **Slice 9b's "cost is independent of window length" is now MEASURED.**
  `monza_endgame.json` (3 cars, 5792 samples, **2.22×** the sweep's window) draws
  **exactly 232 calls per frame, method for method identical** to the 3-car point of the
  sweep — 48/44/48/17/44/17/12. 120 fps, callback mean 0.778 ms (1×) / 0.747 ms (4×).

- **Load cost, ~5.4 ms/MB, and it is not the bottleneck anyone feared.** Slice 12's spec
  worried about "~11 MB through a file picker" and suggested a shorter window; measured,
  the 9.99 MB 19-car file parses, validates through the full Zod schema and commits in
  **54 ms**, settling at 92 ms. No shorter window is needed.

  | file | MB | cars | change→loaded | →main thread quiet | longtask |
  |---|---|---|---|---|---|
  | field_01 | 0.53 | 1 | 9.8 ms | 26.4 | — |
  | field_03 | 1.58 | 3 | 26.6 ms | 43.4 | — |
  | field_07 | 3.68 | 7 | 33.0 ms | 49.7 | — |
  | field_13 | 6.83 | 13 | 44.5 ms | 61.2 | — |
  | **field_19** | **9.99** | **19** | **53.8 ms** | 78.8 | **53 ms** |

  A later reload of the same 19-car file read 66.9 ms / 91.9 ms with a 67 ms longtask, so
  treat this as ~55-70 ms rather than a single figure.

- **NO FIXES SHIPPED, and none are indicated.** The spec's two named suspects were the 19
  shadow-blurred markers and the tail stroke count, with `TAIL_BANDS` as the dial. Neither
  is touched: only the focused car has a glow (`drawUnfocusedCar` sets no `shadowBlur`,
  visible in the call counts), and at 4.8% of the bar's budget there is nothing to tune.
  **`TAIL_BANDS` stays at 4.** Backlog's WebGL/3D escalation is **NOT authorised** — this
  measurement is the thing that would have authorised it, and it declines to.

- **What 9c and 9e inherit as their before/after.** Re-run
  `docs/perf/fps-probe.js` unchanged and compare against **19 cars: 680 calls/frame,
  148 + 28·N, callback mean 0.967 ms, 120 fps, 0 frames > 20 ms**.
  - **9c** re-buckets the comet from 9 to ~32. The comet is inside the constant term
    (~58 calls), not the per-car slope, and 9c's own spec argues its stroke bound is
    the segment count (≤21) either way — so `total` should move by a **single-digit
    constant** and `28·N` must not move at all. If the per-car slope moves, 9c has
    touched the tails.
  - **9e** replaces the whole-window sparkline with a bounded scrolling trace. That is
    HUD work inside `telemetry.publish` at ≤30 Hz, so it lands in **callback p95/p99**
    (2.1 / 2.5 ms today) and in **no canvas call count** — the trace is its own element.
    Its "bounded cost, independent of window length" claim is testable exactly as 9b's
    was above: compare the 3-car sweep point against `monza_endgame.json`.

- **Noted, out of scope, and visible in this slice's own evidence:** the 19-car
  screenshot shows the tower reading RIC −40.159 / COL −35.270 / HUL −33.342 above a
  focused VER, with LEC, NOR and PIA on em dashes. That is **Slice 9d's wrap defect**,
  filed and unfixed, caught here incidentally rather than re-diagnosed. It costs the
  frame path nothing and does not affect any number above.
  Screenshot: `docs/screenshots/slice-12-full-field-19-cars.jpg`.

- **Addendum (2026-08-05) — the GAP path was measured too, because a later brief
  asserted a cost for it. The assertion did not survive, and it is recorded here so the
  numbers do not propagate into a slice as inherited fact.** A brief for Slice 9d
  carried "~0.72 ms per car per frame of a `nearestOnPath` scan, p99-owning at field
  density, 12.4 ms of a 16.7 ms budget at 19 cars, one long frame from the bar". Every
  clause of it is false, and each in a different way:
  - **There is no `nearestOnPath`** anywhere in `app`, `pipeline`, `docs` or the three
    law files. `gapTo` has been **O(1) since Slice 9**: `buildPathIndex` builds a uniform
    spatial hash once and `candidatesNear` reads a 3×3 cell neighbourhood, so there is no
    per-frame scan to eliminate. The optimisation had nothing to optimise.
  - **Measured through the shipped modules** (`parseReplay` → `buildPathIndex` → `gapTo`)
    on `monza_full_field.json`, 19 cars × 2607 samples, 2000 ticks at the HUD's own
    cadence, JIT warmed: **1.8 µs per car per tick**, and a whole 19-car tick is
    **0.033 ms mean / 0.049 ms p99**. That is **~400×** and **~250×** below the asserted
    figures.
  - **It is not on the frame path at all**, which `Hud.tsx`'s header already said in
    prose: gaps derive from the telemetry snapshot at ≤30 Hz. At that cadence the entire
    19-car gap workload is **~1 ms per second** of wall time.
  - **The budget was wrong too.** This slice measured on a **120 Hz** display — an
    **8.33 ms** frame, not 16.7 — and recorded 19-car callback **p99 2.5 ms** with **0
    frames over 20 ms**. Neither 12.4 nor 0.72 nor 16.7 appears anywhere above.
  - **The one real cost is `buildPathIndex` at 1.38 ms**, paid once per
    `[replay, focusedCarIndex]` through `useMemo` — so cycling focus across a full field
    pays it nineteen times, still off the frame path. Small, and not worth a slice.
  - **Consequence, taken on this evidence:** 9d's projection-cursor optimisation is
    **dropped**. The cross-frame state that mandate needed is spent on identifying
    **lapped cars** instead — a payoff that exists — and 9d's frame-rate acceptance
    becomes a **no-regression check against the baseline above** via the `fps-probe.js`
    protocol, not a 12.4 → lower claim, because 12.4 was never a measurement.
  - **The method note, which is the part worth repeating.** These figures were not
    disprovable from this slice's own harness: `docs/perf/fps-probe.js` measures the
    FRAME path, and gaps are not in it. Refuting them took a separate Node benchmark
    against the real file through the real modules. **A 30 Hz cadence needs its own
    instrument; the frame harness neither covers it nor contradicts it.**

## Backlog (ideas — not committed)
- WebGL/3D escalation **only** if measured 20-car perf demands it (documented path).
- Track-surface niceties: kerbs, sector coloring, mini-map.
- Ghost/delta vs a reference lap; multi-lap stints.
- Per-team color tokens sourced from FastF1 plotting.
- Shareable deep-links (session + driver in URL).
- Pipeline: cache warming + a committed "golden" small real fixture for visual tests.
