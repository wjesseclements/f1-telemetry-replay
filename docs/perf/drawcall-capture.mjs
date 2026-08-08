/**
 * drawcall-capture.mjs — the do-no-harm instrument: a byte-exact capture of every
 * canvas call `drawFrame` makes over a fixed run, reduced to one md5.
 *
 * WHY THIS IS COMMITTED
 * ---------------------
 * Slices 9b and 10 both built this harness, used it, and threw it away, recording only
 * its parameters in prose — and Slice 9c then had to rebuild it from that prose a third
 * time. Slice 12 committed `fps-probe.js` for exactly this reason and named the
 * re-derivation it wanted removed; this closes that gap. Like the fps probe it lives
 * OUTSIDE `app/`, so `npm run check`, `eslint .` and `format:check` never adopt it: it
 * is an instrument, not app code, and it can never run in CI.
 *
 * WHAT IT IS FOR
 * --------------
 * A render change that is supposed to leave one mode untouched has to prove it, and an
 * assertion written after the fact proves nothing. The protocol is the ordering:
 *
 *   1. capture BOTH modes on UNMODIFIED code, before a single file is touched;
 *   2. make the change;
 *   3. re-capture through THIS SAME script and diff the digests.
 *
 * A mode that must not move has an identical md5. A mode that is expected to move has a
 * different one, and the per-method call counts printed alongside say by how much.
 *
 * USAGE (from `app/`, which is where the toolchain lives — CLAUDE.md's Gotchas)
 * ---------------------------------------------------------------------------
 *   cd app && npx vite-node ../docs/perf/drawcall-capture.mjs closed
 *   cd app && npx vite-node ../docs/perf/drawcall-capture.mjs open
 *
 * `vite-node` (not `node`) because this imports the app's real TypeScript modules with
 * the app's own resolution — the point is to measure the shipped code, not a copy.
 *
 * A real file, and the first N of its cars, for the car-count sweep:
 *
 *   cd app && npx vite-node ../docs/perf/drawcall-capture.mjs \
 *       auto public/data/monza_full_field.json 19
 *
 * `auto` takes the mode from the file's own `meta.loop`. The mean per-frame call count
 * it prints is directly comparable to the per-frame table `fps-probe.js` produces in a
 * browser, and that is the point of having it here: **the draw-call half of a
 * frame-budget check does not need a browser.** It is integer-exact and independent of
 * tab visibility, where `fps-probe.js` needs a foreground window and measures zero
 * without one. What it still cannot tell you is whether frames were DROPPED — that is
 * `fps-probe.js`'s half, and nothing here substitutes for it.
 *
 * Only the fixture mode prints an md5 worth diffing: a gitignored real file is not a
 * regression fixture anyone else can reproduce.
 *
 * PARAMETERS, fixed so two runs are comparable (Slice 10's, reproduced)
 * --------------------------------------------------------------------
 *  - the committed fixture `app/src/engine/__fixtures__/sample-lap.json`: 1 car, 585
 *    samples at 10 Hz, 58.5 s, 9 corners. Never a gitignored real file, so anyone can
 *    reproduce a digest.
 *  - **701 frames at 100 ms**, playing at 1x from clock 0 — 70.0 s over a 58.5 s lap, so
 *    a full wrap is inside the run and the closed-mode trail's rebuild is captured.
 *  - viewport 1176x657 CSS px at dpr 2 (the canvas Slice 12 measured on).
 *  - focus on car 0, the store's default.
 *  - `open` mode reuses the same fixture with `meta.loop` overridden, so the two modes
 *    differ in the painter and in nothing else.
 *
 * KNOWN-GOOD CROSS-CHECK. On unmodified code before Slice 9c this prints
 * **closed: 79,213 calls / 19 Path2D** and **open: 107,010 calls / 1 Path2D** — the
 * figures Slices 9b, 10 and 12 all recorded. If a future run does not reproduce those on
 * unchanged code, the harness has drifted, not the app.
 *
 * WHAT IT DOES NOT MEASURE, stated next to what it does
 * ----------------------------------------------------
 *  - **Nothing about time.** No fps, no callback cost — that is `fps-probe.js`, in a
 *    real browser. This is a structural fingerprint only.
 *  - **Nothing rasterised.** It records the CALLS, not pixels; two different colours are
 *    two different digests, but a colour that looks wrong on screen is the eyeball's job.
 *  - **Not React, not the HUD, not the transport.** It drives `drawFrame` directly with
 *    the same clock discipline `TrackCanvas` uses (`frameDelta`/`advanceClock`), so a
 *    defect in the component's effect is invisible here.
 *  - **The digest is this script's own recipe.** Digests from a different harness (Slice
 *    9b's, Slice 10's) are not comparable to these; only the call and Path2D TOTALS are.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { advanceClock, frameDelta } from "../../app/src/engine/clock";
import { fitTransform } from "../../app/src/engine/geometry";
import { sampleAt } from "../../app/src/engine/interpolate";
import { parseReplay } from "../../app/src/engine/load";
import { readChromeColors } from "../../app/src/render/palette";
import { buildScenePaths } from "../../app/src/render/paths";
import { buildScene, drawFrame } from "../../app/src/render/scene";
import { PAD_PX } from "../../app/src/render/TrackCanvas";

const FIXTURE = new URL(
  "../../app/src/engine/__fixtures__/sample-lap.json",
  import.meta.url,
);
const FRAMES = 701;
const FRAME_MS = 100;
const WIDTH = 1176;
const HEIGHT = 657;
const DPR = 2;
const FOCUSED = 0;

/**
 * A `Path2D` that hashes its own contents incrementally.
 *
 * The retained trail is stroked as an OBJECT every frame, so a recorder that logged
 * only "stroke(path)" would be blind to what went into it — which is precisely where a
 * bucketing change would show. Hashing on append and copying the digest at stroke time
 * keeps that sensitivity at O(1) per stroke instead of re-walking 585 segments 701
 * times.
 */
