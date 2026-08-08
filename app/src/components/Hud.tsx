/**
 * Hud.tsx — the numbers, as a timing tower.
 *
 * Subscribes to the telemetry channel, so it re-renders at up to `HUD_HZ` and never at
 * frame rate. It is a SIBLING of `TrackCanvas`: its re-renders must never reach the
 * canvas (CLAUDE.md rule 1), which is a fact about where it sits in `App`, not about
 * anything it does.
 *
 * Deliberately NO `aria-live`. These values change 30 times a second; announcing them
 * would make the page unusable with a screen reader. The readout is a labelled list a
 * user reads on demand, and the transport controls are what get announced when acted on.
 *
 * ONE LIST, SORTED BY GAP
 * -----------------------
 * Every car is one `CarEntry`, and the focused car's full readout sits INLINE at its
 * own place in the running order rather than pinned to the top. Two reasons:
 *
 *  - the order is the point. Row position means "ahead of" and "behind", so lifting one
 *    car out of it would make the tower lie about where that car is;
 *  - it is what keeps a one-car replay identical. One car, focused, rendered as the
 *    full readout — no count branch anywhere, just a map that happens to produce one.
 *
 * WHERE THE GAPS ARE COMPUTED, AND WHY HERE
 * -----------------------------------------
 * In this component, off the animation loop entirely. Gaps are derived from the
 * telemetry snapshot at <= 30 Hz, so the 60 fps frame path never learns what a gap is
 * and the twenty-car frame budget is untouched by them. The expensive half — indexing
 * the focused car's path — is `useMemo`'d on the replay and the focus, so it is O(n)
 * per focus change and free otherwise.
 */
import { useMemo, useState } from "react";
import { buildProgressIndex, gapTo, type Gap } from "../engine/gaps";
import { orderByGap, sameOrder } from "../engine/runningOrder";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
import { EMPTY_FRAME } from "../telemetry/channel";
import { useTelemetry } from "../telemetry/useTelemetry";
import { CarEntry } from "./CarEntry";
import { SpeedTrace } from "./SpeedTrace";

export interface HudProps {
  replay: Replay;
}

/**
 * The focused car's gap to itself: exactly zero, in both units.
 *
 * A real value rather than a special case, so it sorts into the running order at the
 * right place with nothing branching on "is this the focused one".
 */
const SELF: Gap = { seconds: 0, metres: 0, residualM: 0, lapsDown: 0 };

export function Hud({ replay }: HudProps) {
  const { clock, cars } = useTelemetry();
  const focusedCarIndex = useTransport((s) => s.focusedCarIndex);
  const setFocusedCarIndex = useTransport((s) => s.setFocusedCarIndex);

  /**
   * Keyed on the REPLAY alone — every car's progress around one shared circuit does not
   * depend on which car is focused (Slice 9d). Slice 9 rebuilt a per-focus index here
   * and paid a measured 1.38 ms on every focus change, nineteen times to cycle a field.
   */
  const progress = useMemo(() => buildProgressIndex(replay), [replay]);

  /**
   * The published frame, unless it describes a different replay.
   *
   * Loading a replay swaps `replay` immediately while the last frame the render loop
   * published still holds the PREVIOUS replay's cars — one frame, at most 16 ms. Read
   * against the new replay that indexes past the end of `cars` and takes the whole app
   * down with a white screen; loading a one-car lap after a three-car window reached it
   * in about a second, and it predates the tower (the single readout indexed
   * `replay.cars[i]` the same way).
   *
   * A mismatched frame is stale by definition, so it is dropped rather than partially
   * rendered: the next frame is consistent, and until it lands this shows exactly what
   * it shows before the first publish of any replay — nothing car-shaped.
   */
  const snapshots =
    cars.length === replay.cars.length ? cars : EMPTY_FRAME.cars;

  const gaps = snapshots.map((_, i) =>
    i === focusedCarIndex ? SELF : gapTo(progress, focusedCarIndex, i, clock),
  );

  /**
   * The order the tower is in, which the next sort prefers over resorting.
   *
   * State rather than a ref, and set DURING render, which is React's documented shape
   * for a value derived from the previous one: the hysteresis in `orderByGap` means
   * the condition below is false on almost every frame, so the extra render pass costs
   * something only when cars actually change places. A ref would be the wrong tool
   * twice over — reading one during render is what `react-hooks/refs` forbids, and the
   * order genuinely is state, since what is rendered depends on what was rendered
   * before.
   *
   * `orderByGap` is idempotent (pinned by its own test), so the second pass computes
   * the same order and settles immediately.
   */
  const [order, setOrder] = useState<number[]>([]);
  const next = orderByGap(
    order,
    gaps.map((gap) => (gap === null ? null : gap.seconds)),
  );
  if (!sameOrder(next, order)) setOrder(next);

  return (
    // A sidebar when there is width for one, a strip under the track when there is
    // not. The border follows the edge it is actually on, so the panel never looks
    // detached from the canvas it belongs to.
    <aside
      aria-label="Telemetry"
      className="flex shrink-0 flex-row flex-wrap items-start gap-x-5 gap-y-3 border-t border-line bg-panel p-3 md:w-56 md:flex-col md:flex-nowrap md:gap-4 md:border-l md:border-t-0 md:p-4"
    >
      {/* `overflow-y-auto` because twenty cars are taller than any sidebar; three fit
          without it ever showing. */}
      <ul
        aria-label="Running order"
        className="m-0 flex w-full min-w-0 list-none flex-col gap-1 overflow-y-auto p-0"
      >
        {next.map((i) => (
          <CarEntry
            key={replay.cars[i].driver}
            car={replay.cars[i]}
            snapshot={snapshots[i]}
            gap={gaps[i]}
            focused={i === focusedCarIndex}
            onFocus={() => setFocusedCarIndex(i)}
          />
        ))}
      </ul>

      {/* The trace is the FOCUSED car's — the Slice 5 placeholder that read `cars[0]`
          because there was only ever one car to mean. */}
      {/* `w-full` so the trace takes its own row once the readout has wrapped: it is
          the one element here that reads by its width rather than its digits. */}
      <div className="w-full">
        <SpeedTrace
          car={replay.cars[focusedCarIndex]}
          clock={clock}
          duration={replay.meta.duration}
          sampleRateHz={replay.meta.sampleRateHz}
        />
      </div>
    </aside>
  );
}
