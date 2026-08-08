/**
 * SpeedTrace.tsx — the focused car's recent speed, scrolling past a fixed playhead.
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
 */
import { useMemo } from "react";
import {
  buildTraceWindow,
  speedRange,
  TRACE_H,
  TRACE_W,
} from "../engine/trace";
import type { Car } from "../engine/schema";

export interface SpeedTraceProps {
  car: Car;
  clock: number;
  duration: number;
  sampleRateHz: number;
}

export function SpeedTrace({
  car,
  clock,
  duration,
  sampleRateHz,
}: SpeedTraceProps) {
  const range = useMemo(() => speedRange(car.samples), [car]);
  const { path, playheadX, startS, endS } = buildTraceWindow({
    samples: car.samples,
    sampleRateHz,
    clock,
    duration,
    range,
    width: TRACE_W,
    height: TRACE_H,
  });

  // What the window actually spans, which is the whole replay when the replay is shorter
  // than `TRACE_SECONDS`. Said out loud because the trace shows relative shape, not
  // absolute speed — the readout's number is what says absolute.
  const spanS = Math.round(endS - startS);

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
        aria-label={`Speed trace for ${car.driver}, the last ${spanS} seconds, ${range.minKmh} to ${range.maxKmh} km/h over the replay`}
      >
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
    </figure>
  );
}
