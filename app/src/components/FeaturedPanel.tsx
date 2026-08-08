/**
 * FeaturedPanel.tsx — the first thing a visitor meets.
 *
 * The app boots on a committed synthetic fixture: a one-car oval that proves the
 * engine works and sells nothing. This panel covers that frame with the three
 * curated real scenarios, one click each, and gets out of the way for good once one
 * is loaded.
 *
 * Three deliberate behaviours, each of them a decision rather than a default:
 *
 *  - **It overlays the canvas; it does not replace it.** The fixture keeps
 *    animating behind the scrim, because motion says "this is alive" in a way a
 *    frozen frame cannot. So the scrim is a plain translucent wash with no backdrop
 *    blur — the moving car has to read through it.
 *  - **A failed load keeps the replay that is on screen** and leaves the file
 *    picker working, exactly as `ReplayFilePicker` does for a bad file. The message
 *    is rendered verbatim, because `ReplayValidationError.message` carries its
 *    `→ at cars[0].samples[3].speed` paths and those are the whole value of it.
 *  - **Focus is managed, not left to chance.** Opening moves focus to the first
 *    scenario, so the recommended action is one Enter away; closing by ANY route —
 *    the close button, Escape, or picking a scenario — returns focus to the toggle
 *    that opened it. A keyboard visitor is never dumped at the top of the document.
 */
import { useEffect, useRef, useState } from "react";
import { loadGalleryReplay } from "../data/loadGalleryReplay";
import {
  parseGalleryManifest,
  resolveFocusIndex,
  resolveStartClock,
  type GalleryScenario,
} from "../engine/gallery";
import manifestJson from "../gallery/manifest.json";
import { useTransport } from "../store/transport";
import { FOCUS_RING } from "./focus";

/**
 * Validated once at module load, not per render.
 *
 * The manifest is bundled rather than fetched, so this cannot fail at runtime in a
 * way a visitor could see — a malformed entry fails `gallery.test.ts` first. That is
 * the entire reason the catalogue and the payloads live in different places.
 */
const SCENARIOS = parseGalleryManifest(manifestJson).scenarios;

export interface FeaturedPanelProps {
  /** Close the panel. The caller restores focus to the toggle. */
  onClose: () => void;
  /** `id` the toggle's `aria-controls` points at. */
  id: string;
}

export function FeaturedPanel({ onClose, id }: FeaturedPanelProps) {
  const headingId = `${id}-heading`;
  const firstCardRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Focus the recommended action on open, so Enter is the whole interaction.
  useEffect(() => {
    firstCardRef.current?.focus();
  }, []);

  const choose = async (scenario: GalleryScenario) => {
    setBusy(scenario.id);
    setError(null);

    const result = await loadGalleryReplay(scenario);

    if (result.replay === null) {
      // Degrade: keep the replay already on screen, say what happened, stay open so
      // the visitor can try another scenario without hunting for the way back in.
      setBusy(null);
      setError(result.error);
      return;
    }

    const { setReplay, setFocusedCarIndex, seek, setSpeedMult } =
      useTransport.getState();
    // Order matters: `setReplay` resets focus to car 0 (it has to — the old index
    // may not exist in the new file), so the suggested camera is applied after it.
    setReplay(result.replay);
    setFocusedCarIndex(
      resolveFocusIndex(result.replay, scenario.suggested.driver),
    );
    // Land INSIDE the moment. Clamped against the loaded replay, because a rebuilt
    // window can be shorter than the one the manifest was written against.
    seek(resolveStartClock(result.replay, scenario.suggested.clock));
    setSpeedMult(scenario.suggested.speedMult);
    // `isPlaying` is untouched, the same call the picker and the scrubber make:
    // loading a replay is not a statement about whether you wanted playback running.

    setBusy(null);
    onClose();
  };

  return (
    <div
      // Escape closes, and `stopPropagation` keeps the one press doing one thing —
      // the transport handler is listening on the document for its own keys.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      id={id}
      // A wash, not a blur: the fixture animating behind this is the point.
      className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-bg/75 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-xl">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2
            id={headingId}
            className="font-mono text-xs font-bold tracking-[0.2em] text-txt"
          >
            START HERE
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={`rounded px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:text-txt ${FOCUS_RING}`}
          >
            Close
          </button>
        </div>

        <ul className="flex flex-col gap-2">
          {SCENARIOS.map((scenario, index) => (
            <li key={scenario.id}>
              <button
                type="button"
                ref={index === 0 ? firstCardRef : undefined}
                disabled={busy !== null}
                onClick={() => void choose(scenario)}
                className={`w-full rounded border border-line bg-panel2 p-3 text-left transition-colors hover:border-accent disabled:opacity-50 ${FOCUS_RING}`}
              >
                <span className="block font-mono text-xs text-txt">
                  {scenario.title}
                </span>
                <span className="mt-1 block font-mono text-[11px] leading-relaxed text-dim">
                  {busy === scenario.id ? "Loading…" : scenario.hook}
                </span>
                <span className="mt-1 block font-mono text-[10px] text-dim/70">
                  {scenario.provenance.session} · laps{" "}
                  {scenario.provenance.laps} ·{" "}
                  {scenario.provenance.drivers.join(" ")}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {error !== null && (
          <pre
            role="alert"
            className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-brake bg-bg p-2 font-mono text-[11px] leading-relaxed text-txt"
          >
            {error}
          </pre>
        )}

        <p className="mt-3 font-mono text-[10px] leading-relaxed text-dim">
          Or build your own with the pipeline and open it with{" "}
          <span className="text-txt">Load replay JSON</span>. Unofficial
          project, not affiliated with Formula 1; data via FastF1 from the
          public timing feed.
        </p>
      </div>
    </div>
  );
}
