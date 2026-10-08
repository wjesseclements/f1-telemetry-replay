/**
 * chrome.ts — find the system Chrome, start it headless and offline, and make
 * sure it dies.
 *
 * The SYSTEM browser, not a downloaded one: the layout check adds no dependency,
 * and a pinned browser download is exactly the kind of thing that turns a cheap
 * check into a slow, network-touching one. GitHub's ubuntu-latest image ships
 * google-chrome, and a developer machine has one.
 *
 * How it does NOT hang — the reason this file exists. Earlier headless runs on the
 * project machine used `--dump-dom` / `--virtual-time-budget` and sat there until
 * their tool timeouts. This launch uses neither: `--remote-debugging-port=0` lets
 * Chrome choose a free port and write it to `DevToolsActivePort` in a throwaway
 * `--user-data-dir`, which is polled with a deadline; Chrome's stderr is drained
 * continuously (a full pipe blocks the writer — a classic silent hang) and kept
 * only as a tail for the failure message; and the process is started as its own
 * process-group leader, so teardown can kill Chrome AND every helper it forked in
 * one signal rather than trusting the helpers to notice their parent died.
 *
 * The one Chrome process outside that group is `chrome_crashpad_handler`, which
 * detaches into a group of its own. It needs no signal: measured on macOS, it
 * exits within 1.5 s of its browser on every path — graceful `Browser.close`
 * and a bare group SIGKILL alike.
 *
 * It is also outside the throwaway profile, and nothing here moves it. On macOS
 * it runs with `--database=~/Library/Application Support/Google/Chrome/Crashpad`
 * (the user's REAL crash store) and `--url=https://clients2.google.com/cr/report`,
 * and every launch rewrites that store's `settings.dat`. Measured (Slice 22's
 * review follow-up): `--disable-crash-reporter`, `--disable-breakpad`,
 * `--disable-crashpad-for-testing`, `--crash-dumps-dir=<dir>` and the
 * `CHROME_HEADLESS=1` environment variable each left the handler starting, its
 * `--database`/`--url` unchanged and `settings.dat` rewritten — no observable
 * effect, so none is passed. Beyond that settings write, a dump lands there only
 * if a Chrome process crashes, and whether it would UPLOAD is the store's own
 * consent bit — the user's Chrome setting, not this check's (it reads "off" on
 * the project machine). The handler is a separate process, so the offline flags
 * below do not govern it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Prefix of the throwaway profile directory, so a stray one is recognisable. */
export const PROFILE_PREFIX = "f1-layout-check-";

const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
];

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The Chrome binary to drive: `CHROME_PATH` first, then the platform defaults.
 * Throws a message that says how to fix it — never a bare ENOENT from `spawn`.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CHROME_PATH;
  if (override !== undefined && override !== "") {
    if (isExecutableFile(override)) return override;
    throw new Error(
      `CHROME_PATH is set to "${override}", which is not an executable file.\n  Fix: point it at a Chrome/Chromium binary, or unset it to use the default.`,
    );
  }

  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      ...MAC_CANDIDATES,
      ...MAC_CANDIDATES.map((p) => join(env.HOME ?? "", p)),
    );
  } else {
    const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d !== "");
    for (const name of LINUX_NAMES) {
      for (const dir of dirs) candidates.push(join(dir, name));
    }
  }
  const found = candidates.find(isExecutableFile);
  if (found !== undefined) return found;

  throw new Error(
    [
      "No Chrome or Chromium found.",
      process.platform === "darwin"
        ? `  Looked for: ${MAC_CANDIDATES.join(", ")} (and under ~/Applications)`
        : `  Looked on PATH for: ${LINUX_NAMES.join(", ")}`,
      "  Fix: install Google Chrome, or point CHROME_PATH at a Chrome/Chromium",
      "  binary, e.g. CHROME_PATH=/usr/bin/chromium npm run check:layout",
    ].join("\n"),
  );
}

/**
 * The launch flags, each one load-bearing.
 *
 * Offline enforcement lives here, inside the browser, because CLAUDE.md's offline
 * rule binds the app and its tests and this check runs the app. Three layers, and
 * only the second and third ENFORCE anything:
 *
 * 1. The background flags (`--disable-background-networking`, component update,
 *    sync, default apps) REDUCE Chrome's own traffic; they do not stop it.
 *    Measured with a net-log of a full run on Chrome 154: Chrome still starts
 *    requests to www.google.com, accounts.google.com, www.gstatic.com,
 *    update.googleapis.com and clients2.google.com, with no page involved.
 * 2. `--host-resolver-rules` is what blocks them — and anything the page tries:
 *    every host except loopback resolves to `~NOTFOUND`. It applies to IP
 *    LITERALS too (measured: a page fetch of `http://192.0.2.1/` fails
 *    `ERR_NAME_NOT_RESOLVED`), which is why 127.0.0.1 is EXCLUDEd by name.
 * 3. `--no-proxy-server` is what keeps rule 2 in force. A request sent through a
 *    proxy is never resolved locally — the proxy resolves it — so resolver rules
 *    do not apply to it. Measured (Slice 22's review): with a loopback sink as the
 *    proxy, one run carried requests for all five Google hosts above, plus the
 *    page's own off-origin fetches, past the rule; with `--no-proxy-server` added,
 *    the sink saw 0 connections and the page's fetches failed
 *    `ERR_NAME_NOT_RESOLVED` again — and that was against an explicit
 *    `--proxy-server`, the strongest proxy source there is. The weaker ones (the
 *    OS settings or PAC a corporate agent or a debugging proxy installs; on Linux,
 *    the `https_proxy`-style env vars Chrome reads there) rank below command-line
 *    flags in Chromium, so they are closed by that precedence rather than by a
 *    measurement here. (macOS Chrome ignores the env vars outright: measured, 0
 *    connections with them set and no flag.) The first version of this file
 *    dropped a dead `--proxy-server` as "measured redundant" — measured on a
 *    machine with no proxy configured, the one case where it is.
 *
 * The recorder (`recorder.ts`) is the other half: it FAILs on any request the page
 * or its workers attempt off the preview origin, blocked or not. It does not see
 * the browser's own requests in layer 1 — those have no page — which is why the
 * enforcement has to be here.
 */
