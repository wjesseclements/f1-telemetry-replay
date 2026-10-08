/**
 * layoutVariants.test.ts — the side-by-side layout has one trigger, and it compiles.
 *
 * Slice 25. The page puts the track and the tower side by side at `md` OR on a
 * screen 5:4 or wider (`side:`, `tailwind.config.js`), and keeps the header to one
 * row on a wide screen (`wide:`). jsdom evaluates no media query, so no component
 * test can tell which layout a screen gets. The layout check measures five
 * viewports. The compiled stylesheet shows what each variant means at every size.
 * `?inline` returns `index.css` compiled by the real pipeline, as in
 * `opacityModifiers.test.ts`.
 */
import { describe, expect, it } from "vitest";
import css from "./index.css?inline";

/** The shipped sources — what Tailwind's `./src/**` content glob scans, less tests. */
const SOURCES = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test/**"],
  { query: "?raw", import: "default", eager: true },
);

/**
 * The prelude of the `@media` block holding `selector`'s rule, with whitespace
 * removed, or `null`. Tailwind emits one block per variant, so the nearest
 * `@media` before the rule is its own.
 */
function mediaFor(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = css.search(new RegExp(`${escaped}\\s*\\{`));
  if (at === -1) return null;
  const open = css.lastIndexOf("@media", at);
  if (open === -1) return null;
  return css
    .slice(open + "@media".length, css.indexOf("{", open))
    .replace(/\s/g, "");
}

describe("the side-by-side layout's variants", () => {
  it("compiles `side:` to `md` OR a screen 5:4 or wider", () => {
    expect(mediaFor(".side\\:flex-row")).toBe(
      "(min-width:768px),(min-aspect-ratio:5/4)",
    );
  });

  it("compiles `wide:` to a screen 5:4 or wider, at any width", () => {
    expect(mediaFor(".wide\\:truncate")).toBe("(min-aspect-ratio:5/4)");
  });

  it("is the only trigger: no shipped source switches anything at `md`", () => {
    // `md:` agrees with `side:` from 768 px up and disagrees on every landscape
    // phone. A sidebar class written as `md:` leaves a 667x375 phone half
    // switched. The metres column, for one, fits only stacked. The pattern is
    // assembled from fragments so Tailwind's scanner compiles nothing from it.
    const md = new RegExp(`(?<![\\w-])${"m"}${"d"}:[\\w[-][^\\s"'\`]*`, "g");
    const offenders = Object.entries(SOURCES).flatMap(([path, text]) =>
      (text.match(md) ?? []).map((cls) => `${path}: ${cls}`),
    );
    expect(offenders).toEqual([]);
  });
});
