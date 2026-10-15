/**
 * overlay.ts — where the overlay dialogs sit on a phone, and how they behave
 * there (Slice 26).
 *
 * The gallery (`FeaturedPanel`) and the event card (`EventCard`), and since
 * Slice 18 the corner card (`CornerCard`, in the event card's mould, its card
 * at the top rather than centred so that Next stays put), are scrims over the
 * track cell: `absolute inset-0`, inside the cell, so on a desktop the tower
 * and the transport bar stay beside them and usable. On a
 * phone — below `md`, or a screen at most 30rem tall (`phone:`,
 * `tailwind.config.js`) — the track cell is the short part of the screen, so
 * the same scrim is positioned against the VIEWPORT instead and covers the
 * header, the tower and the transport bar too.
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
 * event. The corner card's is gated the same way as the gallery's, in state D
 * ("corner card covers the viewport", Slice 18).
 */
import { useLayoutEffect, type RefObject } from "react";
import { inertOutside } from "./inertOutside";
import { usePhoneLayout } from "./phoneLayout";

/** Every overlay dialog's phone position: one string, so none can drift. */
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
 * it — `mb-N` off a phone; on one, padding and margin that add up to N — so the
 * row keeps its box to the pixel (the layout check's heading and Close rows read
 * the gallery's).
 *
 * It sticks at `-top-4` because a sticky box's `top` counts from inside the
 * dialog's 16 px padding (measured in Chrome: `top-0` pinned the row at y=16 and
 * the cards stayed visible, and TAPPABLE, in the 16 px above it). Pinned, its
 * `bg-panel` covers the strip from the top edge to the end of its padding under
 * the row, across the card's whole padding box: nothing scrolls into view above
 * Close, and a tap there lands on the bar instead of on a card no one can see.
 *
 * At rest it must paint nothing, and it is positioned, so it paints OVER the
 * card's content. Its paint is the card's own colour; the two places that is not
 * enough were measured in Chrome's screenshots. Square, its corners covered the
 * card's corner arcs; rounded to the card's inner 7 px they still shaded 16
 * anti-aliased border pixels, and to 8 px, 12. Rounded to 12 px (`xl`) they
 * stay clear of the border, and pinned they only ever sit over the card's padding
 * (its own colour). And a gap made all padding painted over the top of the
 * focused first card's ring (2 px offset + 2 px ring), so the gallery keeps 4 px
 * of its 12 as margin. With both, every phone panel screenshot at Safari's four
 * sizes is pixel-identical to the bar-less build's.
 *
 * Both dialogs use it. The gallery scrolls on every phone. The event card
 * scrolled at none of the 28 sizes measured as it opens, but a failed "Continue"
 * adds its error message, and then it scrolls on the short screens: at 724x257
 * Close ended 16 px above the top edge (Slice 26's PLAN entry has the sizes).
 */
export const OVERLAY_PINNED_BAR =
  "phone:sticky phone:-top-4 phone:-mx-4 phone:-mt-4 phone:rounded-t-xl phone:bg-panel phone:px-4 phone:pt-4";

/**
 * The pinned Close's hit box on a phone: at least 44x44 CSS px, the floor the
 * human ruled for the compact bars' controls (Slice 27, 2026-10-12: 44 pt, and a
 * CSS px is a point on an iPhone), applied here because once a phone panel is
 * scrolled this Close is the only way out on screen. As plain text in `px-2
 * py-1` its box was 49x24.5 px. A floor, not a size: Close is already wider than
 * 44, so only its height grows, and the row and the pinned bar with it. The box
 * IS the target, as in Slice 27: nothing reaches past it, so what a layout probe
 * measures with `getBoundingClientRect` is what a finger can hit. Off a phone
 * nothing changes.
 *
 * Measured in Chrome at Safari's four sizes and 814x312: Close 49.1x24.5 →
 * 49.1x44 px; the pinned bar 48.5 → 68 px (16 + 44 + 8), pinned at y=[0,68] with
 * Close at y=[16,60]; at rest every card sits 19.5 px lower. The event card
 * still opens whole: its least room was 34.5 px (724x257), and is now 15.
 */
export const OVERLAY_CLOSE_TARGET = "phone:min-h-11 phone:min-w-11";

/**
 * Where keyboard focus stops scrolling a phone dialog: below the pinned bar, not
 * under it (Slice 26 review). When focus moves to a control above the visible
 * part (Shift+Tab, or Tab wrapping from Close to the first card), the browser
 * scrolls it to the scrollport's top edge, and Chrome's focus scrolling ignores
 * a sticky header unless the scroller pads its top. Measured without this, in
 * headless Chrome with trusted keys and the 48.5 px bar: 24 of 191 Tab and
 * Shift+Tab stops left the focused card's title and the top of its ring under
 * the bar.
 *
 * The padding is the pinned bar, the focus ring and one pixel. The bar is its
 * top padding (1rem), its row, which is Close's touch floor (2.75rem), and its
 * bottom padding (0.5rem): 4.25rem, 68 px. The ring reaches 4 px past a card
 * (`FOCUS_RING`: a 2 px offset and a 2 px ring). And a focus scroll lands on a
 * whole pixel while the cards sit on half ones (166.5 px tall), so it can stop
 * half a pixel short: measured at exactly 72 px, two stops at 375x626 put 0.5
 * px of the ring under the bar. The rem part scales with the bar if the root
 * font size does; the px part is the ring's, which does not. On the dialog,
 * the scroller, not on the card. It moves nothing at rest: it only says where
 * a control scrolled to by focus comes to a stop.
 *
 * The corner card's Previous and Next sit straight under its bar (ruled
 * 2026-10-15), and its heading can be three lines, taller than Close: its bar
 * is then 76.5 px. So its steps carry a 12 px scroll margin of their own on
 * top of this (`CornerCard.tsx` has the sum).
 */
export const OVERLAY_FOCUS_CLEARANCE = "phone:scroll-pt-[calc(4.25rem+5px)]";

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
