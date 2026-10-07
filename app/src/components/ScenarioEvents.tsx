/**
 * ScenarioEvents.tsx — the clock-watcher behind the event card.
 *
 * When a gallery scenario carries narrated moments (`scenario.events`), someone has
 * to notice the playhead passing one. That someone is this component: it subscribes
 * to the telemetry channel like the HUD does — ≤30 Hz, a SIBLING of `TrackCanvas`,
 * never an ancestor (rule 1) — and the 60 fps frame path never learns what an event
 * is. `App` itself still subscribes to nothing.
 *
 * FIRING SEMANTICS, RULED IN SLICE 17
 * -----------------------------------
 * An event fires when the clock CROSSES its mark upward — playback or a seek, both
 * count: scrubbing past the red flag earns the same narration as watching it
 * happen. Firing pauses playback and shows the card. A dismissed event does not
 * re-fire until the clock has gone back BELOW its mark and crosses again, so
 * replaying the moment replays the card and sitting just past it does not nag.
 * The first observed clock after a scenario loads only arms the detector —
 * landing at `suggested.clock` is not a crossing.
 *
 * An event past the end of a rebuilt, shorter window clamps to the END
 * (`resolveStartClock`'s reasoning): the narration and the chain survive even if
 * the moment itself was cut. "The end" is `lastInstant`, not `meta.duration`: the
 * clock's domain is `[0, duration)`, so a mark AT `duration` is one the clock can
 * never reach — the clamp used to say `duration`, and a late event never fired, by
 * seek or by playback (Slice 23 follow-up). `lastInstant` is where End, the
 * scrubber's right edge and a clamped forward seek all land.
 *
 * PLAYBACK ROUND THE END IS A CROSSING TOO. Before playback wraps it spends one
 * grid step in `[lastInstant, duration)`, which is 100 ms / speed of real time, and
 * this detector samples at ≤30 Hz. At 2x and 4x a pass often went unseen: the
 * clock read 58.3, then 0.1, and a backward step is not a crossing (measured per
 * speed and display rate in the Slice 23 PLAN entry). The loop counts its own
 * wraps (`TelemetryFrame.wraps`), and a seek never adds to that count. So a step
 * across a wrap passed every mark between the previous clock and the end. After a
 * wrap the clock sits at the window's START, the far side of the moment, so the
 * detector seeks the paused frame back onto the mark. Marks in the first instants
 * AFTER a wrap get no such credit. That is the same ≤1-tick gap mirrored at the
 * start; it predates this change and was left alone.
 *
 * STALE FRAMES NEITHER ARM NOR FIRE. Loading a replay swaps `replay` and
 * `scenario` while the last published frame still describes the PREVIOUS replay
 * — the same one-frame window `Hud` guards with its cars-length comparison, and
 * the same guard is used here. Without it the detector would arm on the old
 * replay's clock and a landing seek could read as a crossing, firing narration
 * for a moment nobody watched.
 */
import { useEffect, useRef, useState } from "react";
import { lastInstant } from "../engine/clock";
import type { GalleryScenario, ScenarioEvent } from "../engine/gallery";
import { findScenario } from "../gallery/scenarios";
import { useTransport } from "../store/transport";
import { useTelemetry } from "../telemetry/useTelemetry";
import { EventCard } from "./EventCard";

export function ScenarioEvents() {
  const { clock, cars, wraps } = useTelemetry();
  const scenario = useTransport((s) => s.scenario);
  const replay = useTransport((s) => s.replay);

  const [active, setActive] = useState<ScenarioEvent | null>(null);
  /**
   * The previous tick's observation, TAGGED with the scenario it was made under.
   * The tag is what resets the detector on a load: an observation made under
   * another scenario is not a previous clock, it is a different replay's clock —
   * so the first frame under a new scenario arms rather than fires, with no
   * render-time ref write (`react-hooks/refs` forbids one). `wraps` is the loop's
   * wrap count at that tick — see the header.
   */
  const prevClock = useRef<{
    scenario: GalleryScenario;
    clock: number;
    wraps: number;
  } | null>(null);

  // A card must never survive the replay it narrates. Dropped DURING render on a
  // value comparison — React's documented shape for state derived from a changed
  // input, the same pattern as the tower's `order` in `Hud` — so the stale card
  // never paints, not even for one frame.
  const [lastScenario, setLastScenario] = useState(scenario);
  if (scenario !== lastScenario) {
    setLastScenario(scenario);
    setActive(null);
  }

  useEffect(() => {
    if (scenario === null || replay === null) return;
    // The Hud stale-frame guard — see the header. A frame describing another
    // replay's cars is dropped whole: it neither arms the detector nor fires it.
    if (cars.length !== replay.cars.length) return;
    const before =
      prevClock.current !== null && prevClock.current.scenario === scenario
        ? prevClock.current
        : null;
    prevClock.current = { scenario, clock, wraps };
    if (before === null || active !== null) return;
    const prev = before.clock;
    // Playback carried the clock round the end since the last tick. See the
    // header. `>` rather than `!==`: a count that went DOWN means a fresh loop
    // started counting from 0 again, not that playback wrapped.
    const wrapped = wraps > before.wraps;

    // The LAST crossed event wins when one tick jumps several marks — the most
    // recent narration is the one that explains where the playhead now is.
    let crossed: ScenarioEvent | null = null;
    let crossedMark = 0;
    // The furthest a mark may sit and still be reachable — see the header.
    const end = lastInstant(replay.meta.duration, replay.meta.sampleRateHz);
    for (const event of scenario.events) {
      const mark = Math.min(event.clock, end);
      // Upward past the mark. On a wrap, any mark past `prev` counts, because the
      // path ran on through the end.
      if (prev < mark && (wrapped || clock >= mark)) {
        crossed = event;
        crossedMark = mark;
      }
    }
    if (crossed !== null) {
      setActive(crossed);
      // Pause is the ruled behaviour: the card narrates a stoppage; the replay
      // holds while it is read. `getState` rather than a subscription — this
      // effect needs the action once, not a re-render per transport change.
      const transport = useTransport.getState();
      transport.pause();
      // After a wrap the clock is at the window's start. The frame under the card
      // should be the moment it narrates (EventCard), so put it back on the mark.
      if (wrapped) transport.seek(crossedMark);
    }
  }, [clock, cars, wraps, scenario, replay, active]);

  if (scenario === null || active === null) return null;

  return (
    <EventCard
      event={active}
      next={scenario.next === undefined ? null : findScenario(scenario.next)}
      onClose={() => setActive(null)}
    />
  );
}
