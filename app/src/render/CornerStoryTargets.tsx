/**
 * CornerStoryTargets.tsx — the corner numbers, made into buttons (Slice 18).
 *
 * One transparent `<button>` per corner story, in lap order, laid over the badges
 * the canvas paints (ruled 2026-10-14). Nothing here is drawn: the disc and its
 * number are the canvas's, unchanged, and this layer adds only what a canvas
 * cannot have — a tap target, a tab stop, a focus ring and a name. Where each
 * button goes is `storyTargets.ts`'s, written by `TrackCanvas` straight after it
 * measures, so this component renders once per replay and never per frame.
 *
 * - The layer passes pointer events through everywhere but the buttons, and
 *   clips to the canvas.
 * - A button's name is `sr-only` TEXT, never `aria-label` or `title` (the
 *   transport's ruling, 2026-10-13): "Turn 11: Curva Alboreto (Parabolica)",
 *   the ruled format (2026-10-15), built by `engine/lore.ts`.
 * - Under ANY open dialog (the gallery, an event card, the corner card itself)
 *   the whole layer is `visibility: hidden`, by a `:has()` rule on App's track
 *   cell (`group/track`): out of the tab order, the accessibility tree and hit
 *   testing, with no React render. jsdom cannot evaluate `:has()`; the layout
 *   check's "lore targets hidden under the gallery" row reads Chrome's answer.
 */
import { forwardRef } from "react";
import type { LoreStory } from "../engine/lore";
import {
  BADGE_FOCUS_RING,
  BADGE_HOVER,
  BADGE_MEMBER_FOCUS_RING,
  BADGE_MEMBER_HOVER,
} from "../components/focus";
import { storyButtonId } from "./storyTargets";

export interface CornerStoryTargetsProps {
  /** At least one story, in lap order. */
  stories: readonly LoreStory[];
  /** Open story `index`; stable, so the canvas above stays memoised. */
  onOpenStory: (index: number) => void;
}

export const CornerStoryTargets = forwardRef<
  HTMLDivElement,
  CornerStoryTargetsProps
>(function CornerStoryTargets({ stories, onOpenStory }, ref) {
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-0 overflow-hidden group-has-[[role=dialog]]/track:invisible"
    >
      {stories.map((story, index) => (
        <button
          key={story.id}
          id={storyButtonId(story.id)}
          type="button"
          aria-haspopup="dialog"
          onClick={() => onOpenStory(index)}
          // Sized and placed by `placeStoryTargets` (`storyTargets.ts`): 0x0
          // at the layer's corner until the canvas has measured.
          className={`pointer-events-auto absolute left-0 top-0 cursor-pointer overflow-visible ${BADGE_FOCUS_RING} ${BADGE_HOVER}`}
        >
          <span className="sr-only">{story.accessibleName}</span>
          {story.cornerIndices.slice(1).map((corner) => (
            <span
              key={corner}
              aria-hidden="true"
              className={`absolute left-1/2 top-1/2 ${BADGE_MEMBER_FOCUS_RING} ${BADGE_MEMBER_HOVER}`}
            />
          ))}
        </button>
      ))}
    </div>
  );
});
