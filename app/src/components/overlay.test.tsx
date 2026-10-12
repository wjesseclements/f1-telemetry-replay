/**
 * The overlay dialogs' centring idiom (Slice 23) — FeaturedPanel and EventCard.
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
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EventCard } from "./EventCard";
import { FeaturedPanel } from "./FeaturedPanel";
import { OVERLAY_PHONE, OVERLAY_PINNED_BAR } from "./overlay";

afterEach(cleanup);

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

  it.each(DIALOGS)(
    "%s: centres the card with auto margins, which collapse to 0 when it overflows",
    (_, mount) => {
      mount();
      const card = screen.getByRole("dialog").firstElementChild;
      expect(card).toHaveClass("my-auto");
    },
  );
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
      // The gap under the row: a margin off a phone, the same size as padding
      // on one (inside the bar, so the pinned bar covers it too).
      mount();
      const { bar } = rowAndBar();
      const gap = /(?:^|\s)mb-(\d+)(?:\s|$)/.exec(bar.className)?.[1];
      expect(gap, "the bar's own margin off a phone").toBeDefined();
      expect(bar).toHaveClass("phone:mb-0", `phone:pb-${gap}`);
    },
  );
});
