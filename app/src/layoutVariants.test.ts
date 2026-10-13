/**
 * layoutVariants.test.ts — the side-by-side layout's variants compile, in order.
 *
 * Slice 25. The page puts the track and the tower side by side at `md` OR on a
 * screen 5:4 or wider (`side:`, `tailwind.config.js`), and keeps the header's
 * meta line to one line on a wide or short screen (`onerow:`). Slice 26 adds
 * `phone:`, below `md` or at most 30rem tall, where the overlay dialogs cover the
 * whole screen (`components/overlay.ts`). jsdom evaluates no
 * media query, so no component test can tell which layout a screen gets. The
 * layout check measures a handful of viewports. The compiled stylesheet shows
 * what each variant means at every size.
 * `?inline` returns `index.css` compiled by the real pipeline, as in
 * `opacityModifiers.test.ts`. Which classes carry which variant is pinned on the
 * rendered elements (`Hud.test.tsx`).
 */
import { describe, expect, it } from "vitest";
import {
  COMPACT_FOCUS_RING,
  COMPACT_PEER_FOCUS_RING,
  FOCUS_RING,
  PEER_FOCUS_RING,
} from "./components/focus";
import { COMPACT_QUERY } from "./components/compactLayout";
import { PHONE_QUERY } from "./components/phoneLayout";
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

/** The declarations of `selector`'s first rule, whitespace removed, or "". */
function ruleBody(selector: string): string {
  const at = ruleAt(selector);
  if (at === -1) return "";
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open)).replace(/\s/g, "");
}

