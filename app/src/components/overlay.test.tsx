/**
 * The overlay dialogs' centring idiom (Slice 23) — FeaturedPanel, EventCard, and
 * since Slice 18 the CornerCard, cast in the event card's mould.
 *
 * Each is a scroll container (`overflow-y-auto`) over the canvas cell, holding one
 * card. Centring that card with `align-items: center` splits any overflow between
 * the top and the bottom, and the overflow above the top edge is outside the scroll
 * range: at 1280x720 the panel's heading and Close button sat ~45 px above the clip
 * and no scroll position could bring them back (the Slice 23 finding, measured by
 * `npm run check:layout`). The fix is the safe idiom: cross-axis START on the
 * container, auto margins on the card — centred when it fits, scrolling from its
 * top when it does not.
 *
 * jsdom has no layout, so this pins the idiom, not the geometry. The geometry is
 * the layout check's — which never fires a scenario event, so for the event card
 * this is the only guard there is.
 *
 * The corner card keeps the safe half and drops the centring (ruled 2026-10-15,
 * "Move Previous/Next above the story"): its card sits at the top of its
 * scroller whether or not it fits, because a centred card's top moves by half
 * of every change in its height, and Next, under the heading, moved with it.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLore } from "../engine/lore";
import { LORE } from "../lore";
import { CornerCard } from "./CornerCard";
import { EventCard } from "./EventCard";
import { FeaturedPanel } from "./FeaturedPanel";
import { FOCUS_RING } from "./focus";
import {
  OVERLAY_CLOSE_TARGET,
  OVERLAY_FOCUS_CLEARANCE,
  OVERLAY_PHONE,
  OVERLAY_PINNED_BAR,
} from "./overlay";

afterEach(cleanup);

/** Real stories for the corner card: Monza's, from its own corner record. */
const STORIES = resolveLore(LORE[0].layouts[0].corners, LORE)?.stories ?? [];

const DIALOGS = [
  [
    "FeaturedPanel",
    () => render(<FeaturedPanel id="featured" onClose={() => {}} />),
  ],
  [
    "EventCard",
    () =>
      render(
        <EventCard
          event={{ clock: 1, title: "RED FLAG", body: "Narrated." }}
          next={null}
          onClose={() => {}}
        />,
      ),
  ],
  [
    "CornerCard",
    () =>
      render(
        <CornerCard
          stories={STORIES}
          index={STORIES.length - 1}
          onStep={() => {}}
          onClose={() => {}}
        />,
      ),
  ],
] as const;

describe("overlay dialogs centre their card safely", () => {
  it.each(DIALOGS)(
    "%s: never cross-axis-centres the card inside its own scroller",
    (_, mount) => {
      mount();
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveClass("overflow-y-auto");
      // `items-center` is the defect itself: an overflowing card's top is lost.
      expect(dialog).not.toHaveClass("items-center");
      expect(dialog).toHaveClass("items-start");
    },
  );

  it.each(DIALOGS.filter(([name]) => name !== "CornerCard"))(
    "%s: centres the card with auto margins, which collapse to 0 when it overflows",
    (_, mount) => {
      mount();
      const card = screen.getByRole("dialog").firstElementChild;
      expect(card).toHaveClass("my-auto");
    },
  );

  it("CornerCard: keeps its card at the top, so the card's top never moves between stories", () => {
    // Measured in Chrome: centred, Next moved by up to 39 px from one story to
    // the next even above the story; at the top it does not move.
    const [, mount] = DIALOGS[2];
    mount();
    const card = screen.getByRole("dialog").firstElementChild as HTMLElement;
    expect(card.className).not.toMatch(
      /(?:^|\s)(?:[a-z]+:)*m[ty]?-auto(?:\s|$)/,
    );
  });
});

/**
 * Where each dialog sits (Slice 26): over the track cell on a desktop, over the
 * whole screen on a phone (below `md`, or at most 30rem tall). jsdom evaluates no media query, so this pins the
 * classes; what `phone:` means is pinned in `layoutVariants.test.ts`, and the
 * geometry it buys was measured in a real Chrome (Slice 26's PLAN entry).
 */
describe("overlay dialogs cover the whole screen on a phone", () => {
  it.each(DIALOGS)(
    "%s: covers the track cell, and off a phone nothing more",
    (_, mount) => {
      mount();
      const dialog = screen.getByRole("dialog");
      // The desktop position, unchanged since Slice 13: absolute in the track cell.
      expect(dialog).toHaveClass("absolute", "inset-0", "z-10");
      // No unprefixed `fixed`: it would take the desktop dialog out of the cell too.
      expect(dialog).not.toHaveClass("fixed");
    },
  );

  it.each(DIALOGS)(
    "%s: on a phone, is positioned against the viewport instead",
    (_, mount) => {
      mount();
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveClass("phone:fixed");
      // The two dialogs share one string, so they cannot drift apart.
      expect(dialog.className).toContain(OVERLAY_PHONE);
    },
  );
});

