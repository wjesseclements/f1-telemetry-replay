import defaultTheme from "tailwindcss/defaultTheme";
import plugin from "tailwindcss/plugin";

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

/**
 * A screen at least 5:4 wide (Slice 25). Its height is the scarce resource.
 *
 * Below `md` the page stacked whatever the shape, so a 667x375 phone gave the track
 * 126 px and the tower 59. Stacked against side by side below `md`, with the same
 * header in both, the circuit draws larger side by side at every width once the
 * screen is 5:4 or wider. The worst case is the gallery's widest circuit (Monza,
 * 2:1 on screen) at 767 px, beside the 256 px sub-md sidebar: at 5:4 it draws 419
 * px wide side by side against 410 stacked; at 6:5 stacking wins, 460 against 419;
 * the crossover is about 1.24 (measured through buildScene and fitTransform). With
 * candidate B's 224 px sidebar the 5:4 margin was 41 px; the shipped 256 px one keeps
 * 9. A rounder circuit crosses over
 * sooner (the 1-car fixture already wins at 1:1). The tower always gains, because
 * side by side it gets the region's whole height instead of a 40% strip.
 *
 * Every portrait screen (a phone is about 0.46–0.56) stays stacked exactly as
 * before. Every landscape phone (16:9 is 1.78) goes side by side, and so do short
 * desktop windows and a small tablet's split-screen half (600x480). A near-square
 * narrow window, such as a landscape phone's split-screen half (457x412), stays
 * stacked, as it was before.
 */
const WIDE = "(min-aspect-ratio: 5/4)";

/**
 * A screen at most 43.75rem (700 px) tall (Slice 25): the short portrait phones,
 * 375x667 and 360x640, which `WIDE` misses. The header's meta line lists every
 * driver, so a full field wrapped the header to 106–138 px there, and the track
 * paid for it: one line took 375x667 with 22 cars from 200 to 256 px of track,
 * and made 360x640's one-car readout whole (measured on candidate C). 375x812 and
 * 390x844 are taller; `UPRIGHT_PHONE` keeps their line to one row instead (Slice
 * 27). Short desktop windows (1366x657) match too, but they are already `WIDE`.
 */
const SHORT = "(max-height: 43.75rem)";

/**
 * A phone held upright: under 40rem (640 px) wide AND portrait, at any height.
 * `COMPACT`'s upright clause, and the third case of `onerow:`.
 *
 * At most 43.75rem (`SHORT`) tall in Slice 27's first cut, which caught Safari's
 * upright 375x626 and ~390x664 and the short phones (375x667, 360x640). Then at
 * most 50rem (800 px), ruled 2026-10-12, for the installed app held upright
 * (~375x734 to ~390x797, estimated) and a Pro Max upright in Safari (~430x752,
 * ~440x776, estimated; 430 and 440 px are well under the 640 px line): 22-car
 * track 375x734 267 → 334 px, 375x768 301 → 355, 390x797 330 → 372, 430x752
 * 301 → 345, 440x776 325 → 359, and one loss, the one-car boot view at 430x752,
 * 376 → 356 (its 44 px buttons no longer share a row with the clocks, so the
 * transport bar takes three rows, 75 → 133 px). The height bound went entirely
 * on 2026-10-13 (ruled): every upright phone gets the thin rows, so the
 * taller-than-800 px ones no longer keep 26–33 px controls in a header wrapped
 * to 82–138 px. Measured, header 138 → 44 and transport 109 → 133 with 22 cars,
 * the track went 375x812 339 → 381 px and 390x844 358 → 400 (one car: 370 → 416
 * and 434 → 448).
 *
 * "Upright" is `(orientation: portrait)`: by the media query's definition, the
 * viewport at least as tall as it is wide (a square counts). It replaces the
 * height bound as what keeps a landscape shape out, and the two differ only
 * where no phone is: a screen under 640 px wide and wider than tall is also
 * under 640 px tall. Up to 480 px tall the height clause makes it `compact:`
 * anyway; from 481 to 639 px tall (a 600x500 window) it was compact under the
 * 800 px bound and keeps its text buttons now (measured there: header 44 → 86,
 * transport 89 → 75, tower list 142 → 114, the track held at its 200 px
 * floor). Neither iOS Safari nor Chrome on Android
 * resizes the layout viewport for the on-screen keyboard by default, so a
 * keyboard does not flip the orientation; the app has no text field anyway.
 *
 * The width clause keeps it off a short laptop window (1366x657). A desktop
 * window under 640 px wide and taller than wide gets the thin rows and the
 * icons, each with its label as a tooltip, at any height now: 600x900, 22 cars,
 * header 122 → 44, transport 75 → 89, track 422 → 460 px.
 */
