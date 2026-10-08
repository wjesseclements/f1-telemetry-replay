/**
 * layout-check.ts — the layout, measured in a real browser.
 *
 * jsdom has no layout engine: every box it reports is 0x0, so the app's tests can
 * prove WHAT renders but never WHERE. This drives the system's headless Chrome
 * over the DevTools Protocol against the BUILT app (`dist/`, served by Vite's own
 * `preview()`) and asserts the geometric facts a visitor depends on, at five
 * viewports (`VIEWPORTS`) and in three states (`layout/states.ts`):
 *
 *   A  first load — the gallery panel open over the committed fixture;
 *   B  the largest gallery scenario (most cars) loaded by clicking its card;
 *   C  the gallery reopened over that replay.
 *
 * Every assertion prints PASS/FAIL with the numbers it measured. Per viewport,
 * two more rows cover the whole run: no request off the preview origin (from the
 * page, its workers or its frames) and no uncaught page exception.
 *
 *     npm run build && npm run check:layout
 *
 * The exit code says where to look; the rows say what is wrong.
 *   0        the run finished and every row passed.
 *   1        the run finished and at least one row FAILED — a layout assertion,
 *            a state that could not be reached (its row says why, a wait that
 *            ran out of budget included), an off-origin request, a page
 *            exception. Read the table.
 *   2        the run did not finish: it could not start (no build, no Chrome,
 *            Chrome would not launch, the page cannot run the probes) or the
 *            hard cap stopped it. Whatever was measured is printed; the ABORTED
 *            line says why.
 *   130/143  interrupted (SIGINT/SIGTERM).
 *
 * Zero dependencies: Node's built-in WebSocket, Vite (already here), and the
 * Chrome that is already installed (`CHROME_PATH` overrides). `layout/chrome.ts`
 * says why it cannot hang and how the browser is kept offline;
 * `layout/recorder.ts` (fed by `layout/targets.ts`) is the other half of the
 * offline rule.
 *
 * Teardown — Chrome's whole process group, its throwaway profile, the preview
 * server — runs on every exit path: success, failure, exception, the hard cap,
 * SIGINT and SIGTERM, a second signal during teardown included. A SIGKILL to
 * THIS process is the one path nothing can catch; the profile directory's
 * `f1-layout-check-` prefix makes a survivor recognisable.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview, type PreviewServer } from "vite";
import { scenarioUrl } from "../src/engine/gallery";
import { SCENARIOS } from "../src/gallery/scenarios";
import { CdpClient, CdpPage } from "./layout/cdp";
import { findChrome, startChrome, type ChromeProcess } from "./layout/chrome";
import { preflight } from "./layout/preflight";
import { PageRecorder } from "./layout/recorder";
import { Report } from "./layout/report";
import {
  stateA,
  stateB,
  stateC,
  type Scenario,
  type StateContext,
} from "./layout/states";
import { Targets } from "./layout/targets";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
// `vite.config.ts` does not override `build.outDir`, so this is where
// `vite build` writes and what `preview()` serves.
const DIST_DIR = join(APP_DIR, "dist");

// ── budgets ──────────────────────────────────────────────────────────────────
// Every step has its own deadline, so a stall names the step; the hard cap is the
// backstop for anything that slips between them. A clean run takes ~2 s on the
// project machine (measured), so each budget is many times what its step needs.
const OVERALL_CAP_MS = 90_000;
const PREVIEW_START_MS = 15_000;
const CHROME_LAUNCH_MS = 15_000;
const TEARDOWN_STEP_MS = 2_000;

// ── viewports ────────────────────────────────────────────────────────────────
// Phone, short laptop, desktop. CSS px. Slice 25 added the short phone and the
// landscape phone, where the stacked strip's floor and the side-by-side switch
// (`side:` in `tailwind.config.js`: `md`, or a screen 5:4 or wider) matter most.
const VIEWPORTS: readonly { width: number; height: number }[] = [
  { width: 375, height: 812 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 375, height: 667 },
  { width: 667, height: 375 },
];
/**
 * Below this width the emulated device is a phone (`mobile: true`: meta-viewport
 * honoured, overlay scrollbars). 768 is Tailwind's `md`. The app switches to side
 * by side there, or at 5:4 and wider at any width, so 667x375 is a phone
 * emulated side by side.
 */
const MOBILE_BELOW_PX = 768;

const report = new Report();
let currentStep = "starting";
let server: PreviewServer | null = null;
let chrome: ChromeProcess | null = null;
let client: CdpClient | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Name the step in progress: it is what the hard cap reports on a hang. */
function step(name: string): void {
  currentStep = name;
}