export function chromeArgs(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    "--no-proxy-server",
    // A fresh profile on macOS otherwise asks the Keychain for "Chrome Safe
    // Storage", and on Linux may wait on a desktop keyring: either is a prompt
    // nobody is there to answer.
    "--use-mock-keychain",
    "--password-store=basic",
    "--mute-audio",
    ...(needsNoSandbox(env, platform) ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

/**
 * `--no-sandbox` on a Linux CI runner, and NOWHERE else.
 *
 * Measured on the first CI runs (2026-10-08, Chrome 154.0.8037.57 on ubuntu-latest):
 * Chrome launches with it and the check runs 51/51. Whether the flag is REQUIRED
 * there was not tested — the reasoning below is why it was added, and dropping it
 * is one CI run away from an answer.
 * Ubuntu 24.04 (GitHub's ubuntu-latest) restricts unprivileged user namespaces
 * through AppArmor, and Chrome's Linux sandbox is built on them, so Chrome may
 * refuse to start there; if it does, the launch error carries Chrome's stderr
 * tail. Dropping the sandbox is acceptable on that machine because the runner is
 * an ephemeral VM thrown away after the job, and the only content this Chrome
 * renders is the repo's own build, served on loopback, with every other host
 * unresolvable. On a developer's machine none of that holds, so the gate is
 * narrow: GitHub Actions sets `CI=true` exactly, and only Linux has the problem.
 * If the first CI run shows the sandbox starting fine, delete this.
 */
export function needsNoSandbox(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  return env.CI === "true" && platform === "linux";
}

export interface ChromeProcess {
  /**
   * The browser's DevTools WebSocket URL
   * (`ws://127.0.0.1:<port>/devtools/browser/<id>`). Rejects — with Chrome's own
   * stderr tail — if Chrome exits first or `timeoutMs` passes.
   */
  devtoolsUrl: Promise<string>;
  /** Resolves when the browser process has exited. */
  exited: Promise<void>;
  /** SIGKILL the whole process group. Synchronous; safe to call repeatedly. */
  killGroup(): void;
  /** Remove the throwaway profile. Synchronous; safe to call repeatedly. */
  removeProfile(): void;
}

const STDERR_TAIL_BYTES = 4096;
const POLL_MS = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn Chrome and return its handle at once.
 *
 * The handle exists from the moment the process does, before DevTools is up, so
 * the caller can hold it in the one place its teardown looks: an interrupt that
 * lands mid-launch still finds a process group to kill and a profile to remove.
 * Waiting for the endpoint is `devtoolsUrl`'s job.
 */
export function startChrome(binary: string, timeoutMs: number): ChromeProcess {
  const userDataDir = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  const removeProfile = () => {
    // Retries because a just-killed Chrome can still be closing files in here.
    rmSync(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  };

  let child: ChildProcess;
  try {
    child = spawn(binary, chromeArgs(userDataDir), {
      // Own process group (POSIX), so `killGroup` reaches every helper.
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    removeProfile();
    throw err;
  }

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
  });

  let exitReason: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitReason = `exited with ${signal ?? `code ${String(code)}`}`;
      resolve();
    });
    child.once("error", (err) => {
      exitReason = `failed to start: ${err.message}`;
      resolve();
    });
  });

  const killGroup = () => {
    if (child.pid === undefined) return;
    try {
      // The GROUP even when the browser process itself has exited: a helper that
      // outlived it is exactly what this is for. Windows has no process groups;
      // there the browser alone is killed and its helpers follow it out.
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else if (exitReason === null) child.kill("SIGKILL");
    } catch {
      // ESRCH: the group is already gone.
    }
  };

  const withStderr = (text: string) => {
    const tail = stderr.trim();
    return tail === "" ? text : `${text}\n  Chrome stderr (tail):\n${tail}`;
  };

  const devtoolsUrl = (async () => {
    const portFile = join(userDataDir, "DevToolsActivePort");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exitReason !== null) {
        throw new Error(
          withStderr(`Chrome ${exitReason} before opening DevTools.`),
        );
      }
      if (existsSync(portFile)) {
        // Two lines: the port, then the browser target's path. Written in one
        // go, but read defensively — a half-written file just waits a tick.
        const [port, path] = readFileSync(portFile, "utf8").split("\n");
        if (port !== undefined && path !== undefined && path.startsWith("/")) {
          return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          withStderr(
            `Chrome did not write DevToolsActivePort within ${timeoutMs} ms.`,
          ),
        );
      }
      await sleep(POLL_MS);
    }
  })();
  // The caller may be interrupted before it awaits this; a rejection nobody is
  // waiting on yet must not surface as an unhandled one.
  devtoolsUrl.catch(() => undefined);

  return { devtoolsUrl, exited, killGroup, removeProfile };
}
