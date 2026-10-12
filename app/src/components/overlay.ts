/**
 * overlay.ts — where the overlay dialogs sit on a phone, and how they behave
 * there (Slice 26).
 *
 * The gallery (`FeaturedPanel`) and the event card (`EventCard`) are scrims over
 * the track cell: `absolute inset-0`, inside the cell, so on a desktop the tower
 * and the transport bar stay beside them and usable. On a phone — below `md`, or
 * a screen at most 30rem tall (`phone:`, `tailwind.config.js`) — the track cell
 * is the short part of the screen, so the same scrim is positioned against the
 * VIEWPORT instead and covers the header, the tower and the transport bar too.
 * Measured in headless Chrome at the viewports iPhone Safari leaves the page:
 *
 *   - the gallery at 375x626 went from 216 px with no card whole to 626 px with
 *     three, and at 724x257 from 160 px with none to 257 px with one;
 *   - the event card at 724x257 had its Continue button 29.5 px below the
 *     clip, and at 375x626 its last 11 px cut. It is now whole at both, and at
 *     375x626 the track shows above it through the wash.
 *
 * While either one is open on a phone it is MODAL (ruled 2026-10-12;
 * `usePhoneModal`, below): the rest of the page is inert and the dialog says
 * `aria-modal="true"`, so Tab and a screen reader stay inside it and nothing
 * behind it takes a tap — not the header (the toggle and "Load replay JSON"),
 * the tower or the transport bar. Close, Escape or a card is the way out, and
 * focus returns where it did before. The replay keeps animating behind the
 * gallery's wash; the event card has already paused it. On a desktop neither is
 * modal: the tower and the transport bar beside the cell stay usable, as before.
 *
 * Only `position` changes. The element stays where it is in the DOM, inside the
 * track cell after the memoised canvas, so opening and closing it still does not
 * re-render the canvas. Its `z-10` already paints over the header and the
 * transport bar, which are not positioned.
 *
 * `fixed` resolves against the viewport only while no ancestor has a
 * `transform`, `filter` or `contain`. None does. If one ever did, the overlay
 * would go back into the cell on phones. The tests pin this class, not its
 * geometry; what measures the geometry is the layout check's "panel covers the
 * viewport" rows (Slice 26, ruled 2026-10-12): in states A and C, at every gated
 * phone-layout viewport, the gallery's box must be the viewport's within 1 px.
 * Nothing gates the event card's: the layout check never fires a scenario
 * event.
 */
import { useLayoutEffect, type RefObject } from "react";
import { inertOutside } from "./inertOutside";
import { usePhoneLayout } from "./phoneLayout";

/** Both dialogs' phone position. One string, so the two cannot drift apart. */
export const OVERLAY_PHONE = "phone:fixed";

/**
 * An overlay's heading row on a phone: a bar pinned to the top of the dialog
 * while the rest of the card scrolls under it (Slice 26, ruled 2026-10-12). Full
 * screen, the dialog scrolls itself, and once it did nothing on screen closed it:
 * Close scrolled away with the heading, the header's toggle is under the wash,
 * and a tap on the wash does nothing.
 *
 * It goes on a wrapper around the row, not on the row, so that at rest nothing
 * moves. The wrapper reaches over the card's padding with negative margins and
 * puts the same padding back, and the caller moves the row's bottom margin onto
 * it — `mb-N` off a phone, `phone:mb-0 phone:pb-N` on one — so the row keeps its
 * box to the pixel (the layout check's heading and Close rows read the
 * gallery's). It sticks at `-top-4` because a sticky box's `top` counts from
 * inside the dialog's 16 px padding (measured in Chrome: `top-0` pinned the row
 * at y=16 and the cards stayed visible, and TAPPABLE, in the 16 px above it).
 * Pinned, its `bg-panel` covers the strip from the top edge to the end of its
 * gap under the row, across the card's whole padding box: nothing scrolls into
 * view above Close, and a tap there lands on the bar instead of on a card no one
 * can see. At rest the same paint is the card's own colour, so nothing shows.
 *
 * Both dialogs use it. The gallery scrolls on every phone. The event card
 * scrolled at none of the 28 sizes measured as it opens, but a failed "Continue"
 * adds its error message, and then it scrolls on the short screens: at 724x257
 * Close ended 16 px above the top edge (Slice 26's PLAN entry has the sizes).
 */
export const OVERLAY_PINNED_BAR =
  "phone:sticky phone:-top-4 phone:-mx-4 phone:-mt-4 phone:bg-panel phone:px-4 phone:pt-4";

/**
 * Make an overlay dialog modal while it covers the whole screen (Slice 26, ruled
 * 2026-10-12): on a phone, everything outside `dialog` is inert for as long as it
 * is mounted (`inertOutside`); on a desktop nothing changes. Returns whether it
 * is modal, for the dialog's `aria-modal`.
 *
 * A LAYOUT effect, for the order it gives at both ends. On open, the page behind
 * is inert before any passive effect runs, so the dialog's own focus-on-open
 * lands with nothing behind it reachable. On close, its cleanup runs in the
 * commit that removes the dialog, before any passive cleanup, so the event
 * card's focus return (a passive cleanup) finds the page awake. The gallery's
 * focus return is `App`'s and runs outside React's commit; it commits the close
 * synchronously first (`flushSync`), which is what wakes the toggle it focuses.
 *
 * It re-runs only when the phone answer changes (`usePhoneLayout`: a resize or a
 * rotation across the line), never per frame.
 */
export function usePhoneModal(dialog: RefObject<HTMLElement>): boolean {
  const phone = usePhoneLayout();
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!phone || element === null) return;
    return inertOutside(element);
  }, [phone, dialog]);
  return phone;
}
