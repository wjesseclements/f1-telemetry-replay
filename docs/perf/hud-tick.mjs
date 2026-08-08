/**
 * hud-tick.mjs — the ≤30 Hz instrument: what one HUD tick costs, and how many points it
 * puts in the DOM.
 *
 * WHY THIS EXISTS
 * ---------------
 * The other two instruments are both blind to this path. `drawcall-capture.mjs` counts
 * canvas calls, and the HUD is not on the canvas. `fps-probe.js` sees the frame callback
 * in aggregate, in a browser, with a foreground window — it can say the HUD did not cost
 * a frame, never what the HUD cost.
 *
 * Slice 12's addendum already settled the principle in prose after a brief asserted a
 * per-frame cost for the gap path that turned out to be 400x wrong: **"a 30 Hz cadence
 * needs its own instrument; the frame harness neither covers it nor contradicts it."** It
 * then measured gaps with a Node benchmark it threw away. Slice 9e is the second time
 * that instrument was wanted, so this is the commit rather than the third re-derivation —
 * the same reasoning that committed `fps-probe.js` and then `drawcall-capture.mjs`.
 *
 * Like both of those it lives OUTSIDE `app/`: it can never run in CI (it needs a
 * gitignored multi-megabyte replay file), so `npm run check`, `eslint .` and
 * `format:check` must never adopt it.
 *
 * USAGE (from `app/`, which is where the toolchain lives — CLAUDE.md's Gotchas)
 * ---------------------------------------------------------------------------
 *   cd app && npx vite-node ../docs/perf/hud-tick.mjs public/data/monza_endgame.json
 *   cd app && npx vite-node ../docs/perf/hud-tick.mjs public/data/monza_full_field.json
 *
 *   --focus N     which car the HUD is focused on (default 0)
 *   --ticks N     timed ticks per measurement (default 6000 = 200 s of HUD time)
 *
 * `vite-node` (not `node`) because this imports the app's real TypeScript modules through
 * the app's own resolution: the point is to measure the SHIPPED engine, not a copy. It
 * runs the file through the real `parseReplay`, so a file it accepts is a file the app
 * accepts.
 *
 * WHAT IT REPORTS, AND WHICH NUMBER CARRIES THE ARGUMENT
 * -----------------------------------------------------
 *  - **points/tick and points in the DOM path** — integer-exact, no measurement floor.
 *    These are the structural numbers and they are the evidence. Slice 12 learned this
 *    the expensive way: it fitted a car-count slope on callback time, found the signal
 *    was under `performance.now()`'s quantisation, and had to re-design the instrument
 *    around exact draw-call counts mid-slice. Same lesson, same shape of answer.
 *  - **µs/tick** — over `--ticks` warmed iterations, with the clock advanced at the
 *    HUD's own 30 Hz cadence so the sample window really moves. Reported with its share
 *    of the 33.3 ms tick budget. At these magnitudes it is a bound, not a law.
 *  - **per focus change** — the O(samples) work a `useMemo` keyed on the car does. It is
 *    paid once per focus change, not per tick, and the two must not be added together.
 *
 * The window-length independence claim is a MEASUREMENT here, not a note: run it on a
 * 3-lap file and a 7-lap file and the per-tick figures must match. That is how Slice 12
 * proved Slice 9b's bound (`monza_endgame` against the 3-car sweep point) and it is the
 * same method.
 *
 * WHAT IT DOES NOT MEASURE, stated next to what it does
 * ----------------------------------------------------
 *  - **React.** No render, no reconciliation, no DOM. This is the pure-JS half — the
 *    part that is deterministic and needs no browser. The React half is bounded by
 *    `fps-probe.js`'s callback p95/p99 in a foreground window, and nothing here
 *    substitutes for it.
 *  - **Anything on the frame path.** Gaps, the tower and the trace are all ≤30 Hz work;
 *    the canvas is `drawcall-capture.mjs`'s and `fps-probe.js`'s.
 *  - **Emit cadence.** It measures the cost of a tick, not how often one happens.
 */
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { parseReplay } = await import("../../app/src/engine/load.ts");
const trace = await import("../../app/src/engine/trace.ts");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const file = args.find((a) => !a.startsWith("--") && !Number.isFinite(Number(a)));
const focus = flag("--focus", 0);
const ticks = flag("--ticks", 6000);

if (!file) {
  console.error("usage: vite-node hud-tick.mjs <replay.json> [--focus N] [--ticks N]");
  process.exit(1);
}

