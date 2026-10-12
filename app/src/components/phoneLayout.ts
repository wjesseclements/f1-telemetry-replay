/**
 * phoneLayout.ts — whether the screen is laid out as a phone, readable in React
 * (Slice 26).
 *
 * The CSS needs no help: Tailwind's `phone:` variant (`tailwind.config.js`) puts
 * the overlay dialogs over the whole screen by itself. This exists for the one
 * thing CSS cannot do, making the rest of the page inert while one of them covers
 * it (`usePhoneModal`, `overlay.ts`). It is the same query, and
 * `layoutVariants.test.ts` pins the two to one compiled string, so the dialog
 * cannot be modal on a screen where it sits in the track cell, or the reverse.
 *
 * A `matchMedia` subscription through `useSyncExternalStore`. The value changes
 * only when the query's answer does — a resize or a rotation across the line —
 * so a component reading it re-renders then and at no other time: nothing here
 * runs per frame (rule 1). Where there is no `matchMedia` (jsdom, a server
 * render) the answer is "not a phone", as `motion.ts` answers for reduced motion.
 */
import { useSyncExternalStore } from "react";

/** Below `md`, or at most 30rem tall: exactly what `phone:` compiles to. */
export const PHONE_QUERY =
  "not all and (min-width: 768px), (max-height: 30rem)";

function phoneQuery(): MediaQueryList | null {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(PHONE_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const list = phoneQuery();
  if (list === null) return () => {};
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

function isPhone(): boolean {
  return phoneQuery()?.matches ?? false;
}

/** Whether `phone:` applies right now; re-renders only when that changes. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhone, () => false);
}
