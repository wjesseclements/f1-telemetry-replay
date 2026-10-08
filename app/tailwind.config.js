/**
 * A design token as a Tailwind colour that takes an opacity modifier (`bg-bg/75`).
 *
 * Slice 23 (review item 7): a bare `var(--c-bg)` gives Tailwind nothing to put an
 * alpha into, and Tailwind 3 DROPS a modified class it cannot parse — no rule, no
 * warning. The 75% wash behind the gallery panel and the event card (Slice 13) and
 * the 70% provenance lines compiled to nothing. `<alpha-value>` is Tailwind's slot
 * for the modifier (1 when there is none); mixing with `transparent` applies it to
 * a token that stays a plain hex.
 *
 * Not the channel form Tailwind's docs show (`--c-bg: 10 13 18;` with
 * `rgb(var(--c-bg) / <alpha-value>)`): the tokens are also read RAW — the canvas
 * palette via `getComputedStyle` (`render/palette.ts`), SVG strokes, the
 * scrubber's flag gradient, `body` in index.css — and each needs a colour, not
 * three numbers. The canvas would break silently: the draw-call md5 runs on the
 * palette's fallbacks and never reads the token layer.
 *
 * Floor: `color-mix()` needs Chrome 111 / Safari 16.2 / Firefox 113, inside Vite 8's
 * default build target (Chrome 111 / Safari 16.4 / Firefox 114), so no browser the
 * build supports loses a colour. Guarded by `src/opacityModifiers.test.ts`.
 */
const token = (name) =>
  `color-mix(in srgb, var(--c-${name}) calc(<alpha-value> * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Design tokens are defined as CSS custom properties in src/index.css.
      // Tailwind maps to them so colors are referenced by name, never hard-coded hex.
      colors: {
        bg: token("bg"),
        panel: token("panel"),
        panel2: token("panel2"),
        line: token("line"),
        txt: token("txt"),
        dim: token("dim"),
        accent: token("accent"),
        throttle: token("throttle"),
        brake: token("brake"),
        drs: token("drs"),
        "tyre-soft": token("tyre-soft"),
        "tyre-medium": token("tyre-medium"),
        "tyre-hard": token("tyre-hard"),
        "tyre-inter": token("tyre-inter"),
        "tyre-wet": token("tyre-wet"),
        "flag-green": token("flag-green"),
        "flag-yellow": token("flag-yellow"),
        "flag-sc": token("flag-sc"),
        "flag-vsc": token("flag-vsc"),
        "flag-red": token("flag-red"),
      },
      fontFamily: {
        mono: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
        sans: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
