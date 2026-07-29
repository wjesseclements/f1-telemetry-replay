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
            // The visible text is `0.5×` with a MULTIPLICATION SIGN, so the accessible
            // name has to contain that exact string (WCAG 2.5.3 Label in Name): a name
            // of "0.5x speed" reads fine but leaves someone using voice control saying
            // "click zero point five times" and being ignored. Caught by Lighthouse's
            // `label-content-name-mismatch` in Slice 7.
            aria-label={`${rate}× speed`}
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
