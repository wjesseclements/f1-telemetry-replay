/**
 * SpeedTrace.tsx — the lap's speed profile, with a playhead.
 *
 * The curve is static for the whole replay, so it is built once with `useMemo` and only
 * the playhead's `x` changes as the clock runs. That is the same split the canvas uses:
 * O(samples) work at setup, O(1) work per update.
 *
 * SVG rather than a second canvas: it is a few hundred points, it scales with the
 * layout for free, and it keeps the app's only imperative drawing surface the one that
 * needs to be imperative.
 */
import { useMemo } from "react";
import { buildSpeedTrace, tracePlayheadX } from "../engine/trace";
import type { Car } from "../engine/schema";

/** Drawing box, in SVG user units. The element scales to its container. */
const W = 240;
const H = 44;

export interface SpeedTraceProps {
  car: Car;
  clock: number;
  duration: number;
}

export function SpeedTrace({ car, clock, duration }: SpeedTraceProps) {
  const { path, minKmh, maxKmh } = useMemo(
    () => buildSpeedTrace(car.samples, W, H),
    [car],
  );
  const x = tracePlayheadX(clock, duration, W);

  return (
    <figure className="m-0">
      <figcaption className="mb-1 font-mono text-[10px] uppercase tracking-widest text-dim">
        Speed trace
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-11 w-full"
        role="img"
        aria-label={`Speed trace for ${car.driver}, ${minKmh} to ${maxKmh} km/h over the lap`}
      >
        <path
          d={path}
          fill="none"
          stroke="var(--c-dim)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={x}
          y1={0}
          x2={x}
          y2={H}
          stroke="var(--c-accent)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}
