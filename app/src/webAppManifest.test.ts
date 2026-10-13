/**
 * webAppManifest.test.ts — Add to Home Screen (Slice 27; drafted as Slice 26's
 * F), checked at build time. This header is also where index.html's install
 * tags are explained: the reasons lived in that file as a comment, which every
 * visitor downloaded (about 1.6 KB), so they moved here and index.html points
 * to this file.
 *
 * WHAT INSTALLING CHANGES. Launched from the home screen the app runs without
 * Safari's toolbars: an upright 375x812 iPhone gives the page about 375x734 to
 * 375x768 instead of 375x626, a landscape one about 724x354 to 724x375 instead
 * of 724x257. Those sizes are estimates from Apple's published safe areas,
 * measured in headless Chrome, never on a phone. Same-origin static files only,
 * and NO service worker: the installed app needs the site exactly as a bookmark
 * does, so the offline rule is unchanged.
 *
 * THE VIEWPORT SAYS `viewport-fit=auto` ON PURPOSE. It is the default, written
 * out so nobody changes it by accident. With `cover` a landscape phone's layout
 * viewport becomes the whole 812 px screen, `md` (768 px) starts to match
 * although only 724 px are usable, and the 224 px column readout comes back.
 * Measured with safe-area padding: a 1-car readout cut 75 px, which `auto`
 * shows whole. With `auto` iOS letterboxes the page into the safe area itself,
 * and no CSS changes.
 *
 * THE STATUS BAR IS `black`, not `black-translucent`: translucent draws the page
 * under the clock, which only `cover` plus safe-area padding could undo.
 *
 * THE ICON is option A, "corner" — the human's choice (2026-10-12);
 * `docs/icons/rasterize-icons.mjs` says how to change it.
 *
 * The manifest, the icons and the iOS tags are static files that no component
 * renders, so no component test can see them break. A wrong icon size or a
 * missing file fails only on a phone, at install time, and nothing reports it.
 * These tests catch that here, the way `galleryAssets.test.ts` checks the gallery
 * manifest against its files.
 *
 * Read from disk, not fetched: the offline trap in `src/test/setup.ts` stays
 * armed. What is pinned, and why:
 *  - every path the manifest names is a same-origin path. The offline rule
 *    allows the app no other host, and an installed app is no exception;
 *  - no service worker, from the sources or from index.html itself (an inline
 *    script): installing must not add a cache layer or a second network path
 *    (CLAUDE.md's offline rule);
 *  - the colours are the `--c-bg` token. A static file cannot read the CSS, so
 *    the hex is repeated in it, and this test keeps the copies equal;
 *  - every icon exists at the size it declares (read from the PNG header);
 *  - the viewport stays `viewport-fit=auto`, and iOS's status bar stays
 *    `black` (both explained above);
 *  - the names are the human's (2026-10-12): the full name is the page's own
 *    title, and the label under the icon, "F1 Telemetry", is one string in two
 *    files, the manifest's `short_name` and iOS's `apple-mobile-web-app-title`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(APP, "public");
const read = (path: string) => readFileSync(join(APP, path), "utf8");

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
}

const manifest = JSON.parse(read("public/manifest.webmanifest")) as Manifest;
const html = read("index.html");
const css = read("src/index.css");

/** A design token's value as written in index.css. */
function token(name: string): string | undefined {
  return css.match(new RegExp(`--c-${name}:\\s*(#[0-9a-fA-F]{6});`))?.[1];
}

/** The `content` of `<meta name="…">` in index.html. */
function meta(name: string): string | undefined {
  return html.match(
    new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`),
  )?.[1];
}

/** The `href` of `<link rel="…">` in index.html. */
function link(rel: string): string | undefined {
  return html.match(
    new RegExp(`<link\\s+rel="${rel}"[^>]*\\shref="([^"]*)"`),
  )?.[1];
}

/** What any code registering a service worker has to name. */
const REGISTERS_WORKER = /serviceWorker/;

/** A same-origin path served from `public/`, as the file it names. */
function publicFile(path: string): string {
  return join(PUBLIC, path.slice(1));
}

