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
 * An event past the end of a rebuilt, shorter window clamps to the duration
 * (`resolveStartClock`'s reasoning): the narration and the chain survive even if
 * the moment itself was cut.
 *
 * STALE FRAMES NEITHER ARM NOR FIRE. Loading a replay swaps `replay` and
 * `scenario` while the last published frame still describes the PREVIOUS replay
 * — the same one-frame window `Hud` guards with its cars-length comparison, and
 * the same guard is used here. Without it the detector would arm on the old
 * replay's clock and a landing seek could read as a crossing, firing narration
 * for a moment nobody watched.
 */
import { useEffect, useRef, useState } from "react";
import type { GalleryScenario, ScenarioEvent } from "../engine/gallery";
import { findScenario } from "../gallery/scenarios";
import { useTransport } from "../store/transport";
import { useTelemetry } from "../telemetry/useTelemetry";
import { EventCard } from "./EventCard";

export function ScenarioEvents() {
  const { clock, cars } = useTelemetry();
  const scenario = useTransport((s) => s.scenario);
  const replay = useTransport((s) => s.replay);

  const [active, setActive] = useState<ScenarioEvent | null>(null);
  /**
   * The previous tick's observation, TAGGED with the scenario it was made under.
   * The tag is what resets the detector on a load: an observation made under
   * another scenario is not a previous clock, it is a different replay's clock —
   * so the first frame under a new scenario arms rather than fires, with no
   * render-time ref write (`react-hooks/refs` forbids one).
   */
  const prevClock = useRef<{
    scenario: GalleryScenario;
    clock: number;
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
    const prev =
      prevClock.current !== null && prevClock.current.scenario === scenario
        ? prevClock.current.clock
        : null;
    prevClock.current = { scenario, clock };
    if (prev === null || active !== null) return;

    // The LAST crossed event wins when one tick jumps several marks — the most
    // recent narration is the one that explains where the playhead now is.
    let crossed: ScenarioEvent | null = null;
    for (const event of scenario.events) {
      const mark = Math.min(event.clock, replay.meta.duration);
      if (prev < mark && clock >= mark) crossed = event;
    }
    if (crossed !== null) {
      setActive(crossed);
      // Pause is the ruled behaviour: the card narrates a stoppage; the replay
      // holds while it is read. `getState` rather than a subscription — this
      // effect needs the action once, not a re-render per transport change.
      useTransport.getState().pause();
    }
  }, [clock, cars, scenario, replay, active]);

  if (scenario === null || active === null) return null;

  return (
    <EventCard
      event={active}
      next={scenario.next === undefined ? null : findScenario(scenario.next)}
      onClose={() => setActive(null)}
    />
  );
}
