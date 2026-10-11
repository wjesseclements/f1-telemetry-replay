/**
 * layoutVariants.test.ts — the side-by-side layout's variants compile, in order.
 *
 * Slice 25. The page puts the track and the tower side by side at `md` OR on a
 * screen 5:4 or wider (`side:`, `tailwind.config.js`), and keeps the header's
 * meta line to one line on a wide or short screen (`onerow:`). jsdom evaluates no
 * media query, so no component test can tell which layout a screen gets. The
 * layout check measures a handful of viewports. The compiled stylesheet shows
 * what each variant means at every size.
 * `?inline` returns `index.css` compiled by the real pipeline, as in
 * `opacityModifiers.test.ts`. Which classes carry which variant is pinned on the
 * rendered elements (`Hud.test.tsx`).
 */
import { describe, expect, it } from "vitest";
import css from "./index.css?inline";

/** Where `selector`'s first rule starts in the compiled CSS, or -1. */
function ruleAt(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.search(new RegExp(`${escaped}\\s*\\{`));
}

/**
 * The prelude of the `@media` block holding `selector`'s rule, with whitespace
 * removed, or `null`. Tailwind emits one block per variant, so the nearest
 * `@media` before the rule is its own.
 */
function mediaFor(selector: string): string | null {
  const at = ruleAt(selector);
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

  it("compiles `onerow:` to a screen 5:4 or wider OR at most 700 px tall", () => {
    expect(mediaFor(".onerow\\:truncate")).toBe(
      "(min-aspect-ratio:5/4),(max-height:43.75rem)",
    );
  });

  it("lets the `md` sidebar's size win over the sidebar's below `md`", () => {
    // The aside is `side:w-64 side:py-2 md:w-56 md:p-4` (Hud.tsx). From 768 px
    // up both variants match, and with equal specificity the later rule wins.
    // Tailwind prints screen variants after plugin ones, and that order is all
    // that keeps the md sidebar at 224 px with `p-4`. Pinned because nothing
    // else would notice: in the other order every md screen would get the
    // phone's 256 px sidebar, and the layout check's thresholds would still pass.
    for (const [below, from] of [
      [".side\\:w-64", ".md\\:w-56"],
      [".side\\:py-2", ".md\\:p-4"],
    ]) {
      expect(ruleAt(below), below).toBeGreaterThan(-1);
      expect(ruleAt(from), `${from} after ${below}`).toBeGreaterThan(
        ruleAt(below),
      );
    }
  });
});