/**
 * Each dialog's heading row on a phone (Slice 26, ruled 2026-10-12): pinned at
 * the top of the full-screen dialog while the rest scrolls, so Close never
 * scrolls away. jsdom has no layout or sticky positioning, so this pins the
 * structure; the geometry (pinned at y=16, the strip above it covered) was
 * measured in Chrome (Slice 26's PLAN entry).
 */
describe("each dialog's heading row is pinned on a phone", () => {
  /** The row holding the heading and Close, and the bar around it. */
  const rowAndBar = () => {
    const row = screen.getByRole("heading").parentElement as HTMLElement;
    return { row, bar: row.parentElement as HTMLElement };
  };

  it.each(DIALOGS)(
    "%s: wraps the heading and Close in the pinned bar",
    (_, mount) => {
      mount();
      const { row, bar } = rowAndBar();
      expect(bar.className).toContain(OVERLAY_PINNED_BAR);
      expect(bar).toHaveClass("phone:sticky");
      expect(
        within(row).getByRole("button", { name: /^close$/i }),
      ).toBeVisible();
    },
  );

  it.each(DIALOGS)(
    "%s: leaves the row itself unpositioned and unspaced, so its box never moves",
    (_, mount) => {
      // The layout check reads the gallery ROW's box (the heading's parent) for
      // its heading and Close rows; the bar around it is what sticks.
      mount();
      const { row } = rowAndBar();
      expect(row.className).not.toMatch(
        /sticky|fixed|absolute|\bm[tbxy]?-|\bp[tbxy]?-/,
      );
    },
  );

  it.each(DIALOGS)(
    "%s: gives the pinned Close a 44x44 px hit box on a phone, and nothing off one",
    (_, mount) => {
      // Once a phone panel is scrolled, the pinned Close is the only way out on
      // screen, so it gets the 44 pt floor ruled for the compact bars (Slice 27):
      // a minimum height and width of step 11, 11 x 4 px = 44 px, a floor and not
      // a size. As text it measured 49.1x24.5 px; now 49.1x44 on a phone.
      mount();
      const { row } = rowAndBar();
      const close = within(row).getByRole("button", { name: /^close$/i });
      expect(close.className).toContain(OVERLAY_CLOSE_TARGET);
      expect(close).toHaveClass("phone:min-h-11", "phone:min-w-11");
      // Only under `phone:`: a desktop Close keeps its 24.5 px row.
      expect(close.className).not.toMatch(/(?:^|\s)min-[hw]-/);
    },
  );

  it("leaves the gallery's first-card focus ring outside the bar", () => {
    // The focus ring (FOCUS_RING: a 2 px offset and a 2 px ring) reaches 4 px
    // above the focused card, and the first card is focused on open. The bar is
    // positioned, so it paints over whatever it overlaps: those 4 px stay margin.
    render(<FeaturedPanel id="featured" onClose={() => {}} />);
    const { bar } = rowAndBar();
    expect(bar).toHaveClass("phone:mb-1");
  });

  it("leaves the corner card's Previous/Next focus ring outside the bar", () => {
    // The same 4 px, for the steps straight under the corner card's bar
    // (ruled 2026-10-15). Measured in Chrome at 375x812 with no margin: the
    // top of a focused Next's ring was painted over by the bar.
    const [, mount] = DIALOGS[2];
    mount();
    const { bar } = rowAndBar();
    expect(bar).toHaveClass("phone:mb-1");
    expect(bar.nextElementSibling).toContainElement(
      screen.getByRole("button", { name: "Previous" }),
    );
  });

  it.each(DIALOGS)(
    "%s: pays back every px the bar borrows, so at rest nothing moves",
    (_, mount) => {
      // Negative margins reach over the card's padding; the same padding puts
      // the row back.
      const classes = OVERLAY_PINNED_BAR.split(" ");
      for (const [borrowed, repaid] of [
        ["phone:-mt-4", "phone:pt-4"],
        ["phone:-mx-4", "phone:px-4"],
      ]) {
        expect(classes, borrowed).toContain(borrowed);
        expect(classes, repaid).toContain(repaid);
      }
      // The gap under the row: a margin off a phone; on one, the same total
      // split between the bar's padding (covered when pinned) and its margin.
      mount();
      const { bar } = rowAndBar();
      const step = (re: RegExp) => Number(re.exec(bar.className)?.[1] ?? NaN);
      const gap = step(/(?:^|\s)mb-(\d+)(?:\s|$)/);
      const margin = step(/(?:^|\s)phone:mb-(\d+)(?:\s|$)/);
      const padding = step(/(?:^|\s)phone:pb-(\d+)(?:\s|$)/);
      expect(gap, "the bar's own margin off a phone").toBeGreaterThan(0);
      expect(margin + padding).toBe(gap);
    },
  );
});

