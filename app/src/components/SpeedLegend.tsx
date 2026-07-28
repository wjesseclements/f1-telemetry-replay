/**
 * SpeedLegend.tsx — what the trail's colours mean.
 *
 * The swatch is GENERATED from the engine's `THERMAL` stops, never re-typed as CSS.
 * The prototype shows the failure mode this avoids: it hard-codes the same five
 * colours a second time in its stylesheet (`TelemetryReplay.jsx:588`), so retuning a
 * stop silently desyncs the legend from the trail it claims to label. The inline
 * `style` here is the legitimate exception to "tokens, not hex" — the value is
 * computed from the single source, not written down twice.
 */
import { thermalGradientCss, thermalRangeKmh } from "../engine/color";

const GRADIENT = thermalGradientCss();
const [COLDEST, HOTTEST] = thermalRangeKmh();

export function SpeedLegend() {
  return (
    <figure className="pointer-events-none absolute bottom-3.5 left-3.5 m-0 flex items-center gap-2">
      <figcaption className="sr-only">
        Trail colour scale: {COLDEST} to {HOTTEST} km/h
      </figcaption>
      <span
        aria-hidden="true"
        className="font-mono text-[10px] tracking-widest text-dim"
      >
        {COLDEST}
      </span>
      <span
        aria-hidden="true"
        className="h-1.5 w-[90px] rounded-full"
        style={{ background: GRADIENT }}
      />
      <span
        aria-hidden="true"
        className="font-mono text-[10px] tracking-widest text-dim"
      >
        {HOTTEST} km/h
      </span>
    </figure>
  );
}
