/**
 * compactLayout.ts — whether the header and transport bar are thin rows, readable
 * in React (Slice 27).
 *
 * Tailwind's `compact:` variant (`tailwind.config.js`) does the layout by itself:
 * on a phone held sideways, or upright at any height (since 2026-10-13), the
 * header's two buttons become 44 px icon boxes and their labels go `sr-only`.
 * This exists for the one thing CSS cannot do: a `title` on those two buttons,
 * repeating the label as a tooltip (ruled 2026-10-12) on exactly the screens
 * where the label is visually hidden. It is the same query, and
 * `layoutVariants.test.ts` pins the two to one compiled string, so a tooltip
 * cannot appear beside a visible label or be missing from an icon.
 *
 * A `matchMedia` subscription (`mediaQuery.ts`): it re-renders a component only
 * when the answer changes — a resize or a rotation across the line — never per
 * frame (rule 1). Where there is no `matchMedia` the answer is "not compact".
 */
import { useSyncExternalStore } from "react";
import { mediaQueryStore } from "./mediaQuery";

/**
 * At most 30rem tall, or under 40rem wide and portrait: exactly what
 * `compact:` compiles to.
 */
export const COMPACT_QUERY =
  "(max-height: 30rem), (max-width: 39.9375rem) and (orientation: portrait)";

const compact = mediaQueryStore(COMPACT_QUERY);

/** Whether `compact:` applies right now; re-renders only when that changes. */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(compact.subscribe, compact.matches, () => false);
}
