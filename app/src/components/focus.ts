/**
 * focus.ts — one definition of "this control is focused".
 *
 * A visible focus indicator is a requirement, not a preference (PLAN.md Slice 5), and
 * the way it gets lost is `outline: none` scattered across components with no
 * replacement. Keeping the ring in one exported string means every control gets the
 * same one and there is a single place to check that it still exists.
 *
 * `focus-visible` rather than `focus`, so a mouse click does not leave a ring behind
 * but a Tab press does. The colour is the existing `--c-accent` token via Tailwind.
 */
export const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/**
 * The same ring, driven by a `peer` sibling's focus instead of the element's own.
 *
 * For controls whose real focusable element is visually replaced by something else —
 * a file input behind its label. The input stays in the tab order and keeps its
 * native keyboard activation; the ring just moves to the thing that is actually
 * visible. Hiding the input with `display:none` would take it out of the tab order
 * altogether, which is the usual way this pattern goes wrong.
 */
export const PEER_FOCUS_RING =
  "peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg";

/**
 * The rings above, drawn INSIDE the control on a compact screen's thin rows (Slice 27).
 *
 * There a control's 44 px box fills its row (`touchTarget.ts`): the header's buttons
 * touch the top of the screen and a landscape transport bar's touch the bottom, so a
 * ring 2 px outside the box was cut off by the screen edge, and in the transport bar
 * it drew over the tower above. Inset, it stays whole inside the box. Added beside
 * `FOCUS_RING` / `PEER_FOCUS_RING`, never instead of them: every other screen keeps
 * the ring outside, in the accent.
 *
 * White (`--c-txt`) rather than the accent (ruled 2026-10-12). Inset, an accent
 * ring drew a yellow box just inside the border, which is what the selected speed
 * button's accent border looks like, so a focused button read as a selected one.
 */
export const COMPACT_FOCUS_RING =
  "compact:focus-visible:ring-inset compact:focus-visible:ring-offset-0 compact:focus-visible:ring-txt";
export const COMPACT_PEER_FOCUS_RING =
  "compact:peer-focus-visible:ring-inset compact:peer-focus-visible:ring-offset-0 compact:peer-focus-visible:ring-txt";

/**
 * A corner-story badge's focus ring (Slice 18), drawn INSIDE its tap area.
 *
 * The badges' buttons are invisible squares over the discs the canvas paints, up
 * to 44 px a side (`engine/loreTargets.ts`), and a square near an edge of the
 * canvas reaches it: a ring 2 px outside, as `FOCUS_RING` draws, would be cut off
 * there by the canvas layer's clip. Inset and white (`--c-txt`), as on the compact
 * bars (`COMPACT_FOCUS_RING`, ruled 2026-10-12), it stays whole inside the square
 * and is not mistaken for a selected state.
 *
 * `group/badge` names the button for its member squares: a story over several
 * corner numbers (Maggotts, Becketts and Chapel) is one tab stop, and its other
 * squares ring with it (`BADGE_MEMBER_FOCUS_RING`), so a keyboard visitor sees
 * every number the press will open.
 */
export const BADGE_FOCUS_RING =
  "group/badge outline-none ring-inset focus-visible:ring-2 focus-visible:ring-txt";
/** `BADGE_FOCUS_RING` on a story's other squares, driven by its button. */
export const BADGE_MEMBER_FOCUS_RING =
  "ring-inset group-focus-visible/badge:ring-2 group-focus-visible/badge:ring-txt";

/**
 * A corner-story badge under a mouse (Slice 18): a faint wash over the square,
 * and over every other square of its story (`BADGE_MEMBER_HOVER`; hovering a
 * member hovers its button too). Only where the primary pointer can hover, so a
 * tap on a phone does not leave a square lit. A wash rather than a ring, so it
 * never competes with the focus ring on a focused badge under the pointer.
 */
export const BADGE_HOVER = "[@media(hover:hover)]:hover:bg-txt/10";
export const BADGE_MEMBER_HOVER =
  "[@media(hover:hover)]:group-hover/badge:bg-txt/10";