/**
 * Keyboard focus stops BELOW the pinned bar on a phone (Slice 26 review). Focus
 * moving up the dialog (Shift+Tab, or Tab wrapping from Close to the first card)
 * scrolls the focused control to the scrollport's top edge, which the sticky bar
 * covers, unless the dialog pads its scrollport's top by the bar and the focus
 * ring. jsdom has no layout and no focus scrolling, so this pins the arithmetic,
 * read from the classes themselves; Chrome measured the result (no stop under
 * the bar, at five phone sizes; Slice 26's PLAN entry). On a phone:
 *
 *     the bar's top padding                     16 px   (step 4, 1rem)
 *   + its row: Close's touch floor              44 px   (step 11, 2.75rem)
 *   + the bar's bottom padding                   8 px   (step 2, 0.5rem)
 *   = the pinned bar                            68 px   (4.25rem; measured y=[0,68])
 *   + the focus ring past a card: 2 offset + 2   4 px   (FOCUS_RING)
 *   + a focus scroll's half-pixel snap           1 px   (measured: 0.5 px short)
 *   = the scrollport's top padding              73 px   (4.25rem + 5px)
 */
describe("keyboard focus stops below the pinned bar on a phone", () => {
  /** The number captured by `re` in `className`, or NaN. */
  const read = (className: string, re: RegExp, group = 1): number =>
    Number(re.exec(className)?.[group] ?? NaN);

  it.each(DIALOGS)(
    "%s: pads its scrollport's top by the pinned bar plus the focus ring",
    (_, mount) => {
      mount();
      const dialog = screen.getByRole("dialog");
      const row = screen.getByRole("heading").parentElement as HTMLElement;
      const bar = row.parentElement as HTMLElement;
      const close = within(row).getByRole("button", { name: /^close$/i });
      // Tailwind's spacing step n is n x 4 px (0.25rem); ring widths are px.
      const barTop = 4 * read(bar.className, /(?:^|\s)phone:pt-(\d+)(?:\s|$)/);
      const rowHeight =
        4 * read(close.className, /(?:^|\s)phone:min-h-(\d+)(?:\s|$)/);
      const barBottom =
        4 * read(bar.className, /(?:^|\s)phone:pb-(\d+)(?:\s|$)/);
      const ring =
        read(FOCUS_RING, /focus-visible:ring-(\d+)(?:\s|$)/) +
        read(FOCUS_RING, /focus-visible:ring-offset-(\d+)(?:\s|$)/);
      const clearance =
        /(?:^|\s)phone:scroll-pt-\[calc\((\d+(?:\.\d+)?)rem\+(\d+)px\)\](?:\s|$)/;
      // The rem part is the bar, so it scales with it; the px part, the ring's.
      const barPart = 16 * read(dialog.className, clearance, 1);
      const pxPart = read(dialog.className, clearance, 2);

      expect(dialog.className).toContain(OVERLAY_FOCUS_CLEARANCE);
      expect([barTop, rowHeight, barBottom, ring]).toEqual([16, 44, 8, 4]);
      expect(barPart).toBe(barTop + rowHeight + barBottom);
      expect(pxPart).toBe(ring + 1);
      // Only under `phone:`: off a phone no bar is pinned, nothing to clear.
      expect(dialog.className).not.toMatch(/(?:^|\s)scroll-p/);
    },
  );

  /**
   * The corner card's Previous and Next sit straight under its bar (ruled
   * 2026-10-15), and on a circuit with second names its heading is three lines,
   * taller than Close's 44 px, so its bar is taller than the clearance above
   * allows for. The steps add a scroll margin of their own. Measured in Chrome
   * at 724x257, a card scrolled to its end and a trusted Tab from Close: without
   * it, 8 px of Previous's box and ring went under the bar; with it, none.
   *
   *     the dialog's clearance (above)              73 px
   *   + the steps' scroll margin                    12 px   (step 3)
   *   = where a focus scroll stops a step           85 px
   *
   *     the bar's top padding                       16 px
   *   + the heading: the eyebrow line             16.5 px   (11 px x the root 1.5)
   *   +              the name line                  20 px   (`text-sm`'s 1.25rem)
   *   +              the second-name line           16 px   (`min-h-4`)
   *   + the bar's bottom padding                     8 px
   *   + the focus ring, and a half-pixel snap        5 px
   *   = what it must clear                        81.5 px
   */
  it("CornerCard: stops a focus scroll on Previous or Next below its taller bar", () => {
    const [, mount] = DIALOGS[2];
    mount();
    const dialog = screen.getByRole("dialog");
    const heading = screen.getByRole("heading");
    const secondLine = heading.querySelectorAll("[aria-hidden]")[2];
    const clearance =
      /(?:^|\s)phone:scroll-pt-\[calc\((\d+(?:\.\d+)?)rem\+(\d+)px\)\](?:\s|$)/;
    const stop =
      16 * read(dialog.className, clearance, 1) +
      read(dialog.className, clearance, 2);
    for (const name of ["Previous", "Next"]) {
      const button = screen.getByRole("button", { name });
      const margin =
        4 * read(button.className, /(?:^|\s)phone:scroll-mt-(\d+)(?:\s|$)/);
      const lineHeight =
        4 * read(secondLine.className, /(?:^|\s)min-h-(\d+)(?:\s|$)/);
      expect([stop, margin, lineHeight]).toEqual([73, 12, 16]);
      expect(stop + margin).toBeGreaterThanOrEqual(
        16 + 16.5 + 20 + lineHeight + 8 + 5,
      );
    }
  });
});
