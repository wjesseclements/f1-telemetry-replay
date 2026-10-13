/**
 * touchTarget.ts — the size a finger needs, on the screens where the bars are thin.
 *
 * Slice 27 (ruled by the human, 2026-10-12): on a phone held sideways, or upright
 * at any height since 2026-10-13 (`compact:`, tailwind.config.js), the header and
 * the transport bar shrink to thin rows, and
 * every control in them keeps a hit target of at least 44x44 CSS px, "even if the
 * rows are a little taller". 44 is Apple's minimum (44 pt, and a CSS px is a point
 * on an iPhone) and WCAG 2.5.5's AAA size; Slice 26's draft used 24 px, 2.5.8's AA
 * minimum, and that was declined.
 *
 * One string, so every control in those rows gets the same floor and there is one
 * place to check it still exists — like the focus rings in `focus.ts`. A floor, not
 * a size: a control already wider (the 0.5× speed button) keeps its width. The box
 * IS the target: no pseudo-element reaches past it, so what a test or a layout
 * probe measures with `getBoundingClientRect` is what a finger can hit.
 *
 * The scrubber is the one control that does not use it: a range input needs its
 * own height and a background clipped to a thin track (`Scrubber.tsx`).
 */
export const TOUCH_TARGET = "compact:min-h-11 compact:min-w-11";
