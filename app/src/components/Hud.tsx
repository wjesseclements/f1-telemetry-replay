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
 *
 * Tyres are derived the same way (Slice 14): `tyreStateAt(car, clock)` per car per
 * tick, a function of the replay and the clock exactly like a gap — never a
 * `CarSnapshot` field, so the 60 fps path and `displaySignature` never learn what a
 * tyre is. The signature's clock term already forces an emit whenever the answer
 * could change.
 */
import { useMemo, useState } from "react";
import {
  buildCarStateIndex,
  carStateAt,
  orderKeyFor,
  towerGap,
} from "../engine/carState";
import {
  buildProgressIndex,
  gapTo,
  progressKeyAt,
  type Gap,
} from "../engine/gaps";
import { sameOrder, towerOrder } from "../engine/runningOrder";
import type { Replay } from "../engine/schema";
import { tyreStateAt } from "../engine/tyres";
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
 * A real value rather than a special case, with nothing branching on "is this the
 * focused one" — its sort key is the same literal zero, which places the row at the
 * right spot in the running order.
 */
const SELF: Gap = { seconds: 0, metres: 0, residualM: 0, lapsDown: 0 };

export function Hud({ replay }: HudProps) {
  const { clock, cars } = useTelemetry();
  const focusedCarIndex = useTransport((s) => s.focusedCarIndex);
  const setFocusedCarIndex = useTransport((s) => s.setFocusedCarIndex);
  const comparisonCarIndex = useTransport((s) => s.comparisonCarIndex);
  const setComparisonCarIndex = useTransport((s) => s.setComparisonCarIndex);

  /**
   * Keep-and-suppress: the stored comparison survives every focus change untouched,
   * and the overlay simply does not draw while the compared car IS the focused car —
   * self-comparison is meaningless, not an error. Cycling focus through the field
   * never mutates the human's choice; focus moves off, the overlay returns.
   */
  const comparisonCar =
    comparisonCarIndex !== null && comparisonCarIndex !== focusedCarIndex
      ? replay.cars[comparisonCarIndex]
      : null;

  /**
   * Keyed on the REPLAY alone — every car's progress around one shared circuit does not
   * depend on which car is focused (Slice 9d). Slice 9 rebuilt a per-focus index here
   * and paid a measured 1.38 ms on every focus change, nineteen times to cycle a field.
   */
  const progress = useMemo(() => buildProgressIndex(replay), [replay]);

  /**
   * Slice 19's per-replay half, keyed like `progress` and for the same reason: spells,
   * holds and the launch instant are facts about the data, not about the focus or the
   * clock. A tick then classifies a car from interval membership — no per-frame work.
   */
  const states = useMemo(() => buildCarStateIndex(replay), [replay]);

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

  /**
   * States, then gaps THROUGH the states (Slice 19). `towerGap` blanks every number
   * the both-moving-on-the-racing-line rule disowns: retired and focused-not-racing
   * rows, off-line and stationary cars, the pre-launch standing field, and any gap
   * measured across a hold of the focused car. Derived per tick over `snapshots` so
   * the replay-swap guard above keeps its meaning — an empty frame classifies
   * nothing and renders nothing.
   */
  const carStates = snapshots.map((_, i) =>
    carStateAt(replay, progress, states, i, clock),
  );
  const focusState = carStates[focusedCarIndex];
  const gaps = snapshots.map((_, i) =>
    i === focusedCarIndex
      ? SELF
      : towerGap(
          gapTo(progress, focusedCarIndex, i, clock),
          focusState,
          carStates[i],
          states.holds[focusedCarIndex],
          states.launchT,
          clock,
        ),
  );

  // O(cars × log laps) per tick — measured in µs by hud-tick.mjs, like the gaps.
  const tyres = replay.cars.map((car) => tyreStateAt(car, clock));

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
  /**
   * The sort key is `progressKeyAt` — 9d's ΔP at reference pace, NEVER the displayed
   * gap (the Slice 19 watch's ruling: the order is always by track progress; a gap is
   * a display column and can never reorder a row). A blanked number is still a car
   * with a place in the running order. The one car with no place — off-line,
   * stationary, never yet moved: a pit-lane starter in its box — is nulled by
   * `orderKeyFor` and takes the existing untimed-bottom path. Retired cars leave the
   * running order entirely (`towerOrder`). No focus branch: the focused car's key is
   * an exact zero by construction.
   */
  const next = towerOrder(
    order,
    snapshots.map((_, i) =>
      orderKeyFor(
        progressKeyAt(progress, focusedCarIndex, i, clock),
        carStates[i],
      ),
    ),
    snapshots.map((_, i) =>
      carStates[i].retired ? (replay.cars[i].retiredAt ?? 0) : null,
    ),
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
            tyre={tyres[i]}
            retired={carStates[i].retired}
            offline={carStates[i].offline}
            dropout={carStates[i].dropout}
            focused={i === focusedCarIndex}
            compared={i === comparisonCarIndex}
            onFocus={() => setFocusedCarIndex(i)}
            onCompare={() =>
              setComparisonCarIndex(i === comparisonCarIndex ? null : i)
            }
            /* The trace rides INSIDE the focused row's readout block (Slice 19
               watch, ruled): it describes the focused car and sits with it. Built
               here, where the transport state lives, and handed down as a node —
               same <= 30 Hz derivation, no new subscriptions. Only the focused row
               renders it. */
            trace={
              i === focusedCarIndex ? (
                <SpeedTrace
                  car={replay.cars[focusedCarIndex]}
                  comparisonCar={comparisonCar}
                  clock={clock}
                  duration={replay.meta.duration}
                  sampleRateHz={replay.meta.sampleRateHz}
                />
              ) : undefined
            }
          />
        ))}
      </ul>
    </aside>
  );
}
