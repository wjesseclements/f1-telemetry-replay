/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Design tokens are defined as CSS custom properties in src/index.css.
      // Tailwind maps to them so colors are referenced by name, never hard-coded hex.
      colors: {
        bg: "var(--c-bg)",
        panel: "var(--c-panel)",
        panel2: "var(--c-panel2)",
        line: "var(--c-line)",
        txt: "var(--c-txt)",
        dim: "var(--c-dim)",
        accent: "var(--c-accent)",
        throttle: "var(--c-throttle)",
        brake: "var(--c-brake)",
        drs: "var(--c-drs)",
        "tyre-soft": "var(--c-tyre-soft)",
        "tyre-medium": "var(--c-tyre-medium)",
        "tyre-hard": "var(--c-tyre-hard)",
        "tyre-inter": "var(--c-tyre-inter)",
        "tyre-wet": "var(--c-tyre-wet)",
        "flag-green": "var(--c-flag-green)",
        "flag-yellow": "var(--c-flag-yellow)",
        "flag-sc": "var(--c-flag-sc)",
        "flag-vsc": "var(--c-flag-vsc)",
        "flag-red": "var(--c-flag-red)",
      },
      fontFamily: {
        mono: ["ui-monospace", "SF Mono", "Menlo", "Consolas", "monospace"],
        sans: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