class HashingPath2D {
  static constructed = 0;

  constructor() {
    HashingPath2D.constructed++;
    this.hash = createHash("md5");
    this.ops = 0;
  }

  moveTo(x, y) {
    this.append(`M${x},${y}`);
  }
  lineTo(x, y) {
    this.append(`L${x},${y}`);
  }
  closePath() {
    this.append("Z");
  }

  append(op) {
    this.hash.update(op);
    this.ops++;
  }

  /** Digest of everything appended so far. */
  signature() {
    return `${this.ops}:${this.hash.copy().digest("hex").slice(0, 12)}`;
  }
}

/**
 * A 2D context that hashes instead of rasterising.
 *
 * Every call carries the style state it was made under, so a change that reorders draws,
 * recolours one, or changes an alpha lands in the digest. `stroke`/`fill` take an
 * optional path and are special-cased for the reason `HashingPath2D` exists.
 */
function hashingContext() {
  const digest = createHash("md5");
  const counts = new Map();
  const state = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    shadowColor: "",
    shadowBlur: 0,
    font: "",
  };

  let total = 0;
  const line = (method, args, extra = "") => {
    total++;
    counts.set(method, (counts.get(method) ?? 0) + 1);
    digest.update(
      `${method}(${args.join(",")})${extra}|${state.strokeStyle}|${state.fillStyle}|` +
        `${state.lineWidth}|${state.globalAlpha}|${state.shadowColor}|` +
        `${state.shadowBlur}|${state.font}\n`,
    );
  };

  const record =
    (method) =>
    (...args) =>
      line(method, args);
  const recordPath = (method) => (path) =>
    line(method, [], path === undefined ? "" : `[${path.signature()}]`);

  const ctx = {
    lineJoin: "",
    lineCap: "",
    textAlign: "",
    textBaseline: "",
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    fill: recordPath("fill"),
    stroke: recordPath("stroke"),
    fillText: (text, x, y) => line("fillText", [x, y], `"${text}"`),
  };
  for (const key of Object.keys(state)) {
    Object.defineProperty(ctx, key, {
      get: () => state[key],
      set: (value) => {
        state[key] = value;
      },
    });
  }

  return { ctx, counts, total: () => total, md5: () => digest.digest("hex") };
}

function capture(mode, file, cars) {
  const json = JSON.parse(
    readFileSync(file === undefined ? fileURLToPath(FIXTURE) : file, "utf8"),
  );
  // The ONLY difference between the two fixture modes: same fixture, same geometry,
  // same clock — a different painter for the focused car (Slice 9b). `auto` leaves the
  // file's own `meta.loop` alone, which is the only honest choice for a real file.
  if (mode !== "auto") json.meta.loop = mode;
  // The car-count sweep, taken the way `fps-probe.js` documents it: subsets off ONE
  // file, so every point shares a window, a duration and `cars[0]` — and therefore the
  // same ribbon, bounds, fit and corner chrome. Car count is the only variable.
  if (cars !== undefined) json.cars = json.cars.slice(0, cars);
  const replay = parseReplay(json);

  globalThis.Path2D = HashingPath2D;
  HashingPath2D.constructed = 0;

  const { ctx, counts, total, md5 } = hashingContext();
  const scene = buildScene(replay);
  const fit = fitTransform(scene.bounds, WIDTH, HEIGHT, PAD_PX);
  const view = { width: WIDTH, height: HEIGHT, dpr: DPR, fit };
  const paths = buildScenePaths(scene, fit);
  const colors = readChromeColors();
  const { duration } = replay.meta;

  // `TrackCanvas`'s frame callback, minus React: the first frame measures no elapsed
  // time (`prevMs` starts null), every frame after it advances by FRAME_MS at 1x.
  let clock = 0;
  let prevMs = null;
  let nowMs = 1000;
  for (let f = 0; f < FRAMES; f++) {
    const dt = frameDelta(prevMs, nowMs);
    prevMs = nowMs;
    clock = advanceClock(clock, dt, 1, duration);
    drawFrame(ctx, scene, paths, view, sampleAt(replay, clock), colors, FOCUSED);
    nowMs += FRAME_MS;
  }

  return {
    mode: replay.meta.loop,
    cars: replay.cars.length,
    md5: md5(),
    calls: total(),
    paths2d: HashingPath2D.constructed,
    counts: [...counts].sort(),
    finalClock: clock,
  };
}

const mode = process.argv[2] ?? "closed";
const file = process.argv[3];
const cars = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
if (mode !== "closed" && mode !== "open" && mode !== "auto") {
  console.error(`usage: drawcall-capture.mjs [closed|open|auto] [file] [cars]`);
  process.exit(2);
}

const result = capture(mode, file, cars);
const perFrame = (n) => (n / FRAMES).toFixed(2);
console.log(`mode          ${result.mode}  (${result.cars} car(s))`);
console.log(
  `frames        ${FRAMES} x ${FRAME_MS}ms  (final clock ${result.finalClock.toFixed(3)}s)`,
);
console.log(
  `calls         ${result.calls.toLocaleString("en-US")}  (${perFrame(result.calls)}/frame)`,
);
console.log(`Path2D built  ${result.paths2d}`);
// A digest over a gitignored file is not reproducible by anyone else, so it is not
// offered as evidence — the per-frame structure is what a real file is here for.
console.log(`md5           ${file === undefined ? result.md5 : "(n/a — real file)"}`);
console.log(
  `by method     ${result.counts.map(([m, n]) => `${m}=${perFrame(n)}`).join(" ")}  (per frame)`,
);