/** Race `work` against a deadline that names the step. */
async function within<T>(
  name: string,
  ms: number,
  work: Promise<T>,
): Promise<T> {
  step(name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name}: no result within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ── one viewport, in its own browser context ─────────────────────────────────

async function checkViewport(
  cdp: CdpClient,
  targets: Targets,
  vp: { width: number; height: number },
  origin: string,
  scenario: Scenario,
): Promise<void> {
  const name = `${vp.width}x${vp.height}`;
  step(`opening a ${name} tab`);
  // A fresh browser context per viewport: no cache, storage or open panel can
  // leak from one viewport's run into the next.
  const { browserContextId } = await cdp.send<{ browserContextId: string }>(
    "Target.createBrowserContext",
  );
  const recorder = new PageRecorder(origin);
  // Every session in this context — the page, and each worker or frame it
  // starts — reports to this viewport's recorder.
  const unwatch = targets.watch(browserContextId, (event) =>
    recorder.handle(event),
  );

  try {
    const { targetId } = await cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank", browserContextId },
    );
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    await targets.adoptPage(sessionId, browserContextId);
    const page = new CdpPage(cdp, sessionId);
    await page.send("Network.enable");
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: vp.width,
      height: vp.height,
      // Layout is in CSS px and does not depend on the pixel ratio; 1 keeps the
      // canvas backing store (and the run) small.
      deviceScaleFactor: 1,
      mobile: vp.width < MOBILE_BELOW_PX,
    });
    // Reduced motion: the transport store boots PAUSED under it and the tower's
    // FLIP slides are skipped, so every run measures the same frozen frame rather
    // than a tower mid-reshuffle. Layout does not depend on motion, and a visitor
    // who asks for reduced motion gets exactly this page.
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    const ctx: StateContext = { page, viewport: name, report, step };
    let reached: "none" | "A" | "B" = "none";
    try {
      step(`loading the app at ${name}`);
      const nav = await page.send<{ errorText?: string }>("Page.navigate", {
        url: `${origin}/`,
      });
      if (nav.errorText !== undefined) {
        throw new Error(`navigation failed: ${nav.errorText}`);
      }
      await stateA(ctx);
      reached = "A";
      await stateB(ctx, scenario);
      reached = "B";
      await stateC(ctx);
    } catch (err) {
      // A state that could not be reached is a FAIL, never a silent skip — and
      // so is every state that depended on it.
      const failed = reached === "none" ? "A" : reached === "A" ? "B" : "C";
      report.record(name, failed, "reached", false, message(err));
      if (failed === "A") {
        report.record(name, "B", "reached", false, "A not reached");
      }
      if (failed !== "C") {
        report.record(name, "C", "reached", false, "B not reached");
      }
    }
  } finally {
    unwatch();
    report.record(
      name,
      "*",
      "no off-origin requests",
      recorder.offOrigin.length === 0,
      recorder.summary(),
    );
    // An uncaught exception while A/B/C ran is a defect in the page, whatever the
    // geometry says — a row, not a note (Slice 22's review).
    report.record(
      name,
      "*",
      "no page exceptions",
      recorder.exceptions.length === 0,
      recorder.exceptionSummary(),
    );
    await cdp
      .send("Target.disposeBrowserContext", { browserContextId })
      .catch(() => undefined);
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

/** Newest mtime under `dir`, recursively. */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
}

/** Fail loudly without a build; say so when the build is older than the code. */
function checkBuild(): void {
  const index = join(DIST_DIR, "index.html");
  if (!existsSync(index)) {
    throw new Error(
      `No build at ${DIST_DIR}.\n  Fix: run \`npm run build\` (or \`npx vite build\`) in app/ first — this check serves the BUILT app.`,
    );
  }
  const built = statSync(index).mtimeMs;
  const sources = Math.max(
    newestMtime(join(APP_DIR, "src")),
    newestMtime(join(APP_DIR, "public")),
    statSync(join(APP_DIR, "index.html")).mtimeMs,
  );
  if (sources > built) {
    report.note(
      "dist/ is OLDER than src/ or public/: this run checks a stale build; rebuild to check the current code",
    );
  }
}

/**
 * The gallery scenario with the most cars, counted in the BUILT asset — the
 * bytes the page will fetch — rather than trusted from provenance. Its title,
 * which is how the card is found, comes from the manifest through the app's own
 * parse, so no user-facing copy is written down here. Ties go to manifest order.
 */
function largestScenario(): Scenario & { file: string } {
  let best: (Scenario & { file: string }) | null = null;
  for (const scenario of SCENARIOS) {
    const path = join(DIST_DIR, scenarioUrl(scenario, "/"));
    const { cars } = JSON.parse(readFileSync(path, "utf8")) as {
      cars: unknown[];
    };
    if (best === null || cars.length > best.cars) {
      best = { title: scenario.title, cars: cars.length, file: scenario.file };
    }
  }
  if (best === null) throw new Error("the gallery manifest has no scenarios");
  return best;
}

/**
 * Run every in-page probe once on a blank page (`layout/preflight.ts`), in a
 * context of its own. A throw ends the run with exit 2 and a message naming the
 * toolchain — never as a table in which every row failed for the same reason.
 */
async function checkProbesRun(cdp: CdpClient): Promise<void> {
  step("checking the page can run the probes");
  const { browserContextId } = await cdp.send<{ browserContextId: string }>(
    "Target.createBrowserContext",
  );
  try {
    const { targetId } = await cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank", browserContextId },
    );
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    await preflight(new CdpPage(cdp, sessionId));
  } finally {
    await cdp
      .send("Target.disposeBrowserContext", { browserContextId })
      .catch(() => undefined);
  }
}