const UPRIGHT_PHONE = "(max-width: 39.9375rem) and (orientation: portrait)";

/**
 * A phone (Slice 26): a screen narrower than `md`, OR one at most 30rem (480 px)
 * tall, in either orientation.
 *
 * The width clause is the exact complement of `md`, written the way Tailwind
 * writes `max-md:`, so no fractional width falls between `md:` and it. It is the
 * line the app already draws: below it the sidebar is the phone's, the focused
 * readout wraps instead of stacking, and the layout check emulates a mobile device
 * (`MOBILE_BELOW_PX`). It covers every iPhone upright, and the smaller ones held
 * sideways: the safe areas take ~88 px of a landscape width, so a 375x812 phone
 * leaves Safari 724x257 (measured from the human's screenshots, 2026-10-11).
 *
 * The height clause covers the rest (ruled 2026-10-12). A Plus or Pro Max iPhone
 * held sideways leaves Safari about 814x312 (932 less 2 x 59 px of safe area;
 * estimated), which is `md` wide, and its ~215 px track cell held no whole card.
 * With both clauses every iPhone's Safari viewport is a phone in both
 * orientations: none is wider than 767 px upright or taller than 480 px sideways.
 * The cost, accepted in the ruling: a desktop window 480 px tall or less is a
 * phone too, and gets the full-screen gallery (1280x480: 2 whole cards → 3).
 *
 * The gallery and the event card cover the whole screen here rather than the
 * track cell, because here the track cell is the short part of the screen: 216 px
 * of a 375x626 phone, 160 px of a 724x257 one, and no gallery card fitted whole
 * in either (`src/components/overlay.ts` has the numbers). While one is open the
 * rest of the page is inert. Everywhere else they keep the track cell, unchanged.
 *
 * `src/components/phoneLayout.ts` reads the same query in React (`PHONE_QUERY`);
 * `layoutVariants.test.ts` pins the two to one compiled string.
 */
const PHONE = `not all and (min-width: ${defaultTheme.screens.md}), (max-height: 30rem)`;

/**
 * A phone's screen, either way up (Slice 27, the human's option C1): the header
 * and the transport bar become thin rows, and the header's two buttons become icons.
 * Every control in those rows keeps a 44x44 CSS px target (the human's ruling,
 * `src/components/touchTarget.ts`), so a row is as tall as one control: the
 * header 44 px, the transport bar 45 in landscape and 89–133 (two or three rows)
 * upright.
 *
 * Two clauses, both measured in iOS Safari's real viewports (2026-10-11):
 *  - at most 30rem (480 px) tall: every landscape phone. Safari leaves 724x257 with
 *    its tab bar and ~724x300 without; Chrome-sized ones are 360–430 tall, a Plus
 *    or Pro Max held sideways about 814x312. No portrait phone is that short. A
 *    desktop window can be (1280x480), and it gets the icons too, each with its
 *    label as a tooltip (`src/components/compactLayout.ts` reads this query).
 *  - an upright phone, at any height (`UPRIGHT_PHONE`).
 */
const COMPACT = `(max-height: 30rem), ${UPRIGHT_PHONE}`;

