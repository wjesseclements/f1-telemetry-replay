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
