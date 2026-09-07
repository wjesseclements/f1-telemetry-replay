/**
 * SpeedTrace.tsx — the focused car's recent speed, scrolling past a fixed playhead,
 * with an optional second car overlaid for comparison.
 *
 * The split is the same one the canvas uses: O(samples) work at setup, bounded work per
 * update. `speedRange` is the setup half and is memoised per car; `buildTraceWindow` is
 * the per-tick half and draws `TRACE_SECONDS` of history whatever the replay's length.
 * The component holds no state of its own — the window is a function of the clock, so a
 * scrub or a seek moves the trace by arriving with a different clock and nothing else.
 *
 * SVG rather than a second canvas: it is a couple of hundred points, it scales with the
 * layout for free, and it keeps the app's only imperative drawing surface the one that
 * needs to be imperative.
 *
 * THE COMPARISON LINE (Slice 15)
 * ------------------------------
 * `comparisonCar` is a second `buildTraceWindow` call against the SAME clock, box and
 * y-range — the union of both cars' whole-replay ranges, because two lines drawn to
 * their own axes would make equal heights mean unequal speeds. The union still only
 * changes when the pair changes (a click), so the axis never breathes per tick.
 *
 * The overlay is dashed as well as team-coloured and dimmer: the dash is the channel a
 * colour-blind viewer keeps, and the legend binds each style to a driver code in text.
 * With no comparison the markup is exactly the single-line trace it always was — no
 * legend, the same label — which is what keeps a single-car file looking like today.
 */
import { useMemo } from "react";
import {
  buildTraceWindow,
  speedRange,
  unionRange,
  TRACE_H,
  TRACE_W,
} from "../engine/trace";
import type { Car } from "../engine/schema";

export interface SpeedTraceProps {
  car: Car;
  /** The car overlaid for comparison, or `null`/absent for the plain trace. */
  comparisonCar?: Car | null;
  clock: number;
  duration: number;
  sampleRateHz: number;
}

/** One legend entry: the exact stroke the chart uses, then the driver code as text. */
function LegendEntry({
  driver,
  color,
  dashed,
}: {
  driver: string;
  color: string;
  dashed: boolean;
}) {
  return (
    <span className="flex items-center gap-1">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 4"
        className="h-1 w-4 shrink-0"
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          y1={2}
          x2={16}
          y2={2}
          stroke={color}
          strokeWidth={dashed ? 0.75 : 1}
          strokeOpacity={dashed ? 0.65 : 1}
          strokeDasharray={dashed ? "3 2" : undefined}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {driver}
    </span>
  );
}

export function SpeedTrace({
  car,
  comparisonCar = null,
  clock,
  duration,
  sampleRateHz,
}: SpeedTraceProps) {
  const ownRange = useMemo(() => speedRange(car.samples), [car]);
  const comparisonRange = useMemo(
    () => (comparisonCar ? speedRange(comparisonCar.samples) : null),
    [comparisonCar],
  );
  const range = comparisonRange
    ? unionRange(ownRange, comparisonRange)
    : ownRange;

  const { path, playheadX, startS, endS } = buildTraceWindow({
    samples: car.samples,
    sampleRateHz,
    clock,
    duration,
    range,
    width: TRACE_W,
    height: TRACE_H,
  });
  const comparisonPath = comparisonCar
    ? buildTraceWindow({
        samples: comparisonCar.samples,
        sampleRateHz,
        clock,
        duration,
        range,
        width: TRACE_W,
        height: TRACE_H,
      }).path
    : null;

  // What the window actually spans, which is the whole replay when the replay is shorter
  // than `TRACE_SECONDS`. Said out loud because the trace shows relative shape, not
  // absolute speed — the readout's number is what says absolute.
  const spanS = Math.round(endS - startS);

  const label = comparisonCar
    ? `Speed trace for ${car.driver} compared with ${comparisonCar.driver}, the last ${spanS} seconds, ${range.minKmh} to ${range.maxKmh} km/h over the replay`
    : `Speed trace for ${car.driver}, the last ${spanS} seconds, ${range.minKmh} to ${range.maxKmh} km/h over the replay`;

  return (
    <figure className="m-0">
      <figcaption className="mb-1 font-mono text-[10px] uppercase tracking-widest text-dim">
        Speed trace · last {spanS}s
      </figcaption>
      <svg
        viewBox={`0 0 ${TRACE_W} ${TRACE_H}`}
        preserveAspectRatio="none"
        className="h-11 w-full"
        role="img"
        aria-label={label}
      >
        {/* Under the focused line and the playhead: the overlay is context, not focus. */}
        {comparisonCar && comparisonPath !== null && (
          <path
            d={comparisonPath}
            fill="none"
            stroke={comparisonCar.color}
            strokeWidth={0.75}
            strokeOpacity={0.65}
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={path}
          fill="none"
          stroke="var(--c-dim)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {/* Inset by half a stroke at the right-hand edge, or the playhead is clipped to
            a sliver exactly where `PLAYHEAD_FRACTION` = 1 puts it. */}
        <line
          x1={Math.min(playheadX, TRACE_W - 0.5)}
          y1={0}
          x2={Math.min(playheadX, TRACE_W - 0.5)}
          y2={TRACE_H}
          stroke="var(--c-accent)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {comparisonCar && (
        <div className="mt-1 flex gap-3 font-mono text-[10px] tracking-wider text-dim">
          <LegendEntry
            driver={car.driver}
            color="var(--c-dim)"
            dashed={false}
          />
          <LegendEntry
            driver={comparisonCar.driver}
            color={comparisonCar.color}
            dashed
          />
        </div>
      )}
    </figure>
  );
}
