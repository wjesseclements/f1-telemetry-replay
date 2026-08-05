/**
 * fps-probe.js — the frame-budget instrument. Paste into the browser console.
 *
 * Filed by Slice 12. It exists so that re-measuring after Slices 9c and 9e is a RE-RUN
 * rather than a re-derivation: Slices 9b and 10 both left their draw-call harness
 * uncommitted and recorded only its parameters in PLAN, and 9c's spec now has to rebuild
 * it from prose. The numbers live in PLAN; this file is how to get them again.
 *
 * It is deliberately NOT under `app/`. It can never run in CI — it needs a visible
 * browser tab and a gitignored multi-megabyte replay file — so it must not sit anywhere
 * `npm run check`, `eslint .` or `format:check` would adopt it and then have to skip it.
 * It touches no app symbol, so it cannot rot from code drift either.
 *
 * ---------------------------------------------------------------------------------
 * PROCEDURE
 * ---------------------------------------------------------------------------------
 * 1.  cd app && npm run build && npm run preview
 *     The PRODUCTION build. The dev server serves unminified modules over a websocket
 *     and is not what anyone deploys.
 *
 * 2.  Open the preview URL and BRING THE WINDOW TO THE FOREGROUND. rAF is throttled to
 *     nothing in a hidden tab, so a background measurement reads ~0fps and looks like a
 *     catastrophic regression. `run()` refuses to start unless the tab is visible and
 *     invalidates any run the tab is hidden during, rather than returning a number.
 *
 * 3.  Paste this file into the console. It defines `fpsProbe` and nothing else.
 *
 * 4.  Per replay file — by hand:
 *       await fpsProbe.armLoad()          // then pick the file — resolves with load cost
 *       fpsProbe.press("Play")            // and let it settle a second
 *       await fpsProbe.run({ label: "1x" })
 *       fpsProbe.press("4× speed")
 *       await fpsProbe.run({ label: "4x" })
 *
 *     …or scripted, for a file the preview server serves (`app/dist/data/`):
 *       await fpsProbe.loadFrom("/data/monza_full_field.json")
 *
 * 5.  fpsProbe.table()  — every run so far, one row each, ready to paste into PLAN.
 *
 * ---------------------------------------------------------------------------------
 * THE CAR-COUNT SWEEP
 * ---------------------------------------------------------------------------------
 * Frame interval is clamped by vsync, so a single car count cannot show a slope. The
 * sweep varies car count and NOTHING ELSE by slicing subsets off one full-field file:
 * same window, same duration, same `cars[0]`, therefore the same ribbon, bounds, fit
 * and corner chrome. `dist/` is gitignored build output, so nothing here is committed
 * and no source-tree data file is written.
 *
 *   python3 - <<'PY'
 *   import json
 *   ff = json.load(open("app/public/data/monza_full_field.json"))
 *   for n in (1, 3, 7, 13, 19):
 *       with open(f"app/dist/data/field_{n:02d}.json", "w") as f:
 *           json.dump({"meta": ff["meta"], "track": ff["track"],
 *                      "cars": ff["cars"][:n]}, f, sort_keys=True, indent=2)
 *           f.write("\n")
 *   PY
 *
 * Check the derivation rather than trusting it: the N=19 subset must be md5-identical
 * to `monza_full_field.json`, and the N=3 subset structurally equal to the shipped
 * `monza_race.json`. Both hold, which is what makes the series "the real files with
 * cars removed" rather than a claim about them.
 *
 *   await fpsProbe.sweep([1,3,7,13,19].map(n => `/data/field_${String(n).padStart(2,"0")}.json`))
 *
 * Add `/data/monza_endgame.json` (3 cars, 2.2x the window) as the window-length
 * control: its callback cost should match the 3-car point, which is Slice 9b's
 * "independent of window length" measured rather than asserted.
 *
 * Driving it from a tool rather than by hand: do not `await` a 5-second call. Start it
 * with `fpsProbe.run({label:"1x"}).then(r => (window.__fps = r))` and poll `window.__fps`
 * — the same arm-then-poll shape a hidden-tab stall would otherwise turn into a timeout.
 *
 * ---------------------------------------------------------------------------------
 * WHAT IT MEASURES, AND THE LIMITS OF EACH
 * ---------------------------------------------------------------------------------
 * INTERVAL — deltas between consecutive rAF timestamps. `fps` is frames divided by
 *   measured wall seconds, not a smoothed figure. This is the metric the >=50fps bar is
 *   written against. Its limit: it is CLAMPED BY VSYNC. On a 120 Hz display anything
 *   comfortably inside budget reads 120fps, so two car counts that differ four-fold in
 *   real cost can produce the identical number. Good for the bar, useless for a slope.
 *
 * CALLBACK — `performance.now()` read at the top of this probe's own rAF callback, minus
 *   the frame timestamp every rAF callback in that frame is handed. The app's loop
 *   (`TrackCanvas.tsx`) re-registers itself at the TOP of its own callback, so it is
 *   always queued ahead of this one and this number is elapsed-since-frame-start, i.e.
 *   the app's whole per-frame cost: `drawFrame` plus the `telemetry.publish` that
 *   synchronously renders the HUD on its <=30 Hz cadence. THIS is the metric the
 *   car-count slope is fitted on, because it is not clamped by the display.
 *   Its limits, stated rather than assumed:
 *     - it EXCLUDES GPU paint and composite, which happen after the callback returns;
 *     - it INCLUDES anything else the browser scheduled ahead of this probe in the
 *       frame, so treat it as an upper bound on the app and a lower bound on the frame;
 *     - the HUD's 30 Hz emit makes it bimodal — half the frames at 120fps do no HUD
 *       work at all. That is why p95/p99 are reported and not just p50.
 *
 * LOAD — `armLoad()` timestamps the file input's `change` in the CAPTURE phase (before
 *   React's delegated bubble-phase handler runs), then waits for the picker to report
 *   the new filename (`changeToLoadedMs`: JSON.parse + `parseReplay` + `setReplay` + the
 *   commit) and on to a settled main thread (`changeToQuietMs`, which adds `buildScene`
 *   and `buildScenePaths` plus up to three frames of slack).
 *   Waiting for the filename is load-bearing and was a real defect in the first version:
 *   the picker's handler is async, so the frames straight after `change` are IDLE and a
 *   quiet-frame detector resolves in the gap BEFORE the parse begins. It reported a
 *   3.5 MB file as loading in 35 ms — it had timed the idle gap, not the load.
 *
 * DRAW CALLS — `countDraws()`, and it is the metric the car-count LINEARITY rests on.
 *   See its own comment: under 1 ms of an 8.3 ms budget, the timings sit inside
 *   `performance.now()`'s quantisation and cannot resolve a slope; exact integer call
 *   counts can. It also proves the CALLBACK metric's ordering assumption per frame.
 *
 * The probe allocates its buffers up front and does no DOM access inside the loop; its
 * own per-frame cost is two typed-array writes.
 */
