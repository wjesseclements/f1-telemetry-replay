/**
 * mediaQuery.ts — a CSS media query's answer, as something React can subscribe
 * to (Slice 26's `usePhoneLayout`, shared in Slice 27).
 *
 * For the few things CSS cannot do by itself: making the page inert behind a
 * full-screen dialog (`phoneLayout.ts`), and a `title` attribute that only some
 * screens should carry (`compactLayout.ts`). Each such query is a copy of a
 * Tailwind variant's, and `layoutVariants.test.ts` pins every copy to the string
 * the variant compiles to.
 *
 * A `matchMedia` subscription for `useSyncExternalStore`. The answer changes
 * only when the query's does — a resize or a rotation across the line — so a
 * component reading it re-renders then and at no other time: nothing here runs
 * per frame (rule 1). Where there is no `matchMedia` (jsdom, a server render)
 * the answer is "no", as `motion.ts` answers for reduced motion.
 *
 * The store is made once per query, at module scope, so `subscribe` and
 * `matches` keep their identity across renders and React never resubscribes.
 */
export interface MediaQueryStore {
  /** Calls `onChange` whenever the query's answer may have changed. */
  subscribe(onChange: () => void): () => void;
  /** Whether the query matches right now. */
  matches(): boolean;
}

export function mediaQueryStore(query: string): MediaQueryStore {
  const list = (): MediaQueryList | null =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query)
      : null;
  return {
    subscribe(onChange) {
      const l = list();
      if (l === null) return () => {};
      l.addEventListener("change", onChange);
      return () => l.removeEventListener("change", onChange);
    },
    matches: () => list()?.matches ?? false,
  };
}
