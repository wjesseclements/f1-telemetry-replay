/**
 * towerReveal.ts — scroll the tower so one row is in view (Slice 26).
 *
 * The DOM half of `engine/reveal.ts`: read the list's and the row's layout, ask the
 * engine where the list should stand, and scroll the LIST there — nothing else.
 *
 * WHY `scrollTo` ON THE LIST, NOT `scrollIntoView` ON THE ROW
 * ----------------------------------------------------------
 * `scrollIntoView` scrolls every scrollable ancestor until the row is in the
 * viewport — the page included. The tower lives in a page that must not scroll
 * (Slice 23 measured one scrolling 350 px into blank space and fixed it), and on a
 * phone the visual viewport can pan under a pinch zoom, so "every ancestor" is
 * exactly the wrong reach for a list that only ever means its own scroll. A
 * `scrollTo` on the list cannot move anything but the list. (`scrollIntoView`'s
 * newer `container: "nearest"` option would confine it, but it is too recent to
 * rely on in the phone browsers this exists for.)
 *
 * WHY `offsetTop`, AND WHAT IT DEPENDS ON
 * --------------------------------------
 * Layout, not the painted box: a row can be mid-slide under a FLIP transform
 * (`towerFlip.ts`), and `getBoundingClientRect` would aim at where the slide is
 * rather than where the row will rest. `offsetTop` is measured from the row's
 * `offsetParent`, which is the list ONLY because the list is `relative` (Slice 23's
 * containment of the rows' `sr-only` text) — `Hud.test.tsx` pins that class for
 * both reasons. Whole px, which is what the rows are.
 */
import { revealOffset } from "../engine/reveal";

/**
 * Scroll `list` the least distance that shows `row` whole, or to the row's top when
 * it is taller than the list; a no-op when it is already in view.
 *
 * @param smooth animate the scroll. The caller passes `false` under
 *               `prefers-reduced-motion`, and the jump is then instant.
 */
export function revealRow(
  list: HTMLElement,
  row: HTMLElement,
  smooth: boolean,
): void {
  const top = revealOffset(
    {
      offset: list.scrollTop,
      size: list.clientHeight,
      content: list.scrollHeight,
    },
    { start: row.offsetTop, size: row.offsetHeight },
  );
  if (top === list.scrollTop) return;
  list.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
}
