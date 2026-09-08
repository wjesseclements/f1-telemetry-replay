/**
 * applyScenario.ts — load a gallery scenario and land the transport inside it.
 *
 * Extracted from `FeaturedPanel` when the event card gained its "continue" action
 * (Slice 17): two callers now load scenarios, and the sequence below is
 * order-sensitive enough that duplicating it would eventually mean two different
 * galleries. One definition, two buttons.
 */
import {
  resolveFocusIndex,
  resolveStartClock,
  type GalleryScenario,
} from "../engine/gallery";
import { useTransport } from "../store/transport";
import { loadGalleryReplay } from "./loadGalleryReplay";

/**
 * Fetch, validate and apply `scenario`. Resolves to `null` on success, or to the
 * degradation message on failure — in which case the store is UNTOUCHED: the
 * replay already on screen keeps playing, exactly as a failed file-picker load
 * behaves.
 */
export async function applyScenario(
  scenario: GalleryScenario,
): Promise<string | null> {
  const result = await loadGalleryReplay(scenario);
  if (result.replay === null) return result.error;

  const { setReplay, setFocusedCarIndex, seek, setSpeedMult } =
    useTransport.getState();
  // Order matters: `setReplay` resets focus to car 0 (it has to — the old index
  // may not exist in the new file), so the suggested camera is applied after it.
  // The scenario rides `setReplay` itself, atomically, so its narrated events can
  // never describe a replay other than the one on screen.
  setReplay(result.replay, scenario);
  setFocusedCarIndex(
    resolveFocusIndex(result.replay, scenario.suggested.driver),
  );
  // Land INSIDE the moment. Clamped against the loaded replay, because a rebuilt
  // window can be shorter than the one the manifest was written against.
  seek(resolveStartClock(result.replay, scenario.suggested.clock));
  setSpeedMult(scenario.suggested.speedMult);
  // `isPlaying` is untouched, the same call the picker and the scrubber make:
  // loading a replay is not a statement about whether you wanted playback running.
  return null;
}
