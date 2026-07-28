/**
 * SpeedControl.tsx — the playback rate multiplier.
 *
 * Four plain `<button>`s in a labelled group rather than a radiogroup with roving
 * tabindex. Both are valid ARIA; buttons with `aria-pressed` were chosen because every
 * option is reachable by Tab alone, with no key handling to write and nothing to get
 * wrong. A radiogroup would be fewer tab stops but would need arrow-key management that
 * this slice has no other reason to build.
 */
import { FOCUS_RING } from "./focus";
import { SPEED_OPTIONS } from "./speedOptions";

export interface SpeedControlProps {
  speedMult: number;
  onChange: (speedMult: number) => void;
}

export function SpeedControl({ speedMult, onChange }: SpeedControlProps) {
  return (
    <div
      role="group"
      aria-label="Playback speed"
      className="flex items-center gap-1"
    >
      {SPEED_OPTIONS.map((rate) => {
        const active = rate === speedMult;
        return (
          <button
            key={rate}
            type="button"
            onClick={() => onChange(rate)}
            aria-pressed={active}
            aria-label={`${rate}x speed`}
            className={`rounded border px-2 py-1 font-mono text-xs tabular-nums transition-colors ${FOCUS_RING} ${
              active
                ? "border-accent text-accent"
                : "border-line text-dim hover:text-txt"
            }`}
          >
            {rate}&times;
          </button>
        );
      })}
    </div>
  );
}
