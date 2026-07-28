/**
 * palette.ts — the design tokens, resolved into values a canvas can use.
 *
 * A 2D context takes colour strings, not CSS custom properties, so the token layer
 * in `index.css` has to be read out before it can be painted with. This module is
 * the ONE place that happens: components ask for `chrome.track`, never for a hex.
 *
 * The fallbacks exist because `getComputedStyle` resolves nothing useful under
 * jsdom (no cascade, no stylesheet applied to the element), and a canvas painted
 * with `""` silently paints black. They mirror `:root` in `index.css`, and are
 * deliberately kept here rather than duplicated per call site — one mirror is a
 * documented fallback, several are the scattered hex CLAUDE.md forbids.
 */

/** Token name → fallback, mirroring `:root` in `src/index.css`. */
const TOKENS = {
  bg: ["--c-bg", "#0a0d12"],
  line: ["--c-line", "#232a34"],
  trackFill: ["--c-track-fill", "#0e1218"],
} as const;

export type ChromeColors = { [K in keyof typeof TOKENS]: string };

/**
 * Read the chrome colours out of the document's token layer.
 *
 * Called once per canvas mount, not per frame: resolving computed style forces
 * style recalculation, which has no business happening inside an animation loop.
 */
export function readChromeColors(): ChromeColors {
  const root =
    typeof document === "undefined" ? null : document.documentElement;
  const style = root === null ? null : getComputedStyle(root);

  const resolve = (name: string, fallback: string): string => {
    const value = style?.getPropertyValue(name).trim();
    return value === undefined || value === "" ? fallback : value;
  };

  return {
    bg: resolve(...TOKENS.bg),
    line: resolve(...TOKENS.line),
    trackFill: resolve(...TOKENS.trackFill),
  };
}
