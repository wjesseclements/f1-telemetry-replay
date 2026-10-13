/**
 * rasterize-icons.mjs — the home-screen icon PNGs, rendered from ONE SVG by the
 * system Chrome (headless and offline, through the layout check's own launcher).
 *
 * WHY A SCRIPT: the PNGs are binary and the art is a design decision, so the PNGs
 * must be reproducible from a reviewable source. Change `app-icon.svg`, re-run this,
 * commit both. Nothing in `npm run check` runs it (it lives outside `app/`, like
 * `docs/perf/`); `src/webAppManifest.test.ts` checks what it wrote.
 *
 * THE ICON IS OPTION A, "corner" — the human's choice (2026-10-12). `docs/icons/proposals/` holds the three
 * designs: A "corner" (the favicon's speed-painted corner, grown up), B "circuit"
 * (a closed circuit on the app's track ribbon, one car) and C "trace" (a lap's
 * speed trace, height is speed). `app-icon.svg` is a byte-for-byte copy of A.
 * Changing it is one step, from the repo root:
 *
 *   cp docs/icons/proposals/option-b-circuit.svg docs/icons/app-icon.svg
 *   cd app && npx vite-node ../docs/icons/rasterize-icons.mjs
 *
 * then commit `app-icon.svg` with the four PNGs it rewrote (git shows exactly
 * those five files).
 *
 * USAGE (from `app/`, where the toolchain lives — CLAUDE.md's Gotchas):
 *
 *   cd app && npx vite-node ../docs/icons/rasterize-icons.mjs
 *   cd app && npx vite-node ../docs/icons/rasterize-icons.mjs -- --src <svg> --out <dir>
 *
 *   --src  a full-bleed 512x512 SVG whose art keeps inside the maskable safe zone
 *          (a centred circle of radius 40%, 205 px). Default ../docs/icons/app-icon.svg.
 *   --out  default `public`. Writes:
 *            <out>/apple-touch-icon.png         180x180  full bleed, opaque. iOS cuts
 *                                                        its own rounded shape; the
 *                                                        root path is also where iOS
 *                                                        looks when no link names one.
 *            <out>/icons/icon-192.png           192x192  rounded square ("any"),
 *            <out>/icons/icon-512.png           512x512  transparent corners.
 *            <out>/icons/icon-maskable-512.png  512x512  full bleed ("maskable"): the
 *                                                        Android launcher cuts it.
 *          and prints each file's bytes and sha256. Run twice: the hashes match.
 *
 * OFFLINE + TEARDOWN: `startChrome` is the gate's (headless=new, throwaway profile,
 * every host but loopback unresolvable, no proxy); the page is about:blank with the
 * SVG inlined as a data: URL, so nothing is requested at all. Browser.close, then the
 * process group is killed and the profile removed — on success, failure and signals.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const APP_DIR = process.cwd();
const LAYOUT = join(APP_DIR, "scripts", "layout");
const { CdpClient, CdpPage } = await import(join(LAYOUT, "cdp.ts"));
const { findChrome, startChrome } = await import(join(LAYOUT, "chrome.ts"));

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : resolve(APP_DIR, args[i + 1]);
};
const SRC = opt("--src", resolve(APP_DIR, "../docs/icons/app-icon.svg"));
const OUT = opt("--out", resolve(APP_DIR, "public"));

/** The favicon's corner radius (rx 7 of 32), so the "any" icons match it. */
const ROUNDED = `${(7 / 32) * 100}%`;
const TARGETS = [
  { file: "apple-touch-icon.png", size: 180, radius: "0" },
  { file: "icons/icon-192.png", size: 192, radius: ROUNDED },
  { file: "icons/icon-512.png", size: 512, radius: ROUNDED },
  { file: "icons/icon-maskable-512.png", size: 512, radius: "0" },
];

const svg = readFileSync(SRC);
const dataUrl = `data:image/svg+xml;base64,${svg.toString("base64")}`;

const chrome = startChrome(findChrome(), 15_000);
let client = null;
const kill = () => {
  chrome.killGroup();
  chrome.removeProfile();
};
process.on("exit", kill);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

try {
  client = await CdpClient.connect(await chrome.devtoolsUrl, 15_000);
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new CdpPage(client, sessionId);
  const { frameTree } = await page.send("Page.getFrameTree");
  await page.send("Emulation.setDefaultBackgroundColorOverride", {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });
  console.log(`rasterize-icons · ${SRC} → ${OUT}`);
  for (const t of TARGETS) {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: t.size,
      height: t.size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send("Page.setDocumentContent", {
      frameId: frameTree.frame.id,
      html:
        `<!doctype html><style>html,body{margin:0;background:transparent}` +
        `img{display:block;width:${t.size}px;height:${t.size}px;border-radius:${t.radius}}</style>` +
        `<img src="${dataUrl}">`,
    });
    // Decoded, then two frames, so the screenshot is of the painted image.
    await page.evaluate(
      () =>
        document.images[0]
          .decode()
          .then(
            () =>
              new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          ),
      undefined,
    );
    const { data } = await page.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: t.size, height: t.size, scale: 1 },
    });
    const bytes = Buffer.from(data, "base64");
    const file = join(OUT, t.file);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(`  ${t.file.padEnd(28)} ${t.size}x${t.size}  ${bytes.length} B  ${sha}`);
  }
} finally {
  if (client !== null) {
    await client.send("Browser.close").catch(() => undefined);
    client.close();
  }
  await Promise.race([chrome.exited, new Promise((r) => setTimeout(r, 2_000))]);
  kill();
}
