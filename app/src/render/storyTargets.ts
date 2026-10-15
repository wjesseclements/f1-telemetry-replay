/**
 * storyTargets.ts — where each corner story's button sits over the canvas
 * (Slice 18, ruled 2026-10-14: invisible buttons over the painted numbers).
 *
 * The canvas paints the corner numbers; it cannot be clicked, focused or named.
 * So each story gets a transparent `<button>` laid over its painted badges
 * (`CornerStoryTargets.tsx`), and this module says where. It reads the SAME
 * points the canvas paints at: `paths.corners[i].badge`, the centre `drawCorners`
 * passes to `arc` and `fillText`, and `paths.startFinish.label`, where the `S/F`
 * label is drawn. Nothing is projected twice, so nothing can drift.
 *
 * It runs from `TrackCanvas`'s `measure()`, on mount and on resize, and never per
 * frame: the points only move when the canvas is resized. The writes are direct
 * style writes, not React state, which is what keeps the canvas at one commit
 * (CLAUDE.md rule 1, pinned in `TrackCanvas.test.tsx`).
 *
 * A story's FIRST square is its button. Any further squares (a story over several
 * numbers: Prima Variante over 1 and 2) are `aria-hidden` children of it,
 * positioned from the button's centre, so a tap on any of them is a click on the
 * button and the story stays one tab stop with one name.
 */
import type { LoreStory } from "../engine/lore";
import { loreTargetSides } from "../engine/loreTargets";
import type { ScenePaths } from "./paths";

/**
 * The DOM id of a story's button. Stable for a story, so `App` can hand focus
 * back to the badge a card was showing, after Previous/Next, by id.
 */
export function storyButtonId(storyId: string): string {
  return `corner-story-${storyId}`;
}

/** One tap area: a square, centred on a painted badge, in canvas CSS px. */
export interface StorySquare {
  readonly x: number;
  readonly y: number;
  readonly side: number;
}

/**
 * Every story's squares, story by story and member by member, the first of each
 * the button's. A start/finish story has one square, on the `S/F` label; a
 * corner story one per corner, in its lap order. Sizes are `loreTargetSides`':
 * up to 44 px, never sharing area with another story's, never off the canvas.
 */
export function storySquares(
  stories: readonly LoreStory[],
  paths: Pick<ScenePaths, "corners" | "startFinish">,
  width: number,
  height: number,
): StorySquare[][] {
  const members = stories.map((story) =>
    story.startFinish
      ? [paths.startFinish.label]
      : story.cornerIndices.map((i) => paths.corners[i].badge),
  );
  const points = members.flatMap((at, story) =>
    at.map(({ x, y }) => ({ story, x, y })),
  );
  const sides = loreTargetSides(points, width, height);
  let next = 0;
  return members.map((at) =>
    at.map(({ x, y }) => ({ x, y, side: sides[next++] })),
  );
}

/**
 * Write the squares into the layer `CornerStoryTargets` rendered: button `i` is
 * the layer's `i`th child, and its member squares are its `aria-hidden` spans,
 * in order. Both orders are that component's, which renders them from the same
 * `stories`.
 *
 * The button's centre is set as a translation to EXACTLY the painted point, then
 * back by half its own size, so the centre is the point by construction rather
 * than by subtracting and re-adding half a side in floating point. A member is
 * placed at the button's centre (`left-1/2 top-1/2`) and moved by its offset from
 * it.
 */
export function placeStoryTargets(
  layer: HTMLElement,
  squares: readonly (readonly StorySquare[])[],
): void {
  squares.forEach((story, i) => {
    const button = layer.children[i] as HTMLElement | undefined;
    if (button === undefined) return;
    const [head, ...rest] = story;
    place(button, head.x, head.y, head.side);
    const spans = button.querySelectorAll<HTMLElement>(
      ":scope > [aria-hidden]",
    );
    rest.forEach((member, j) => {
      const span = spans[j];
      if (span !== undefined) {
        place(span, member.x - head.x, member.y - head.y, member.side);
      }
    });
  });
}

function place(el: HTMLElement, x: number, y: number, side: number): void {
  el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  el.style.width = `${side}px`;
  el.style.height = `${side}px`;
}
