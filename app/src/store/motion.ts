/**
 * motion.ts — the one place the reduced-motion preference is read.
 *
 * `prefers-reduced-motion: reduce` is a request not to be shown ambient movement that
 * was not asked for. A replay that starts playing on load is exactly that, so the
 * preference turns AUTOPLAY off — not the feature. Play/pause, seek and the transport
 * all keep working; a reduced-motion visitor gets a still frame they can drive
 * themselves, which is the accessible experience, whereas disabling playback would
 * just be a broken one.
 */

/**
 * Whether the user has asked for reduced motion.
 *
 * Defaults to `false` when `matchMedia` is missing — jsdom has none, and neither
 * would a server render. Without the guard the transport store throws while it is
 * being constructed at import time, which takes the whole app (and every test that
 * imports it, transitively almost all of them) down with it.
 */
export function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
