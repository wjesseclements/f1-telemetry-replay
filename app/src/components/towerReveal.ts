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
import { holdOffset, revealOffset, type Scrollport } from "../engine/reveal";

/**
 * Scroll `list` the least distance that shows `row` whole, or to the row's top when
 * it is taller than the list; a no-op when it is already in view.
 *
 * @param smooth animate the scroll. The caller passes `false` under
 *               `prefers-reduced-motion`, and the jump is then instant.
 *
 * The instant jump is asked for as `"auto"`, not `"instant"` (Slice 26's review).
 * `"auto"` takes the list's CSS `scroll-behavior`, and none is set anywhere
 * (`Hud.reveal.test.tsx` pins the stylesheet free of it), so it jumps exactly as
 * `"instant"` would. Every browser's `ScrollBehavior` has `"auto"`; whether every
 * Safari the build targets accepts `"instant"` could not be shown here, and a
 * browser that rejects a dictionary's enum value throws a TypeError — from a
 * layout effect, which would take the tower down with it.
 */
export function revealRow(
  list: HTMLElement,
  row: HTMLElement,
  smooth: boolean,
): void {
  const top = revealOffset(portOf(list), {
    start: row.offsetTop,
    size: row.offsetHeight,
  });
  if (top === list.scrollTop) return;
  list.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

/**
 * Scroll `list` instantly by however far this commit moved `row` inside it, so the
 * row stays where the viewer last saw it — if it was on screen. Not motion: it is
 * what keeps a clicked row still under the finger while the readout above it
 * closes, so it runs under `prefers-reduced-motion` too.
 *
 * @param seenTop the row's top at the previous commit, in the list's coordinates
 *                (`towerFlip`'s cache), or `undefined` when there is none (a new
 *                replay: nothing was seen to hold).
 */
export function holdRow(
  list: HTMLElement,
  row: HTMLElement,
  seenTop: number | undefined,
): void {
  if (seenTop === undefined) return;
  // The same coordinates as the cache: the box's top from where the list's
  // content starts on screen.
  const origin = list.getBoundingClientRect().top - list.scrollTop;
  const line = row.firstElementChild; // the row's header line, focused or not
  const top = holdOffset(
    portOf(list),
    seenTop,
    row.getBoundingClientRect().top - origin,
    line instanceof HTMLElement ? line.offsetHeight : 0,
  );
  if (top !== list.scrollTop) list.scrollTop = top;
}

function portOf(list: HTMLElement): Scrollport {
  return {
    offset: list.scrollTop,
    size: list.clientHeight,
    content: list.scrollHeight,
  };
}