const path = resolve(process.cwd(), file);
const replay = parseReplay(require(path), file);
const car = replay.cars[focus];
const { duration, sampleRateHz } = replay.meta;

/**
 * The two trace APIs, adapted to one shape so BEFORE and AFTER come from one harness.
 *
 * `drawcall-capture.mjs`'s protocol is the ordering — capture on unmodified code, change,
 * re-capture through the identical script — and that only works if the script spans the
 * change. The pre-9e branch is a COMPAT SHIM: delete it once no one needs to re-measure a
 * commit older than Slice 9e.
 */
const W = trace.TRACE_W ?? 240;
const H = trace.TRACE_H ?? 44;

const api = trace.buildTraceWindow
  ? {
      name: `9e windowed (buildTraceWindow, TRACE_SECONDS=${trace.TRACE_SECONDS})`,
      setup: () => trace.speedRange(car.samples),
      tick: (range, clock) =>
        trace.buildTraceWindow({
          samples: car.samples,
          sampleRateHz,
          clock,
          duration,
          range,
          width: W,
          height: H,
        }).path,
    }
  : {
      name: "pre-9e full sparkline (buildSpeedTrace + tracePlayheadX)",
      // The whole-replay path is what the component's `useMemo` builds per car.
      setup: () => trace.buildSpeedTrace(car.samples, W, H),
      // Per tick the old component recomputes the playhead only; the path is reused, so
      // the points in the DOM are the setup's, and the tick builds none.
      tick: (built, clock) => {
        trace.tracePlayheadX(clock, duration, W);
        return "";
      },
      domPath: (built) => built.path,
    };

/** Points in an SVG path — every `M`/`L` command. The structural number. */
const countPoints = (d) => (d.match(/[ML]/g) ?? []).length;

/** Median of the per-iteration nanosecond costs, to keep one GC pause out of the answer. */
function timed(fn, iterations) {
  const each = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    each[i] = (performance.now() - t0) * 1000; // µs
  }
  const sorted = Float64Array.prototype.slice.call(each).sort();
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  let sum = 0;
  for (const v of each) sum += v;
  return { mean: sum / iterations, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

// --- setup cost (per focus change) -------------------------------------------------
const WARM = 50;
for (let i = 0; i < WARM; i++) api.setup();
const setupCost = timed(() => api.setup(), Math.max(20, Math.round(ticks / 100)));
const built = api.setup();

// --- tick cost (per HUD emit, 30 Hz) -----------------------------------------------
// The clock advances at the HUD's own cadence and wraps, so the window really moves
// across the file rather than rebuilding the same span `ticks` times.
const STEP = 1 / 30;
const clockAt = (i) => ((i * STEP) % duration);
for (let i = 0; i < WARM; i++) api.tick(built, clockAt(i));
const tickCost = timed((i) => api.tick(built, clockAt(i)), ticks);

// --- structure (integer-exact) ------------------------------------------------------
let builtPerTick = 0;
let maxPerTick = 0;
const PROBE = Math.min(ticks, 4000);
for (let i = 0; i < PROBE; i++) {
  const n = countPoints(api.tick(built, clockAt(i)));
  builtPerTick += n;
  if (n > maxPerTick) maxPerTick = n;
}
builtPerTick /= PROBE;
const domPoints = api.domPath
  ? countPoints(api.domPath(built))
  : Math.round(maxPerTick);

const pct = (us, budgetMs) => ((us / 1000 / budgetMs) * 100).toFixed(3) + "%";
const f = (n, d = 3) => n.toFixed(d);

console.log(`file             ${file}`);
console.log(
  `replay           ${replay.cars.length} car(s), ${car.samples.length} samples/car, ` +
    `${sampleRateHz} Hz, ${f(duration, 1)} s (${replay.meta.loop}), focus ${focus} ${car.driver}`,
);
console.log(`api              ${api.name}`);
console.log(`ticks            ${ticks} at 30 Hz`);
console.log("");
console.log(`points/tick      ${f(builtPerTick, 2)} built  (max ${maxPerTick})`);
console.log(`points in DOM    ${domPoints}`);
console.log(
  `us/tick          mean ${f(tickCost.mean)}  p50 ${f(tickCost.p50)}  ` +
    `p95 ${f(tickCost.p95)}  p99 ${f(tickCost.p99)}   = ${pct(tickCost.mean, 1000 / 30)} of a 33.3ms tick`,
);
console.log(
  `us/focus change  mean ${f(setupCost.mean)}  p95 ${f(setupCost.p95)}` +
    `   = ${pct(setupCost.mean, 1000 / 30)} of one tick's budget`,
);
