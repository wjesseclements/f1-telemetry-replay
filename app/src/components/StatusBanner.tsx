/**
 * StatusBanner.tsx — the flag, loudly, over the canvas (Slice 17 browser pass:
 * the transport chip alone was ruled too quiet for a red flag; this is the A+B
 * option — the chip stays as the timeline's accessible readout, and this strip
 * appears over the picture ONLY under an abnormal flag).
 *
 * Shown for yellow / sc / vsc / red; NOTHING for green (a green board is the
 * ordinary state of racing — a permanent GREEN banner over the canvas would be
 * noise), for "unknown", for a coverage gap, and for every pre-Slice-17 replay.
 *
 * A DOM overlay, deliberately: the canvas is untouched, so the drawcall md5s
 * hold. It subscribes to the telemetry channel itself — ≤30 Hz, a SIBLING of
 * `TrackCanvas` inside the same relative cell, never an ancestor (rule 1), and
 * `App` still subscribes to nothing.
 *
 * `aria-hidden`, deliberately: the SAME fact is already carried, with accessible
 * text, by the `StatusFlag` chip in the transport bar. This strip is visual
 * emphasis — announcing it twice would be noise for exactly the reader the text
 * exists for. `pointer-events-none` so it can never intercept a canvas click.
 */
import type { Replay, TrackStatus } from "../engine/schema";
import { statusAt } from "../engine/trackStatus";
import { useTelemetry } from "../telemetry/useTelemetry";

/** Banner label + classes per abnormal status. Full literal class names. */
const BANNER: Partial<Record<TrackStatus, { label: string; classes: string }>> =
  {
    yellow: { label: "YELLOW FLAG", classes: "bg-flag-yellow text-bg" },
    sc: { label: "SAFETY CAR", classes: "bg-flag-sc text-bg" },
    vsc: { label: "VIRTUAL SAFETY CAR", classes: "bg-flag-vsc text-bg" },
    red: { label: "RED FLAG", classes: "bg-flag-red text-bg" },
  };

export function StatusBanner({ replay }: { replay: Replay }) {
  const { clock } = useTelemetry();
  const status = statusAt(replay.trackStatus, clock);
  const banner = status === null ? undefined : BANNER[status];
  if (banner === undefined) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-[5] flex justify-center p-2"
    >
      <span
        className={`rounded px-4 py-1.5 font-mono text-sm font-bold tracking-[0.3em] shadow-lg ${banner.classes}`}
      >
        {banner.label}
      </span>
    </div>
  );
}
