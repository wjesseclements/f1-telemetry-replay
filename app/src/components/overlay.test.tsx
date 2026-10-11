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
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EventCard } from "./EventCard";
import { FeaturedPanel } from "./FeaturedPanel";
import { OVERLAY_PHONE } from "./overlay";

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
 * Where each dialog sits (Slice 26): over the track cell from `md` up, over the
 * whole screen on a phone. jsdom evaluates no media query, so this pins the
 * classes; what `phone:` means is pinned in `layoutVariants.test.ts`, and the
 * geometry it buys was measured in a real Chrome (Slice 26's PLAN entry).
 */
describe("overlay dialogs cover the whole screen on a phone", () => {
  it.each(DIALOGS)(
    "%s: covers the track cell, and from `md` up nothing more",
    (_, mount) => {
      mount();
      const dialog = screen.getByRole("dialog");
      // The md+ position, unchanged since Slice 13: absolute in the track cell.
      expect(dialog).toHaveClass("absolute", "inset-0", "z-10");
      // No unprefixed `fixed`: it would take the md+ dialog out of the cell too.
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
