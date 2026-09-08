/**
 * StatusFlag.tsx — the flag chip beside the clock (Slice 17, ruling 4).
 *
 * The transport bar is where time state lives, so the flag the clock is under
 * lives there too. It renders exactly what the data carries — a green board shows
 * GREEN, the restart's Safety-Car train shows green because that is what the
 * session's status feed said (ruled: rendered as the data carries it, no
 * invention). `null` (no interval covers the clock — every pre-Slice-17 file) and
 * `"unknown"` (a code the pipeline could not map) render NOTHING: we don't know,
 * so we don't say. That is what keeps every existing replay's bar pixel-identical.
 *
 * The DRS pill's shape, the tyres' colour doctrine (own tokens, full literal
 * class names for Tailwind's scanner). RED alone inverts to a solid fill — the
 * acceptance is "see the RED flag appear", and a filled chip is the loudest thing
 * this bar knows how to say without animation.
 *
 * No `aria-live`, per the HUD's standing doctrine: the chip changes with the
 * clock, and announcing transport-derived values would make the page unusable.
 * The visible short code is aria-hidden; the sr-only text carries the full name.
 */
import type { TrackStatus } from "../engine/schema";

/** Visible label + full name + chip classes per status. `unknown` renders nothing. */
const FLAG_CHIP: Record<
  Exclude<TrackStatus, "unknown">,
  { label: string; name: string; classes: string }
> = {
  green: {
    label: "GREEN",
    name: "Green flag",
    classes: "border-flag-green text-flag-green",
  },
  yellow: {
    label: "YELLOW",
    name: "Yellow flag",
    classes: "border-flag-yellow text-flag-yellow",
  },
  sc: {
    label: "SC",
    name: "Safety Car",
    classes: "border-flag-sc text-flag-sc",
  },
  vsc: {
    label: "VSC",
    name: "Virtual Safety Car",
    classes: "border-flag-vsc text-flag-vsc",
  },
  red: {
    label: "RED",
    name: "Red flag",
    classes: "border-flag-red bg-flag-red text-bg",
  },
};

export function StatusFlag({ status }: { status: TrackStatus | null }) {
  if (status === null || status === "unknown") return null;
  const chip = FLAG_CHIP[status];
  return (
    <span
      className={`rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest ${chip.classes}`}
    >
      <span aria-hidden="true">{chip.label}</span>
      <span className="sr-only">Track status: {chip.name}</span>
    </span>
  );
}