(() => {
  const LONG_FRAME_MS = 20;
  const DROPPED_FRAME_MS = 33;
  /** Frames a frame time must stay under for the main thread to count as quiet. */
  const QUIET_FRAMES = 3;
  const QUIET_MS = 50;

  const runs = [];

  const percentile = (sorted, p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];

  const stats = (samples) => {
    const sorted = Float64Array.from(samples).sort();
    let sum = 0;
    for (const v of sorted) sum += v;
    return {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
    };
  };

  const round = (v, dp = 2) => Number(v.toFixed(dp));

  /**
   * Everything about the run that is not a timing and would otherwise go unrecorded.
   *
   * Frame cost depends on the canvas AREA as much as on the car count, so a baseline
   * that does not carry the viewport is not re-runnable. Read once, before the loop.
   */
  const context = () => {
    const canvas = document.querySelector("canvas");
    const speed = document.querySelector(
      '[aria-label="Playback speed"] [aria-pressed="true"]',
    );
    return {
      cars: document.querySelectorAll('[aria-label="Running order"] > li').length,
      speed: speed === null ? "?" : speed.textContent.trim(),
      cssPx: canvas === null ? "?" : `${canvas.style.width}x${canvas.style.height}`,
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent.includes("Chrome") ? "Chrome" : navigator.userAgent,
    };
  };

  /**
   * Sample `frames` consecutive animation frames and report interval and callback cost.
   *
   * Rejects rather than returning a number if the tab is not visible at the start, or
   * becomes hidden during the run. A hidden tab does not throttle rAF a little; it stops
   * it, and the resulting figure is not a slow measurement but a wrong one.
   */
  const run = ({ frames = 600, label = "" } = {}) =>
    new Promise((resolve, reject) => {
      if (document.visibilityState !== "visible") {
        reject(
          new Error(
            "fps-probe: tab is hidden — rAF is throttled to nothing. Bring the window " +
              "to the foreground and re-run.",
          ),
        );
        return;
      }

      const intervals = new Float64Array(frames);
      const callbacks = new Float64Array(frames);
      const meta = context();
      let hidden = false;
      const onVisibility = () => {
        if (document.visibilityState !== "visible") hidden = true;
      };
      document.addEventListener("visibilitychange", onVisibility);

      // -1 is a warm-up frame: it carries the cost of the console evaluation that
      // started the run and has no interval to measure.
      let i = -1;
      let prev = 0;
      let first = 0;

      const tick = (ts) => {
        const cost = performance.now() - ts;

        if (i < 0) {
          first = ts;
          prev = ts;
          i = 0;
          requestAnimationFrame(tick);
          return;
        }

        intervals[i] = ts - prev;
        callbacks[i] = cost;
        prev = ts;
        i += 1;

        if (i < frames && !hidden) {
          requestAnimationFrame(tick);
          return;
        }

        document.removeEventListener("visibilitychange", onVisibility);

        if (hidden) {
          reject(
            new Error(
              `fps-probe: tab was hidden after ${i} of ${frames} frames — run INVALID.`,
            ),
          );
          return;
        }

        const seconds = (prev - first) / 1000;
        let long = 0;
        let dropped = 0;
        for (const dt of intervals) {
          if (dt > LONG_FRAME_MS) long += 1;
          if (dt > DROPPED_FRAME_MS) dropped += 1;
        }

        const report = {
          label,
          ...meta,
          frames,
          seconds: round(seconds, 3),
          fps: round(frames / seconds, 1),
          interval: stats(intervals),
          callback: stats(callbacks),
          [`over${LONG_FRAME_MS}ms`]: long,
          [`over${DROPPED_FRAME_MS}ms`]: dropped,
        };
        runs.push(report);
        console.log(report);
        resolve(report);
      };

      requestAnimationFrame(tick);
    });

  /**
   * Arm the load measurement, then pick a file. Resolves once the main thread is quiet.
   *
   * The `change` listener is capture-phase and on the input itself, so its timestamp
   * precedes React's delegated bubble-phase handler and therefore the whole of
   * `loadReplayFile` -> `parseReplay` -> `setReplay` -> `buildScene`.
   */
  const armLoad = ({ expect = null } = {}) => {
    const input = document.querySelector('input[type="file"]');
    if (input === null) {
      return Promise.reject(new Error("fps-probe: no file input on the page."));
    }

    const tasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tasks.push(round(entry.duration, 1));
    });
    observer.observe({ entryTypes: ["longtask"] });

    console.log("fps-probe: armed — pick the replay file now.");

    return new Promise((resolve) => {
      input.addEventListener(
        "change",
        () => {
          const t0 = performance.now();
          tasks.length = 0;
          let quiet = 0;
          let last = performance.now();
          let loadedAt = 0;

          const settle = (ts) => {
            const dt = ts - last;
            last = ts;

            // WAIT FOR THE REPLAY TO ACTUALLY ARRIVE FIRST. `ReplayFilePicker`'s
            // handler is async — it returns immediately and the parse happens after
            // `file.text()` resolves — so the frames right after `change` are IDLE.
            // Counting quiet frames from `change` alone therefore resolves during that
            // gap and reports the load as taking about four frames. Measured that way
            // a 3.5 MB file "loaded" in 35 ms, which is the probe timing nothing at all.
            if (loadedAt === 0) {
              if (expect !== null && !loadedName().includes(expect)) {
                requestAnimationFrame(settle);
                return;
              }
              loadedAt = ts;
            }

            quiet = dt < QUIET_MS ? quiet + 1 : 0;
            if (quiet < QUIET_FRAMES) {
              requestAnimationFrame(settle);
              return;
            }
            observer.disconnect();
            const total = tasks.reduce((a, b) => a + b, 0);
            const report = {
              ...context(),
              // `change` to the first frame on which the app is showing the new file:
              // JSON.parse + `parseReplay` + `setReplay` + the commit, i.e. the load.
              changeToLoadedMs: round(loadedAt - t0, 1),
              // …and on to a settled main thread, which adds `buildScene` and
              // `buildScenePaths`. Overshoots by the QUIET_FRAMES of slack it needs.
              changeToQuietMs: round(ts - t0, 1),
              longTasks: tasks.slice(),
              longTaskTotalMs: round(total, 1),
              maxLongTaskMs: tasks.length === 0 ? 0 : Math.max(...tasks),
            };
            console.log(report);
            resolve(report);
          };
          requestAnimationFrame(settle);
        },
        { capture: true, once: true },
      );
    });
  };

  /** What the picker is currently reporting as loaded — `""` before any pick. */
  const loadedName = () => {
    for (const p of document.querySelectorAll("p")) {
      const text = p.textContent.trim();
      if (text.startsWith("loaded ")) return text.slice(7);
    }
    return "";
  };

  /**
   * Load a replay through the REAL picker, without the native file dialog.
   *
   * `fetch` it, wrap it in a `File`, put it on the input via `DataTransfer`, dispatch
   * `change`. This is the one automated path into this app that works: the Scrubber's
   * React-controlled value ignores synthetic events, but `<input type="file">` is not
   * controlled, so the app's own handler runs exactly as it does for a human pick —
   * `loadReplayFile` -> `parseReplay` -> `setReplay`, schema validation and all. The
   * load cost measured here is therefore the real one.
   *
   * @param url something the preview server serves, i.e. a file under `app/dist/data/`.
   */
  const loadFrom = async (url) => {
    const input = document.querySelector('input[type="file"]');
    if (input === null) throw new Error("fps-probe: no file input on the page.");

    const name = url.split("/").pop();
    if (loadedName() === name) {
      throw new Error(
        `fps-probe: ${name} is already loaded — the load probe watches for the ` +
          "picker's filename to CHANGE, so re-loading the same file would hang.",
      );
    }

    const settled = armLoad({ expect: name });
    const blob = await fetch(url).then((r) => {
      if (!r.ok) throw new Error(`fps-probe: ${url} -> HTTP ${r.status}`);
      return r.blob();
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], name, { type: "application/json" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return { file: name, bytes: blob.size, ...(await settled) };
  };

  /**
   * Click a transport control by its accessible name — `setSpeed("4×")`, `setSpeed("Play")`.
   *
   * A real `.click()`, which React's delegated listener receives like any other. Kept
   * here so a measurement sweep is scripted rather than hand-clicked between runs, which
   * is what makes the speed a recorded parameter instead of a remembered one.
   */
  const press = (name) => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? b.textContent).trim() === name,
    );
    if (button === undefined) throw new Error(`fps-probe: no button named ${name}`);
    button.click();
    return button.textContent.trim();
  };

  /** The 2D context calls `scene.ts` makes, in the order they first appear in a frame. */
  const COUNTED = [
    "clearRect",
    "setTransform",
    "beginPath",
    "moveTo",
    "lineTo",
    "arc",
    "stroke",
    "fill",
    "fillText",
  ];

  /**
   * Count `CanvasRenderingContext2D` calls per frame, and prove the callback metric.
   *
   * WHY THIS EXISTS. At 120 Hz the frame budget is 8.3 ms and the app spends well under
   * 1 ms of it, so the whole car-count sweep sits inside `performance.now()`'s 100 µs
   * quantisation — the timing can say "comfortably inside budget" but it cannot resolve
   * a slope, and a slope is what says whether the cost is linear in cars. Draw calls
   * can: they are exact integers, they are what `drawFrame` actually does, and an
   * O(n^2) term in the render path would show up in them immediately.
   *
   * IT ALSO SETTLES THE ORDERING QUESTION the callback metric rests on. `drawFrame`
   * calls `clearRect` first, so timestamping it inside the patch and comparing against
   * the probe's own callback start measures, per frame, how much of the app ran BEFORE
   * the probe. A positive lead on every frame is what makes `performance.now() - ts`
   * the app's cost rather than an arbitrary fraction of it.
   *
   * DO NOT read timings from a counting run: patching the prototype adds a closure and
   * a counter increment to every canvas call, which is exactly the thing being counted.
   * Run `run()` for time and `countDraws()` for structure.
   */
  const countDraws = ({ frames = 120 } = {}) =>
    new Promise((resolve, reject) => {
      if (document.visibilityState !== "visible") {
        reject(new Error("fps-probe: tab is hidden — bring the window forward."));
        return;
      }

      const proto = CanvasRenderingContext2D.prototype;
      const saved = {};
      const counts = {};
      let clearAt = 0;

      for (const name of COUNTED) {
        counts[name] = 0;
        saved[name] = proto[name];
        proto[name] = function patched(...args) {
          counts[name] += 1;
          if (name === "clearRect") clearAt = performance.now();
          return saved[name].apply(this, args);
        };
      }

      const restore = () => {
        for (const name of COUNTED) proto[name] = saved[name];
      };

      const meta = context();
      const perFrame = [];
      const lead = new Float64Array(frames);
      let i = -1;
      let prev = null;

      const tick = (ts) => {
        const probeAt = performance.now();
        const snap = { ...counts };

        if (i < 0) {
          i = 0;
          prev = snap;
          requestAnimationFrame(tick);
          return;
        }

        const delta = { total: 0 };
        for (const name of COUNTED) {
          delta[name] = snap[name] - prev[name];
          delta.total += delta[name];
        }
        perFrame.push(delta);
        lead[i] = probeAt - clearAt;
        prev = snap;
        i += 1;

        if (i < frames && document.visibilityState === "visible") {
          requestAnimationFrame(tick);
          return;
        }

        restore();

        if (i < frames) {
          reject(new Error("fps-probe: tab hidden mid-count — run INVALID."));
          return;
        }

        const median = (key) => {
          const values = Float64Array.from(perFrame, (f) => f[key]).sort();
          return percentile(values, 0.5);
        };
        const report = {
          ...meta,
          frames,
          perFrameMedian: Object.fromEntries(
            ["total", ...COUNTED].map((k) => [k, median(k)]),
          ),
          perFrameMax: Object.fromEntries(
            ["total", ...COUNTED].map((k) => [
              k,
              Math.max(...perFrame.map((f) => f[k])),
            ]),
          ),
          // Positive on every frame == the app's callback ran ahead of the probe's, so
          // `callback` in run() is the app's per-frame cost and not a slice of it.
          appRanFirst: { min: round(Math.min(...lead), 3), p50: round(percentile(Float64Array.from(lead).sort(), 0.5), 3) },
        };
        console.log(report);
        resolve(report);
      };

      requestAnimationFrame(tick);
    });

  /**
   * The whole measurement matrix in one call: every file, every speed, unattended.
   *
   * Progress and results accumulate on `window.__sweep` as it goes, so it is driven by
   * polling that object rather than by awaiting a two-minute call — a hidden tab would
   * turn the await into a timeout with nothing to show for it.
   *
   * Playback is asserted rather than assumed before each run: a replay swap leaves
   * `isPlaying` untouched by design (`ReplayFilePicker`), so a paused app would measure
   * a static canvas and report it as a frame rate.
   */
  const sweep = async (urls, { frames = 600, speeds = ["1×", "4×"] } = {}) => {
    const out = { stage: "starting", loads: [], runs: [], draws: [] };
    window.__sweep = out;

    for (const url of urls) {
      out.stage = `loading ${url}`;
      out.loads.push(await loadFrom(url));

      for (const speed of speeds) {
        press(`${speed} speed`);
        // A rate change and a fresh replay both need a moment before they are what is
        // being measured rather than part of it.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const play = [...document.querySelectorAll("button")].find(
          (b) => (b.getAttribute("aria-label") ?? b.textContent).trim() === "Play",
        );
        if (play !== undefined) play.click();

        out.stage = `${url} @ ${speed}`;
        const name = url.split("/").pop();
        out.runs.push(await run({ frames, label: `${name} ${speed}` }));
      }

      // Structure, once per file, at 1x — draw calls do not depend on playback rate,
      // and a counting run's timings are not usable anyway (see `countDraws`).
      press("1× speed");
      out.draws.push({
        file: url.split("/").pop(),
        ...(await countDraws({ frames: 120 })),
      });
    }

    out.stage = "done";
    return out;
  };

  /** Every run so far as one flat table — the shape PLAN's Measured block wants. */
  const table = () => {
    const rows = runs.map((r) => ({
      label: r.label,
      cars: r.cars,
      speed: r.speed,
      frames: r.frames,
      seconds: r.seconds,
      fps: r.fps,
      "int p50": round(r.interval.p50),
      "int p95": round(r.interval.p95),
      "int p99": round(r.interval.p99),
      "cb p50": round(r.callback.p50),
      "cb p95": round(r.callback.p95),
      "cb p99": round(r.callback.p99),
      "cb mean": round(r.callback.mean),
      ">20ms": r[`over${LONG_FRAME_MS}ms`],
      ">33ms": r[`over${DROPPED_FRAME_MS}ms`],
    }));
    console.table(rows);
    return rows;
  };

  window.fpsProbe = {
    run,
    countDraws,
    armLoad,
    loadFrom,
    sweep,
    press,
    table,
    runs,
    context,
  };
  console.log(
    "fps-probe ready — fpsProbe.armLoad() / fpsProbe.run() / fpsProbe.table()",
    context(),
  );
})();
