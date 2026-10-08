/**
 * opacityModifiers.test.ts — every opacity-modified colour class compiles to CSS.
 *
 * Slice 23 (review item 7): `bg-bg/75` — the 75% wash behind the gallery panel and
 * the event card (Slice 13: "a plain wash, no backdrop blur") — and text-dim at 70% —
 * the provenance lines meant to recede — compiled to NOTHING. Every colour in
 * `tailwind.config.js` was a bare `var(--c-…)`, Tailwind 3 cannot put an alpha into
 * a colour it cannot parse, and it drops such a class without a word: no rule, no
 * warning. The panel sat on the full-brightness track, the provenance out-shone the
 * line above it, and nothing anywhere said so. (Once it compiled, 70% measured
 * 3.45:1 — under WCAG AA — and was ruled up to 90%, 4.82:1, on 2026-10-08.)
 *
 * jsdom applies no stylesheet, so no component test can see a missing rule. The
 * stylesheet itself can: `?inline` returns `index.css` compiled by the real pipeline
 * — `postcss.config.js`, the real Tailwind config and content globs, what
 * `vite build` ships (it needs `test.css`, which `vite.config.ts` turns on). Every
 * opacity-modified colour class in the shipped sources must have a rule in it.
 *
 * Tailwind's content glob scans THIS file too, and every class it can compile here
 * ships in the app's CSS. So no class below is spelled out unless a component
 * already uses it; the scanner's sample is assembled from fragments instead.
 */
import { describe, expect, it } from "vitest";
import css from "./index.css?inline";

/** The shipped sources — what Tailwind's `./src/**` content glob scans, less tests. */
const SOURCES = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./test/**"],
  { query: "?raw", import: "default", eager: true },
);

/**
 * A colour utility with an opacity modifier, numeric or arbitrary: `bg-bg/75`,
 * `text-dim/90`. Matched as the BASE class — a variant prefix is left off, because
 * a variant compiles only if its base does. Fractions on non-colour utilities
 * (widths, insets) and arbitrary values (`text-[10px]`) do not match.
 */
const MODIFIED_COLOR =
  /(?<![\w/.-])(?:bg|text|border(?:-[xytrblse])?|divide|outline|ring(?:-offset)?|fill|stroke|from|via|to|decoration|accent|caret|placeholder|shadow)-[a-z][a-z0-9-]*\/(?:\d+|\[[^\]\s]+\])(?![\w/.-])/g;

const modifiedColorClasses = (text: string): string[] => [
  ...new Set(text.match(MODIFIED_COLOR) ?? []),
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether the compiled CSS has a rule for `cls`, alone or under a variant: the
 * escaped class preceded by `.` or by a variant's escaped colon, never by a bare
 * `:` — so `display: flex` is not mistaken for the `flex` utility. Tailwind escapes
 * every non-identifier character in a selector with a backslash.
 */
function hasRule(cls: string): boolean {
  const selector = cls.replace(/[^\w-]/g, "\\$&");
  return new RegExp(
    `(?:\\.|\\\\:)${escapeRegExp(selector)}(?![\\w\\\\-])`,
  ).test(css);
}

describe("opacity-modified colour classes", () => {
  it("are found by the scanner, under a variant too, and nothing else is", () => {
    // Pins the scanner, so the real assertion below cannot pass by finding nothing.
    // Fragments, not literals, wherever a literal would be a class no component
    // uses — see the header.
    const arbitrary = "text-dim" + "/[0.7]";
    const sample = [
      "bg-bg/75",
      "hover:" + "text-dim/90",
      arbitrary,
      "w-" + "1/2",
      "text-[10px]",
      "bg-bg",
    ].join(" ");
    expect(modifiedColorClasses(sample)).toEqual([
      "bg-bg/75",
      "text-dim/90",
      arbitrary,
    ]);
  });

  it("compile to a rule wherever the shipped sources use one", () => {
    // A compile that scanned no content would fail every class below with a
    // misleading name; say what actually happened instead. Tailwind 3 resolves
    // content globs against the working directory: run vitest from app/.
    expect(hasRule("flex"), "Tailwind generated no utilities").toBe(true);
    expect(Object.keys(SOURCES).length).toBeGreaterThan(0);

    const missing = Object.entries(SOURCES).flatMap(([file, text]) =>
      modifiedColorClasses(text)
        .filter((cls) => !hasRule(cls))
        .map((cls) => `${cls} in ${file}`),
    );
    expect(missing).toEqual([]);
  });
});