/**
 * A landscape phone at most 20rem (320 px) tall (Slice 27, ruled 2026-10-12): the
 * header leaves the top of the screen for the top of the tower column, so the
 * track runs the whole height from the top of the screen to the transport bar.
 *
 * Safari on a 375x812 iPhone held sideways leaves the page 724x257 with its tab
 * bar shown. There the header (44 px) and the transport bar (45) left the track
 * 168 px, under the layout check's 200 px floor; with the header above the tower
 * the track is 212 px, and the tower keeps its 168 (it was already under the
 * header). The header's meta line has no room beside the title and the two 44 px
 * boxes in the 256 px column, and is dropped there (ruled; the tower lists every
 * driver): `sr-only`, so a screen reader still reads it.
 *
 * Three clauses, all needed:
 *  - at most 20rem tall: 724x257 and 724x300 (Safari, tab bar shown or not) and
 *    the smallest phone held sideways (568x320); not 667x375 or 740x360, whose
 *    track already clears the floor with the header across the top;
 *  - narrower than `md`, where the tower column is `side:w-64` (Hud.tsx), 256 px,
 *    room for the header's one row. From `md` the column is 224 px with the
 *    column readout, so 814x312 (a Plus or Pro Max held sideways, 223 px of
 *    track already) keeps the header across the top. 47.9375rem, as `COMPACT`
 *    writes its width; a fractional width just under 768 px falls to the header
 *    across the top, the layout every other short screen has;
 *  - `WIDE`, so the track and the tower are side by side (`side:`), the only
 *    layout with a tower column to sit above. Every landscape phone is.
 *
 * The grid itself is App.tsx's: this variant only says where it applies.
 */
const FULL_TRACK = `(max-height: 20rem) and (max-width: 47.9375rem) and ${WIDE}`;

/** @type {import('tailwindcss').Config} */
export default {
  // What ships, never its tests. Tailwind compiles every word in these files that
  // names a utility, comments and strings included, so a test that merely SPOKE of
  // a class shipped its rule: a guard asserting a variant's rule exists and sits
  // after another passed with the class deleted from the component, because the
  // guard's own comment spelled it (Slice 27's review), and the escaped selectors
  // tests search for put unused unprefixed rules in the bundle. Excluded, a test
  // that reads the compiled CSS (`?inline`) sees exactly the app's stylesheet.
  content: ["./index.html", "./src/**/*.{ts,tsx}", "!./src/**/*.test.{ts,tsx}"],
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
  plugins: [
    // Variants rather than `theme.screens`, because a non-min-width screen there
    // switches off Tailwind's `min-*` and `max-*` variants project-wide.
    plugin(({ addVariant }) => {
      // Track and tower side by side: wide enough for the 224 px sidebar (`md`),
      // or a wide shape at any width. Every class that makes the layout side by
      // side uses this one query, so they switch together; a `md:` copy would
      // miss landscape phones. `md:` only resizes the sidebar and turns its
      // readout into a column from 768 px up (Hud.tsx, CarEntry.tsx).
      addVariant(
        "side",
        `@media (min-width: ${defaultTheme.screens.md}), ${WIDE}`,
      );
      // The header's meta line keeps to one line (App.tsx): on a wide screen, a
      // short one, or an upright phone, where the header is one thin row
      // (`compact:`). One variant, so the cases cannot drift apart, and every
      // `compact:` screen is `onerow:` too.
      addVariant("onerow", `@media ${WIDE}, ${SHORT}, ${UPRIGHT_PHONE}`);
      // The overlay dialogs leave the track cell for the whole screen (the
      // gallery and the event card): below `md`, or on a screen at most 30rem
      // tall. One variant, so the two cannot drift.
      addVariant("phone", `@media ${PHONE}`);
      // Thin header and transport rows on a phone, either way up, 44 px
      // targets kept.
      addVariant("compact", `@media ${COMPACT}`);
      // The header above the tower column on the shortest landscape phones, so
      // the track runs the full height. Last, so it wins over `compact:`.
      addVariant("fulltrack", `@media ${FULL_TRACK}`);
    }),
  ],
};
