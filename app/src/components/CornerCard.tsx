/**
 * CornerCard.tsx — a corner's name and the story behind it (Slice 18).
 *
 * Opened from a corner number on the canvas (`render/CornerStoryTargets.tsx`),
 * and cast in `EventCard`'s mould (ruled 2026-10-14): a wash over the track
 * cell on a desktop, the whole screen on a phone with the page behind it inert
 * (`overlay.ts`), a pinned heading row with a 44 px Close there, and Escape to
 * close. Opening it pauses the replay and closing it leaves it paused (`App`).
 *
 * The copy is the lore files' (`src/lore/*.json`), rendered verbatim: the
 * eyebrow ("Turn 11", "Turns 10–14", "Start/finish"), the name, the second name
 * in a dimmer style, and the story (all ruled 2026-10-15). Previous and Next
 * step round the lap and wrap, so a story whose number is too crowded to tap on
 * a phone (Vale's 5 px) is always one or two presses away.
 *
 * NAMES. The heading's visible lines are `aria-hidden`, and its text for
 * assistive tech is one `sr-only` string in the ruled format, "Turn 11: Curva
 * Alboreto (Parabolica)" — the badge's own name. The dialog is labelled by the
 * heading, so it carries that name too. One string rather than three lines,
 * because Chrome puts a space between separate boxes when it builds a name
 * from content, and "Turn 11 : Curva Alboreto ( Parabolica )" is not the ruled
 * format. When Previous or Next changes the story, a polite live region says
 * the new name; on open the dialog's name is announced with it, so the region
 * stays empty until the first step.
 *
 * FOCUS. Close takes focus on open. Handing it back is `App`'s, by id, to the
 * button of whichever story the card shows when it closes, after any
 * Previous/Next: never "whatever was focused", because Safari does not focus a
 * tapped button.
 */
import { useEffect, useRef, useState } from "react";
import { stepStory, type LoreStory } from "../engine/lore";
import { FOCUS_RING } from "./focus";
import {
  OVERLAY_CLOSE_TARGET,
  OVERLAY_FOCUS_CLEARANCE,
  OVERLAY_PHONE,
  OVERLAY_PINNED_BAR,
  usePhoneModal,
} from "./overlay";

/** The card's id: the badges' `aria-haspopup` target, and the layout check's. */
export const CORNER_CARD_ID = "corner-card";

export interface CornerCardProps {
  /** Every story of this replay, in lap order: what Previous/Next step through. */
  stories: readonly LoreStory[];
  /** The story shown. */
  index: number;
  /** Show story `index` instead; Previous and Next wrap round the lap. */
  onStep: (index: number) => void;
  /** Dismiss the card. Playback stays paused. */
  onClose: () => void;
}

export function CornerCard({
  stories,
  index,
  onStep,
  onClose,
}: CornerCardProps) {
  const headingId = `${CORNER_CARD_ID}-heading`;
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Modal on a phone, where it covers the whole screen (`overlay.ts`).
  const modal = usePhoneModal(dialogRef);
  // Whether a Previous/Next has changed the story since the card opened, which
  // is when the live region starts to speak (see the header).
  const [stepped, setStepped] = useState(false);

  // A passive effect, after `usePhoneModal`'s layout effect has made the page
  // behind inert on a phone, so focus lands with nothing behind it reachable.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const story = stories[index];
  const step = (by: -1 | 1) => {
    setStepped(true);
    onStep(stepStory(index, stories.length, by));
  };
  // Previous and Next: the event card's secondary-control look, with the
  // pinned Close's 44 px floor on a phone.
  const stepClass = `rounded border border-line px-3 py-1.5 font-mono text-xs text-dim transition-colors hover:text-txt ${OVERLAY_CLOSE_TARGET} ${FOCUS_RING}`;

  return (
    <div
      // Escape closes, and `stopPropagation` keeps the one press doing one
      // thing: the transport handler listens on the window for its own keys.
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === "Escape") {
          keyEvent.stopPropagation();
          onClose();
        }
      }}
      ref={dialogRef}
      id={CORNER_CARD_ID}
      role="dialog"
      aria-modal={modal ? "true" : "false"}
      aria-labelledby={headingId}
      // `items-start` + the card's `my-auto`, never `items-center`: centred when
      // it fits, scrolling from its top when it does not (FeaturedPanel says why).
      className={`absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-bg/75 p-4 ${OVERLAY_PHONE} ${OVERLAY_FOCUS_CLEARANCE}`}
    >
      <div className="my-auto w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-xl">
        {/* Pinned on a phone, as the event card's is: a long story scrolls
            under it on the shortest screens (`OVERLAY_PINNED_BAR`). */}
        <div className={`mb-2 phone:mb-0 phone:pb-2 ${OVERLAY_PINNED_BAR}`}>
          <div className="flex items-start justify-between gap-3">
            <h2 id={headingId} className="min-w-0 font-mono">
              <span className="sr-only">{story.accessibleName}</span>
              <span
                aria-hidden="true"
                className="block text-[11px] tracking-[0.2em] text-dim"
              >
                {story.eyebrow}
              </span>
              <span
                aria-hidden="true"
                className="block text-sm font-bold text-accent"
              >
                {story.name}
              </span>
              {story.subtitle !== undefined && (
                <span aria-hidden="true" className="block text-xs text-dim">
                  {story.subtitle}
                </span>
              )}
            </h2>
            <button
              type="button"
              ref={closeRef}
              onClick={onClose}
              className={`shrink-0 rounded px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:text-txt ${OVERLAY_CLOSE_TARGET} ${FOCUS_RING}`}
            >
              Close
            </button>
          </div>
        </div>

        <p className="m-0 font-mono text-xs leading-relaxed text-txt">
          {story.story}
        </p>

        <div className="mt-3 flex justify-between gap-3">
          <button type="button" onClick={() => step(-1)} className={stepClass}>
            Previous
          </button>
          <button type="button" onClick={() => step(1)} className={stepClass}>
            Next
          </button>
        </div>

        <p aria-live="polite" className="sr-only">
          {stepped ? story.accessibleName : ""}
        </p>
      </div>
    </div>
  );
}