/** Width and height from a PNG's IHDR chunk, or null when it is not a PNG. */
function pngSize(file: string): { width: number; height: number } | null {
  const bytes = readFileSync(file);
  const signature = "89504e470d0a1a0a";
  if (bytes.subarray(0, 8).toString("hex") !== signature) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A path on the app's own origin: rooted, no scheme, no host, no way up. */
const SAME_ORIGIN_PATH = /^\/(?!\/)(?!.*\.\.)[^:]*$/;

describe("the web app manifest", () => {
  it("is linked from index.html and served from the site root", () => {
    expect(link("manifest")).toBe("/manifest.webmanifest");
    expect(existsSync(publicFile("/manifest.webmanifest"))).toBe(true);
  });

  it("names only paths on the app's own origin", () => {
    const paths = [
      manifest.id,
      manifest.start_url,
      manifest.scope,
      ...manifest.icons.map((icon) => icon.src),
    ];
    for (const path of paths) expect(path).toMatch(SAME_ORIGIN_PATH);
    // The pattern itself refuses what the offline rule refuses.
    for (const bad of [
      "https://example.com/",
      "//example.com/icon.png",
      "/../icon.png",
      "icon.png",
    ])
      expect(bad).not.toMatch(SAME_ORIGIN_PATH);
  });

  it("launches standalone, without the browser's toolbars", () => {
    expect(manifest.display).toBe("standalone");
  });

  it("takes its colours from the --c-bg design token", () => {
    const bg = token("bg");
    expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(manifest.theme_color).toBe(bg);
    expect(manifest.background_color).toBe(bg);
    expect(meta("theme-color")).toBe(bg);
  });

  it("gives iOS the same home-screen label as the manifest", () => {
    expect(meta("apple-mobile-web-app-title")).toBe(manifest.short_name);
    // The value itself is the human's ruling (2026-10-12), not only the two
    // copies agreeing.
    expect(manifest.short_name).toBe("F1 Telemetry");
  });

  it("keeps iOS's status bar `black`, outside the page", () => {
    // `black-translucent` draws the page under the clock, and only
    // `viewport-fit=cover` plus safe-area padding could undo that; the viewport
    // stays `auto` (below). With `black` the status bar sits above the page.
    expect(meta("apple-mobile-web-app-status-bar-style")).toBe("black");
  });

  it("names the installed app what the page's title already calls it", () => {
    expect(html).toContain(`<title>${manifest.name}</title>`);
  });
});

describe("the home-screen icons", () => {
  it("exist at the size each one declares", () => {
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(publicFile(icon.src))).toEqual({ width, height });
    }
  });

  it("cover what Android and desktop installs ask for: 192 and 512, and a maskable 512", () => {
    const has = (sizes: string, purpose: string) =>
      manifest.icons.some((i) => i.sizes === sizes && i.purpose === purpose);
    expect(has("192x192", "any")).toBe(true);
    expect(has("512x512", "any")).toBe(true);
    expect(has("512x512", "maskable")).toBe(true);
  });

  it("give iOS a 180x180 apple-touch-icon at the root path it also probes", () => {
    expect(link("apple-touch-icon")).toBe("/apple-touch-icon.png");
    expect(pngSize(publicFile("/apple-touch-icon.png"))).toEqual({
      width: 180,
      height: 180,
    });
  });
});

describe("what installing does not change", () => {
  it("registers no service worker and ships none", () => {
    const sources = readdirSync(join(APP, "src"), { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources)
      expect(read(join("src", file)), file).not.toMatch(REGISTERS_WORKER);
    // The page itself too, every byte of it: an inline `<script>` or an inline
    // handler in index.html registers a worker as surely as a module does.
    expect(html, "index.html").not.toMatch(REGISTERS_WORKER);
    expect(
      '<script>navigator.serviceWorker.register("/sw.js")</script>',
    ).toMatch(REGISTERS_WORKER);
    const shipped = readdirSync(PUBLIC, { recursive: true }).map(String);
    expect(
      shipped.filter((f) => /(^|\/)(sw|service-?worker)\.js$/i.test(f)),
    ).toEqual([]);
  });

  it("keeps the viewport at viewport-fit=auto, written out", () => {
    expect(meta("viewport")).toBe(
      "width=device-width, initial-scale=1.0, viewport-fit=auto",
    );
  });
});
