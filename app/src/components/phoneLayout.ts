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
 * A `matchMedia` subscription (`mediaQuery.ts`): it re-renders a component only
 * when the answer changes — a resize or a rotation across the line — never per
 * frame (rule 1). Where there is no `matchMedia` the answer is "not a phone".
 */
import { useSyncExternalStore } from "react";
import { mediaQueryStore } from "./mediaQuery";

/** Below `md`, or at most 30rem tall: exactly what `phone:` compiles to. */
export const PHONE_QUERY =
  "not all and (min-width: 768px), (max-height: 30rem)";

const phone = mediaQueryStore(PHONE_QUERY);

/** Whether `phone:` applies right now; re-renders only when that changes. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(phone.subscribe, phone.matches, () => false);
}
