/**
 * EventCard.tsx — the narrated-moment overlay (Slice 17's red-flag ruling).
 *
 * A DOM overlay in `FeaturedPanel`'s exact mould: a wash over the canvas, not a
 * replacement for it — the paused frame underneath IS the moment being narrated.
 * `ScenarioEvents` has already paused playback by the time this mounts.
 *
 * The copy (`event.title`, `event.body`) is the manifest's, rendered verbatim —
 * owned by the human like every hook line.
 *
 * FOCUS, MANAGED FOR A DIALOG NOBODY OPENED
 * -----------------------------------------
 * The panel returns focus to the toggle that opened it; this card has no opener —
 * playback summoned it. On mount, focus moves to the primary action so Enter is
 * the whole interaction. On close it returns to whatever held focus before the
 * card appeared, when that element still exists; failing that (the common case —
 * a mouse user focused nothing) it lands on the play/pause toggle, which is the
 * control that undoes what the card did: the card paused the replay, and the
 * button under focus resumes it.
 */
import { useEffect, useRef, useState } from "react";
import { applyScenario } from "../data/applyScenario";
import type { GalleryScenario, ScenarioEvent } from "../engine/gallery";
import { useTransport } from "../store/transport";
import { FOCUS_RING } from "./focus";
import { PLAY_TOGGLE_ID } from "./TransportBar";

export interface EventCardProps {
  event: ScenarioEvent;
  /** The scenario the "continue" action loads, or `null` for no chain. */
  next: GalleryScenario | null;
  /** Dismiss the card. Playback stays paused — dismissal hands control back. */
  onClose: () => void;
}

export function EventCard({ event, next, onClose }: EventCardProps) {
  const headingId = "event-card-heading";
  const primaryRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount/unmount focus contract — see the header. The captured element is read
  // once, before focus moves into the card. With no chain to offer, the close
  // button is the primary action.
  useEffect(() => {
    const before = document.activeElement;
    (primaryRef.current ?? closeRef.current)?.focus();
    return () => {
      const target =
        before instanceof HTMLElement &&
        document.contains(before) &&
        before !== document.body
          ? before
          : document.getElementById(PLAY_TOGGLE_ID);
      target?.focus();
    };
  }, []);

  const continueTo = async (scenario: GalleryScenario) => {
    setBusy(true);
    setError(null);
    const failure = await applyScenario(scenario);
    if (failure !== null) {
      // Degrade exactly as the panel does: the narrated replay stays on screen,
      // the message says why, and the card keeps working.
      setBusy(false);
      setError(failure);
      return;
    }
    // Continuing is a statement about wanting playback: the card paused the
    // replay to be read, and "continue" means keep going. (Dismissal, by
    // contrast, leaves the transport exactly where the pause put it.)
    useTransport.getState().play();
    // No onClose needed: applying the next scenario swaps `scenario` in the
    // store, and `ScenarioEvents` resets the card with it — but closing is
    // correct even if the chained scenario carries no events of its own.
    onClose();
  };

  return (
    <div
      // Escape closes, and `stopPropagation` keeps the one press doing one thing —
      // the transport handler is listening on the document for its own keys.
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === "Escape") {
          keyEvent.stopPropagation();
          onClose();
        }
      }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      // A wash, not a blur: the paused frame behind this is what the card is about.
      className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-bg/75 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-xl">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2
            id={headingId}
            className="font-mono text-xs font-bold tracking-[0.2em] text-accent"
          >
            {event.title}
          </h2>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            className={`rounded px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:text-txt ${FOCUS_RING}`}
          >
            Close
          </button>
        </div>

        <p className="m-0 font-mono text-xs leading-relaxed text-txt">
          {event.body}
        </p>

        {next !== null && (
          <button
            type="button"
            ref={primaryRef}
            disabled={busy}
            onClick={() => void continueTo(next)}
            className={`mt-3 w-full rounded border border-accent bg-panel2 px-3 py-2 text-left font-mono text-xs font-bold text-accent transition-colors hover:bg-panel disabled:opacity-50 ${FOCUS_RING}`}
          >
            {busy ? "Loading…" : `Continue: ${next.title}`}
          </button>
        )}

        {error !== null && (
          <pre
            role="alert"
            className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-brake bg-bg p-2 font-mono text-[11px] leading-relaxed text-txt"
          >
            {error}
          </pre>
        )}
      </div>
    </div>
  );
}
