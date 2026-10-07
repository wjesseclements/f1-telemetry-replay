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
 * and a bare group SIGKILL alike — and no extra flag (`--disable-breakpad`,
 * `--disable-crash-reporter`) stops it starting.
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
 * rule binds the app and its tests and this check runs the app: the background
 * networking flags stop Chrome itself phoning home (component updates, sync,
 * default apps, the network-prediction and variations fetches that
 * `--disable-background-networking` covers); and `--host-resolver-rules` makes
 * every host except loopback unresolvable. The rule applies to IP LITERALS too —
 * measured: a page fetch of `http://192.0.2.1/` fails `ERR_NAME_NOT_RESOLVED` —
 * which is why 127.0.0.1 has to be EXCLUDEd by name, and why no second mechanism
 * (a dead proxy was tried) adds anything. The recorder in `layout-check.ts` is
 * the other layer: it FAILs on any request the page attempts off its own origin,
 * blocked or not.
 */
export function chromeArgs(userDataDir: string): string[] {
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
    // A fresh profile on macOS otherwise asks the Keychain for "Chrome Safe
    // Storage", and on Linux may wait on a desktop keyring: either is a prompt
    // nobody is there to answer.
    "--use-mock-keychain",
    "--password-store=basic",
    "--mute-audio",
    "about:blank",
  ];
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
