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
