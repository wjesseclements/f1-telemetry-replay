/**
 * overlay.ts — where the overlay dialogs sit on a phone (Slice 26).
 *
 * The gallery (`FeaturedPanel`) and the event card (`EventCard`) are scrims over
 * the track cell: `absolute inset-0`, inside the cell, so from `md` up the tower
 * and the transport bar stay beside them and usable. Below `md` (`phone:`,
 * `tailwind.config.js`) the track cell is the short part of the screen, so the
 * same scrim is positioned against the VIEWPORT instead and covers the header,
 * the tower and the transport bar too. Measured in headless Chrome at the
 * viewports iPhone Safari leaves the page:
 *
 *   - the gallery at 375x626 went from 216 px with no card whole to 626 px with
 *     three, and at 724x257 from 160 px with none to 257 px with one;
 *   - the event card at 724x257 had its Continue button 29.5 px below the
 *     clip, and at 375x626 its last 11 px cut. It is now whole at both, and at
 *     375x626 the track shows above it through the wash.
 *
 * While either one is open on a phone, nothing behind it takes a tap: not the
 * header (the toggle and "Load replay JSON"), the tower or the transport bar.
 * Close, Escape or a card is the way out, and focus returns where it did before.
 * The replay keeps animating behind the gallery's wash; the event card has
 * already paused it.
 *
 * Only `position` changes. The element stays where it is in the DOM, inside the
 * track cell after the memoised canvas. So opening and closing it still does not
 * re-render the canvas. The tab order is the same as on desktop too, so on a
 * phone, Tab off either end of the dialog lands on a control under the wash
 * (still non-modal: `aria-modal="false"`; an open question in Slice 26's PLAN
 * entry). Its `z-10` already paints over the header and the transport bar,
 * which are not positioned.
 *
 * `fixed` resolves against the viewport only while no ancestor has a
 * `transform`, `filter` or `contain`. None does. If one ever did, the overlay
 * would quietly go back into the cell on phones, and nothing in
 * `npm run check` would notice: the tests pin this class, not its geometry, and
 * every layout-check row passed with the overlay in the cell too.
 *
 * One string, so the two dialogs cannot drift apart.
 */
export const OVERLAY_PHONE = "phone:fixed";