describe("the side-by-side layout's variants", () => {
  it("compiles `side:` to `md` OR a screen 5:4 or wider", () => {
    expect(mediaFor(".side\\:flex-row")).toBe(
      "(min-width:768px),(min-aspect-ratio:5/4)",
    );
  });

  it("compiles `onerow:` to a screen 5:4 or wider, at most 700 px tall, OR `compact:`'s upright phone", () => {
    // The third clause is Slice 27's (ruled 2026-10-12, its height bound
    // removed 2026-10-13): wherever the header is one thin row upright, its
    // meta line keeps to that row. It is `compact:`'s own upright clause, so
    // every compact screen is `onerow:` too (the landscape one is inside the
    // 700 px clause).
    const compact = mediaFor(".compact\\:py-0")!;
    const upright = compact.slice(compact.indexOf(",") + 1);
    expect(upright).toBe("(max-width:39.9375rem)and(orientation:portrait)");
    expect(mediaFor(".onerow\\:truncate")).toBe(
      `(min-aspect-ratio:5/4),(max-height:43.75rem),${upright}`,
    );
  });

  it("compiles `phone:` to the screens `md:` does not match OR at most 480 px tall", () => {
    // Slice 26: the overlay dialogs cover the whole screen below `md`. Written as
    // `not all and` the `md` query itself, so no width falls between the two —
    // a `(max-width: 767px)` would leave 767.5 px to neither. Whitespace is
    // stripped, hence "notalland". The height clause (ruled 2026-10-12) takes in
    // a Plus or Pro Max iPhone held sideways, ~814x312 in Safari, which is `md`.
    const md = mediaFor(".md\\:w-56");
    expect(md).toBe("(min-width:768px)");
    expect(mediaFor(".phone\\:fixed")).toBe(
      `notalland${md},(max-height:30rem)`,
    );
  });

  it("is the query React reads, so the dialog is modal exactly where it is full screen", () => {
    // `usePhoneModal` makes the page inert behind a phone overlay; the overlay
    // goes full screen through `phone:`. Two copies of one query, held together
    // here: modal over a page still usable beside it, or not modal over a page
    // it covers, would follow from either drifting.
    expect(PHONE_QUERY.replace(/\s/g, "")).toBe(mediaFor(".phone\\:fixed"));
  });

  it("compiles `compact:` to a landscape phone OR any upright one (Slice 27)", () => {
    // At most 480 px tall (every landscape phone, Safari's 724x257 included), or
    // under 640 px wide and portrait: every phone held upright, at any height
    // (ruled 2026-10-13; up to 700 px in the first cut, then 800 px), so
    // 375x812 and 390x844 too. Not a 1366x657 laptop window, and not a narrow
    // window wider than tall and over 480 px tall (600x500).
    expect(mediaFor(".compact\\:py-0")).toBe(
      "(max-height:30rem),(max-width:39.9375rem)and(orientation:portrait)",
    );
  });

  it("is the query React reads, so a tooltip shows exactly where the label is an icon (Slice 27)", () => {
    // The header's two buttons carry their label as a `title` only on
    // `compact:` screens, where the label is `sr-only` behind an icon (ruled
    // 2026-10-12; `useCompactLayout`). Two copies of one query, held together
    // here: a tooltip repeating a visible label, or an icon with none, would
    // follow from either drifting.
    expect(COMPACT_QUERY.replace(/\s/g, "")).toBe(mediaFor(".compact\\:py-0"));
  });

  it("compiles the 44 px touch-target floor and the scrubber's 44 px box under `compact:` (Slice 27)", () => {
    // The human's ruling (2026-10-12): every control in the thin rows keeps a
    // 44x44 CSS px target. A class Tailwind could not compile would vanish with
    // no warning and leave 26 px buttons, and every component test would still
    // see the class name, so the compiled rule is what is pinned.
    const compact = mediaFor(".compact\\:py-0");
    for (const [selector, declaration] of [
      [".compact\\:min-h-11", "min-height:2.75rem"],
      [".compact\\:min-w-11", "min-width:2.75rem"],
      [".compact\\:h-11", "height:2.75rem"],
      [".compact\\:rounded-\\[2px\\/22px\\]", "border-radius:2px/22px"],
      // Important, or the tint's inline `background` shorthand resets it.
      [
        ".compact\\:\\!bg-clip-content",
        "background-clip:content-box!important",
      ],
    ]) {
      expect(mediaFor(selector), selector).toBe(compact);
      expect(ruleBody(selector), selector).toContain(declaration);
    }
  });

  it("insets both short-phone focus rings, the file picker's label's too (Slice 27)", () => {
    // On a short phone a control's 44 px box fills its row, and the header's
    // touch the top of the screen, so a ring drawn outside the box was cut off
    // (`components/focus.ts`). The file picker's label rings through its peer
    // input's focus, from a constant of its own. The component tests compare
    // each control against these constants, so if a constant stopped insetting
    // no test there would notice; here each is held to the rule it compiles to.
    const compact = mediaFor(".compact\\:py-0");
    for (const [ring, cls, selector] of [
      [
        COMPACT_FOCUS_RING,
        "compact:focus-visible:ring-inset",
        ".compact\\:focus-visible\\:ring-inset:focus-visible",
      ],
      [
        COMPACT_PEER_FOCUS_RING,
        "compact:peer-focus-visible:ring-inset",
        ".compact\\:peer-focus-visible\\:ring-inset",
      ],
    ]) {
      expect(ring.split(" "), ring).toContain(cls);
      expect(mediaFor(selector), selector).toBe(compact);
      expect(ruleBody(selector), selector).toContain("--tw-ring-inset:inset");
    }
  });

  it("draws both short-phone focus rings white, and every other ring in the accent (Slice 27)", () => {
    // Ruled 2026-10-12: inset, an accent ring looked like the selected speed
    // button's accent border, so on these rows the ring is `--c-txt`. It must
    // come after the accent rule it replaces (same specificity, so the later
    // rule wins), and the desktop rings keep the accent.
    const compact = mediaFor(".compact\\:py-0");
    for (const [ring, cls, selector, accent] of [
      [
        COMPACT_FOCUS_RING,
        "compact:focus-visible:ring-txt",
        ".compact\\:focus-visible\\:ring-txt:focus-visible",
        ".focus-visible\\:ring-accent:focus-visible",
      ],
      [
        COMPACT_PEER_FOCUS_RING,
        "compact:peer-focus-visible:ring-txt",
        ".compact\\:peer-focus-visible\\:ring-txt",
        ".peer-focus-visible\\:ring-accent",
      ],
    ]) {
      expect(ring.split(" "), ring).toContain(cls);
      expect(mediaFor(selector), selector).toBe(compact);
      expect(ruleBody(selector), selector).toContain("var(--c-txt)");
      expect(ruleBody(accent), accent).toContain("var(--c-accent)");
      expect(ruleAt(selector), `${selector} after ${accent}`).toBeGreaterThan(
        ruleAt(accent),
      );
    }
    expect(FOCUS_RING.split(" ")).toContain("focus-visible:ring-accent");
    expect(PEER_FOCUS_RING.split(" ")).toContain(
      "peer-focus-visible:ring-accent",
    );
  });

  it("compiles the thin rows' spacing and title size under `compact:` (Slice 27)", () => {
    // The header's and the transport bar's thinness is these rules: no vertical
    // padding, no gap between the bar's wrapped rows, a smaller title, a block
    // scrubber. The elements are pinned to the classes in `App.test.tsx` and
    // `TransportBar.test.tsx`; this pins that each class still compiles, and
    // to what.
    const compact = mediaFor(".compact\\:py-0");
    for (const [selector, declaration] of [
      [".compact\\:py-0", "padding-top:0"],
      [".compact\\:py-0", "padding-bottom:0"],
      [".compact\\:gap-y-0", "row-gap:0"],
      [".compact\\:text-xs", "font-size:0.75rem"],
      [".compact\\:block", "display:block"],
    ]) {
      expect(mediaFor(selector), selector).toBe(compact);
      expect(ruleBody(selector), selector).toContain(declaration);
    }
  });

  it("lets a short phone's thin header win over the one-line header (Slice 27)", () => {
    // The meta line's zero minimum width on a short phone must override its 6rem
    // one-line floor where both match (every compact screen is also `onerow:`),
    // or the floor holds beside the title and the two icon boxes and wraps the
    // header to 96 px. With equal specificity the later rule wins. That the line
    // carries the class at all is pinned on the element (`App.test.tsx`). The
    // class is deliberately not spelled out in this comment: when Tailwind still
    // scanned test files, a comment here naming it compiled the rule by itself,
    // and this test passed with the class deleted from the component.
    const floor = ruleAt(".onerow\\:min-w-24");
    const compact = ruleAt(".compact\\:min-w-0");
    expect(floor, "the one-line floor's rule").toBeGreaterThan(-1);
    expect(compact, "the short phone's rule").toBeGreaterThan(floor);
  });

  it("compiles `fulltrack:` to at most 320 px tall, narrower than `md`, side by side (Slice 27)", () => {
    // Ruled 2026-10-12: the header above the tower column on the shortest
    // landscape phones (Safari's 724x257). Narrower than `md`, where the tower
    // column is 256 px; and 5:4 or wider, the `side:` shape, so the grid never
    // forms on a stacked page with no tower column to sit above.
    expect(mediaFor(".fulltrack\\:grid")).toBe(
      "(max-height:20rem)and(max-width:47.9375rem)and(min-aspect-ratio:5/4)",
    );
    expect(ruleBody(".fulltrack\\:grid")).toContain("display:grid");
    expect(ruleBody(".fulltrack\\:contents")).toContain("display:contents");
  });

  it("makes the grid's second column the tower's own width, and its header spacing win (Slice 27)", () => {
    // The column is written out (App.tsx, `FULL_TRACK_GRID`) so the header's one
    // row cannot widen it: it has to be the width `side:w-64` gives the tower
    // below `md`, or the tower would sit in a column of another width. And the
    // header's 4 px padding and gaps, which keep it one row in that column, must
    // come after the thin header's 8 px ones, which match there too.
    const block = css.slice(
      css.lastIndexOf("@media", ruleAt(".fulltrack\\:grid")),
    );
    expect(ruleBody(".side\\:w-64")).toBe("width:16rem;");
    expect(block.replace(/\s/g, "")).toContain(
      "grid-template-columns:minmax(0,1fr)16rem",
    );
    // The header's row shrinks rather than push the transport bar off screen
    // when a failed load's error box makes the header tall (App.tsx).
    expect(block.replace(/\s/g, "")).toContain(
      "grid-template-rows:minmax(0,auto)minmax(0,1fr)auto",
    );
    for (const [compact, full] of [
      [".compact\\:px-2", ".fulltrack\\:px-1"],
      [".compact\\:gap-x-2", ".fulltrack\\:gap-x-1"],
    ]) {
      expect(ruleAt(compact), compact).toBeGreaterThan(-1);
      expect(ruleAt(full), `${full} after ${compact}`).toBeGreaterThan(
        ruleAt(compact),
      );
    }
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
