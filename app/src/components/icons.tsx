/**
 * icons.tsx — the header's two controls as glyphs, for the compact header.
 *
 * PLACEHOLDER artwork (drawn in Slice 26's draft C1, shipped in Slice 27). Which
 * pictures stand for "the gallery" and "open a file" is the human's call, like any
 * other user-facing copy; swapping one is a change to its paths here and nothing
 * else. Drawn 14 px in a 44 px box (`touchTarget.ts`).
 *
 * Decorative by construction: `aria-hidden` and no title, because each sits inside a
 * control whose accessible name is its existing text label, kept in the DOM as
 * `sr-only` when the icon shows. A screen reader, voice control ("click Featured
 * replays") and the tests all keep the name they had. Stroked in `currentColor`, so
 * the control's own token colour (and its hover colour) paints it; no hex here.
 */

interface IconProps {
  className?: string;
}

const SVG_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** PLACEHOLDER: a 2x2 grid of cards — "Featured replays". */
export function GalleryIcon({ className }: IconProps) {
  return (
    <svg {...SVG_PROPS} className={className}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

/** PLACEHOLDER: an open folder — "Load replay JSON". */
export function OpenFileIcon({ className }: IconProps) {
  return (
    <svg {...SVG_PROPS} className={className}>
      <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5Z" />
      <path d="M8 11V7.5M6.5 9 8 7.5 9.5 9" />
    </svg>
  );
}