// ── teardown, on every path ──────────────────────────────────────────────────

let teardownStarted: Promise<void> | null = null;

/** Close the browser, kill what is left of its group, the profile, the server. */
function teardown(): Promise<void> {
  teardownStarted ??= (async () => {
    if (client !== null) {
      // Graceful first: Browser.close takes the helpers down with it.
      await client
        .send("Browser.close", {}, undefined, TEARDOWN_STEP_MS)
        .catch(() => undefined);
      client.close();
    }
    if (chrome !== null) {
      await Promise.race([chrome.exited, sleep(TEARDOWN_STEP_MS)]);
      chrome.killGroup(); // whatever is left of the group, graceful or not
      await Promise.race([chrome.exited, sleep(TEARDOWN_STEP_MS)]);
      chrome.removeProfile();
    }
    if (server !== null) {
      await Promise.race([server.close(), sleep(TEARDOWN_STEP_MS)]);
    }
  })();
  return teardownStarted;
}

// The synchronous last resort: whatever calls `process.exit` — including Vite's
// own SIGTERM handler — still kills the group and removes the profile.
process.on("exit", () => {
  chrome?.killGroup();
  try {
    chrome?.removeProfile();
  } catch {
    // Exiting anyway; the prefix makes a leftover directory recognisable.
  }
});

/** Stop now: print what was measured, tear down (bounded), exit `code`. */
function abort(reason: string, code: number): void {
  if (report.isSealed) return; // already printed and on the way out
  report.print();
  console.error(`\nlayout-check ABORTED: ${reason}`);
  const forced = setTimeout(() => process.exit(code), 4 * TEARDOWN_STEP_MS);
  void teardown().finally(() => {
    clearTimeout(forced);
    process.exit(code);
  });
}

/**
 * The first SIGINT/SIGTERM aborts: print, bounded teardown, exit. A second one —
 * the impatient double Ctrl-C — or one that lands while a finished run is already
 * tearing down, exits AT ONCE: `process.exit` runs the synchronous exit hook
 * above, which kills the group and removes the profile, and an exit that waits
 * on nothing cannot be interrupted again. `on`, not `once`: with `once`, the
 * second signal fell through to Node's default handler, which ends the process
 * WITHOUT 'exit' handlers — measured in Slice 22's review, each double Ctrl-C
 * left an 8.5 MB profile in $TMPDIR.
 */
function onSignal(reason: string, code: number): void {
  if (report.isSealed) process.exit(code);
  abort(reason, code);
}

process.on("SIGINT", () => onSignal("interrupted (SIGINT)", 130));
process.on("SIGTERM", () => onSignal("terminated (SIGTERM)", 143));
process.on("uncaughtException", (err) => abort(`uncaught: ${message(err)}`, 2));
process.on("unhandledRejection", (err) =>
  abort(`unhandled rejection: ${message(err)}`, 2),
);

const hardCap = setTimeout(
  () =>
    abort(
      `hard cap of ${OVERALL_CAP_MS / 1000} s exceeded while ${currentStep}`,
      2,
    ),
  OVERALL_CAP_MS,
);

async function main(): Promise<void> {
  step("checking the build");
  checkBuild();
  const scenario = largestScenario();
  const binary = findChrome();

  server = await within(
    "starting the preview server",
    PREVIEW_START_MS,
    preview({
      root: APP_DIR,
      logLevel: "silent",
      // Loopback only, port chosen by the OS: never collides with a dev server
      // or another run, never reachable from the network.
      preview: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
    }),
  );
  const address = server.httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("the preview server has no TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  chrome = startChrome(binary, CHROME_LAUNCH_MS);
  const url = await within(
    "launching Chrome",
    // A backstop a beat behind `devtoolsUrl`'s own deadline, so on a stall the
    // message that wins is the one carrying Chrome's stderr.
    CHROME_LAUNCH_MS + 1_000,
    chrome.devtoolsUrl,
  );
  client = await within(
    "connecting to Chrome",
    CHROME_LAUNCH_MS,
    CdpClient.connect(url, CHROME_LAUNCH_MS),
  );
  const { product } = await client.send<{ product: string }>(
    "Browser.getVersion",
  );
  const targets = new Targets(client);
  await targets.start();
  await checkProbesRun(client);
  console.log(
    `layout-check · ${product} · ${origin} · largest scenario "${scenario.title}" (${scenario.file}, ${scenario.cars} cars)\n`,
  );

  for (const vp of VIEWPORTS) {
    if (report.isSealed) return; // aborted mid-run: the abort owns the exit
    try {
      await checkViewport(client, targets, vp, origin, scenario);
    } catch (err) {
      report.record(
        `${vp.width}x${vp.height}`,
        "*",
        "viewport ran",
        false,
        message(err),
      );
    }
  }
}

main()
  .then(async () => {
    if (report.isSealed) return; // aborted: `abort` prints and exits
    clearTimeout(hardCap);
    const code = report.print();
    await teardown();
    process.exit(code);
  })
  .catch((err: unknown) => abort(message(err), 2));
