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
 * NEXT STAYS PUT (ruled 2026-10-15: "Move Previous/Next above the story"). The
 * steps are the row straight under the heading row, above the story, so a
 * longer or shorter story moves nothing above it. Two things would still have
 * moved that row, and both are held here:
 *
 *   - The card's top. Centred, the card's top moves by half of every change in
 *     its height, and the row under the heading moves with it. So this card,
 *     unlike the gallery and the event card, is not centred: it sits at the top
 *     of its scroller, where the mould's own `items-start` puts any card that
 *     overflows (`overlay.test.tsx` pins the difference).
 *   - The heading's height. A second name is a third line, so on a replay
 *     where any story has one, every card keeps that line, empty where its
 *     story has none. Silverstone's stories have none, so its cards keep none.
 *
 * Measured in headless Chrome at the ten gated sizes, pressing Next round the
 * lap on both circuits: Next moved by up to 50.5 px from one story to the next
 * before this, and by up to 39 px with the row moved alone. Now it does not
 * move, with one exception: a name that wraps to a second line (Silverstone's
 * "Maggotts, Becketts and Chapel" at 360x640 moves it 12.5 px). A press at one
 * fixed point stepped round the whole lap at every size (Slice 18's PLAN entry
 * has the numbers).
 *
 * Reading order follows the DOM, so a screen reader meets the heading, Close,
 * Previous, Next, then the story.
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
  // The second-name line every card keeps when any story has one (see the header).
  const secondLine = stories.some((s) => s.subtitle !== undefined);
  const step = (by: -1 | 1) => {
    setStepped(true);
    onStep(stepStory(index, stories.length, by));
  };
  // Previous and Next: the event card's secondary-control look, with the
  // pinned Close's 44 px floor on a phone. They sit straight under the pinned
  // bar, so a focus scroll on a phone must stop below it. The dialog's
  // clearance (`OVERLAY_FOCUS_CLEARANCE`, 73 px) is sized for a bar whose row
  // is Close's 44 px; with a second-name line the row is 52.5 px and the bar
  // 76.5, so these add a 12 px scroll margin: 85 px, past the bar, the ring's
  // 4 px and a half-pixel snap (81.5). Measured in Chrome, 724x257 scrolled.
  const stepClass = `rounded border border-line px-3 py-1.5 font-mono text-xs text-dim transition-colors hover:text-txt phone:scroll-mt-3 ${OVERLAY_CLOSE_TARGET} ${FOCUS_RING}`;

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
      // `items-start`, never `items-center`, and no auto margins on the card:
      // it sits at the top whether or not it fits, so its top never moves (see
      // the header), and it scrolls from there when it does not fit.
      className={`absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-bg/75 p-4 ${OVERLAY_PHONE} ${OVERLAY_FOCUS_CLEARANCE}`}
    >
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-xl">
        {/* Pinned on a phone, as the event card's is: a long story scrolls
            under it on the shortest screens (`OVERLAY_PINNED_BAR`). Previous
            and Next come straight after it, so it keeps 4 px of its gap as
            margin, as the gallery's does: the bar paints over what it
            overlaps, and a focused step's ring reaches 4 px above it. */}
        <div className={`mb-3 phone:mb-1 phone:pb-2 ${OVERLAY_PINNED_BAR}`}>
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
              {secondLine && (
                // Empty for a story without a second name: the line's own
                // height (the text size's 1rem line), with nothing in it.
                <span
                  aria-hidden="true"
                  className="block min-h-4 text-xs text-dim"
                >
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

        {/* Above the story, so the story's length cannot move it (see the
            header). Not in the pinned bar: on a phone the bar stays the
            heading row alone, as in the mould. */}
        <div className="mb-3 flex justify-between gap-3">
          <button type="button" onClick={() => step(-1)} className={stepClass}>
            Previous
          </button>
          <button type="button" onClick={() => step(1)} className={stepClass}>
            Next
          </button>
        </div>

        <p className="m-0 font-mono text-xs leading-relaxed text-txt">
          {story.story}
        </p>

        <p aria-live="polite" className="sr-only">
          {stepped ? story.accessibleName : ""}
        </p>
      </div>
    </div>
  );
}
