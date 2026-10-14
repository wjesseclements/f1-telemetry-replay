/**
 * reveal.ts — where a scrolling list has to stand to show one of its items.
 *
 * The timing tower scrolls whenever the field is taller than the space it is given,
 * and the focused car's readout sorts wherever that car runs. So on every phone the
 * one block a viewer came to read was cut: with 22 cars, LEC third on the red flag's
 * grid showed 127 of 194 px at 375x626 and 76 of 227 px at 724x257 (Slice 26,
 * headless Chrome). The tower now brings the focused block into view when the focus
 * moves to it; this is the arithmetic, one axis, in the list's own coordinates.
 *
 * NEAREST, AND THE BLOCK'S TOP WHEN IT CANNOT FIT
 * -----------------------------------------------
 * Chosen by measurement against `scrollIntoView`'s `start` (PLAN, Slice 26):
 *
 *  - **`start` hides the field for nothing.** Pinning the block to the top of the
 *    list scrolls every car ahead of it away even where the block already fits:
 *    at 1280x720 and 1440x900 LEC was whole with P1 and P2 above it, and `start`
 *    moved the list 68 px to show the same block without them. At 667x375 it hid
 *    P2 as well as P1 (68 px against 33). The order is the point of a tower
 *    (Hud.tsx), so the rows ahead are worth keeping whenever they can be kept.
 *  - **`nearest` is the least movement, which is right whenever the block fits:**
 *    nothing if it is already whole (the desktop sizes stay exactly as they were),
 *    and just far enough otherwise.
 *  - **But a block taller than the list cannot be whole,** and there the native
 *    rule aligns whichever edge is nearer: it can show the bottom of a block whose
 *    top is above the list, or leave a block that spans the list where it is. The
 *    top of the block is the driver, the focus tag and the speed — what a viewer
 *    reads first — so a block that cannot fit always shows its top. (724x257's
 *    144 px list against a 227 px block, and 844x390's 261 against 300.)
 *
 * HOLD, THEN REVEAL
 * -----------------
 * The same commit that opens the new block closes the old one, so the new row can
 * move before any scroll happens. `holdOffset` first puts it back where the viewer
 * saw it; `revealOffset` then moves the least distance from THERE.
 *
 * Pure: plain numbers in, one offset out. The caller reads the DOM and scrolls.
 */

/** A scrolling container along one axis, in px. */
export interface Scrollport {
  /** How far the content is scrolled (`scrollTop`). */
  offset: number;
  /** The visible length (`clientHeight`). */
  size: number;
  /** The whole content's length (`scrollHeight`). */
  content: number;
}

/** One item inside that container, in px, measured from the content's start. */
export interface ItemSpan {
  /** The item's start edge (`offsetTop` against the scrolling list). */
  start: number;
  /** The item's length (`offsetHeight`). */
  size: number;
}

/**
 * The scroll offset that reveals `item` in `port`: unchanged when it is already
 * whole, the least movement that makes it whole when it fits, and its start edge
 * at the top of the port when it does not. Clamped to the offsets the port can
 * actually take, so a result equal to `port.offset` means "do not scroll".
 */
export function revealOffset(port: Scrollport, item: ItemSpan): number {
  const end = item.start + item.size;
  let target = port.offset;
  if (item.size >= port.size || item.start < port.offset) {
    target = item.start;
  } else if (end > port.offset + port.size) {
    target = end - port.size;
  }
  return clampOffset(port, target);
}

/**
 * The scroll offset that keeps an item where the viewer last saw it after the
 * content moved under it: the port moves by exactly as far as the item moved.
 *
 * A focus change closes one readout and opens another in the same commit, so every
 * row below the old block moves up by the height it loses. Without this, the row
 * a viewer had just clicked jumped 161-195 px from under the finger before the
 * reveal could glide anywhere (Slice 26, headless Chrome without scroll anchoring,
 * which is how the tower list now runs).
 *
 * Only for an item that was ON SCREEN — its start inside the port, or above it by
 * less than `reach` (the item's own first line, so a row clicked on its lower half
 * still counts): holding an item nobody could see would move everything that was
 * visible, to keep still something that was not. Otherwise, and when nothing
 * moved, `port.offset` back, meaning "do not scroll".
 *
 * @param seen  the item's start when the viewer last saw it.
 * @param now   its start in the content as it is now.
 * @param reach how far above the port the item's start may be and still count as
 *              seen.
 */
export function holdOffset(
  port: Scrollport,
  seen: number,
  now: number,
  reach: number,
): number {
  const onScreen = seen > port.offset - reach && seen < port.offset + port.size;
  return onScreen ? clampOffset(port, port.offset + now - seen) : port.offset;
}

/** `offset` limited to the offsets `port` can actually take. */
function clampOffset(port: Scrollport, offset: number): number {
  const max = Math.max(0, port.content - port.size);
  return Math.min(Math.max(offset, 0), max);
}
