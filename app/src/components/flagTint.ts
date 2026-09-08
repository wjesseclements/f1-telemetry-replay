/**
 * flagTint.ts — the scrubber's track-status tint (Slice 17, ruling 4).
 *
 * Its own module rather than an export of `Scrubber.tsx` because a component file
 * should export only components (react-refresh), and because the tint is pure
 * string-building over engine data — testable without a DOM.
 */
import type { TrackStatus } from "../engine/schema";
import type { StatusSegment } from "../engine/trackStatus";

/**
 * Which statuses tint the track, and with what (Slice 17, ruling 4). Green and
 * "unknown" map to nothing: green is the bar's ordinary state and unknown has no
 * honest colour — both render as the base `--c-line`, so a replay with no
 * abnormal stretches keeps today's bar exactly. Tokens, never hex (design-token
 * law); the tint is presentation, so the mapping lives here the way `CarEntry`
 * owns the compound dot's colours.
 */
const SEGMENT_TINT: Record<TrackStatus, string | null> = {
  green: null,
  unknown: null,
  yellow: "var(--c-flag-yellow)",
  sc: "var(--c-flag-sc)",
  vsc: "var(--c-flag-vsc)",
  red: "var(--c-flag-red)",
};

/**
 * The track's background as one CSS gradient with hard stops, or `null` when
 * nothing needs tinting (then the `bg-line` class alone paints the bar, exactly
 * as before this feature existed).
 *
 * A gradient rather than overlay elements because the scrubber is a NATIVE
 * `<input type="range">` — its whole accessibility story — and layering siblings
 * over a native input means fighting its hit target. Painting the element's own
 * background fights nothing.
 */
export function segmentGradient(
  segments: readonly StatusSegment[],
): string | null {
  const stops: string[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const tint = SEGMENT_TINT[segment.status];
    if (tint === null) continue;
    const from = (segment.from * 100).toFixed(2);
    const to = (segment.to * 100).toFixed(2);
    if (segment.from > cursor) {
      stops.push(`var(--c-line) ${(cursor * 100).toFixed(2)}% ${from}%`);
    }
    stops.push(`${tint} ${from}% ${to}%`);
    cursor = segment.to;
  }
  if (stops.length === 0) return null;
  if (cursor < 1) {
    stops.push(`var(--c-line) ${(cursor * 100).toFixed(2)}% 100%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
