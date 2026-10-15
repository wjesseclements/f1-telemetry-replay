/**
 * storyTargets tests — where the corner-story buttons go (Slice 18).
 *
 * The squares come from the very points the canvas paints (`paths.corners[i]
 * .badge`, `paths.startFinish.label`), sized by `engine/loreTargets.ts`; the
 * writes put each button's centre ON its point. `TrackCanvas.test.tsx` pins the
 * same against the recorded `arc`/`fillText` calls of a real frame; this file
 * pins the arithmetic on hand-built points.
 */
import { describe, expect, it } from "vitest";
import type { LoreStory } from "../engine/lore";
import { LORE_TARGET_MAX_PX, loreTargetSides } from "../engine/loreTargets";
import {
  placeStoryTargets,
  storyButtonId,
  storySquares,
  type StorySquare,
} from "./storyTargets";

const story = (
  id: string,
  cornerIndices: number[],
  startFinish = false,
): LoreStory => ({
  id,
  name: id,
  subtitle: undefined,
  story: "s",
  startFinish,
  cornerIndices,
  eyebrow: "e",
  accessibleName: id,
});

/** Five painted badges and an S/F label, far enough apart to get 44 px each. */
const paths = {
  corners: [
    { badge: { x: 100, y: 100 }, on: { x: 0, y: 0 }, text: "1" },
    { badge: { x: 110, y: 104 }, on: { x: 0, y: 0 }, text: "2" },
    { badge: { x: 300, y: 100 }, on: { x: 0, y: 0 }, text: "3" },
    { badge: { x: 300, y: 300 }, on: { x: 0, y: 0 }, text: "4" },
    { badge: { x: 500, y: 300 }, on: { x: 0, y: 0 }, text: "5" },
  ],
  startFinish: {
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    label: { x: 200, y: 400 },
  },
};

const STORIES = [
  story("line", [], true),
  story("chicane", [0, 1]),
  story("bend", [2]),
  story("esses", [3, 4]),
];

describe("storyButtonId", () => {
  it("is the story id, prefixed so it cannot collide with the page's own ids", () => {
    expect(storyButtonId("curva-alboreto")).toBe("corner-story-curva-alboreto");
  });
});

describe("storySquares", () => {
  it("puts a start/finish story on the S/F label and a corner story on each badge, in order", () => {
    const squares = storySquares(STORIES, paths, 800, 600);
    const centres = squares.map((s) => s.map(({ x, y }) => ({ x, y })));
    expect(centres).toEqual([
      [paths.startFinish.label],
      [paths.corners[0].badge, paths.corners[1].badge],
      [paths.corners[2].badge],
      [paths.corners[3].badge, paths.corners[4].badge],
    ]);
  });

  it("sizes every square with loreTargetSides, over every story's points at once", () => {
    const squares = storySquares(STORIES, paths, 800, 600);
    const points = [
      { story: 0, ...paths.startFinish.label },
      { story: 1, ...paths.corners[0].badge },
      { story: 1, ...paths.corners[1].badge },
      { story: 2, ...paths.corners[2].badge },
      { story: 3, ...paths.corners[3].badge },
      { story: 3, ...paths.corners[4].badge },
    ];
    expect(squares.flat().map((s) => s.side)).toEqual(
      loreTargetSides(points, 800, 600),
    );
    // Two badges of ONE story 10 px apart still get the full 44: either opens
    // the same card.
    expect(squares[1].map((s) => s.side)).toEqual([
      LORE_TARGET_MAX_PX,
      LORE_TARGET_MAX_PX,
    ]);
  });

  it("shrinks squares of different stories that would share area", () => {
    // Badge 3 moved to 20 px from badge 2: another story's, so neither side may
    // pass 20.
    const crowded = {
      ...paths,
      corners: paths.corners.map((c, i) =>
        i === 2 ? { ...c, badge: { x: 130, y: 104 } } : c,
      ),
    };
    const squares = storySquares(STORIES, crowded, 800, 600);
    expect(squares[1][1].side).toBe(20);
    expect(squares[2][0].side).toBe(20);
  });

  it("gives nothing to a story with no stories at all", () => {
    expect(storySquares([], paths, 800, 600)).toEqual([]);
  });
});

describe("placeStoryTargets", () => {
  /** The layer `CornerStoryTargets` renders: a button per story, members as aria-hidden spans. */
  function layerFor(memberCounts: number[]): HTMLElement {
    const layer = document.createElement("div");
    for (const members of memberCounts) {
      const button = document.createElement("button");
      const name = document.createElement("span");
      name.className = "sr-only";
      button.append(name);
      for (let i = 0; i < members; i++) {
        const span = document.createElement("span");
        span.setAttribute("aria-hidden", "true");
        button.append(span);
      }
      layer.append(button);
    }
    return layer;
  }

  const translate = (el: Element) => {
    const m = /^translate\((.+)px, (.+)px\) translate\(-50%, -50%\)$/.exec(
      (el as HTMLElement).style.transform,
    );
    if (m === null) throw new Error(`unexpected transform on ${el.outerHTML}`);
    return { x: Number(m[1]), y: Number(m[2]) };
  };

  it("centres each button EXACTLY on its first square's point, sized to its side", () => {
    // Awkward floats on purpose: the centre is the point itself, never a
    // left edge plus half a side.
    const squares: StorySquare[][] = [
      [{ x: 0.1 + 0.2, y: 1 / 3, side: 26.3 }],
      [{ x: 123.456789, y: 98.7654321, side: 44 }],
    ];
    const layer = layerFor([0, 0]);
    placeStoryTargets(layer, squares);
    squares.forEach(([head], i) => {
      const button = layer.children[i] as HTMLElement;
      expect(translate(button)).toEqual({ x: head.x, y: head.y });
      expect(button.style.width).toBe(`${head.side}px`);
      expect(button.style.height).toBe(`${head.side}px`);
    });
  });

  it("places member squares by their offset from the button's centre, never the name", () => {
    const squares: StorySquare[][] = [
      [
        { x: 100, y: 100, side: 44 },
        { x: 110.5, y: 96.25, side: 30 },
        { x: 80, y: 140, side: 12 },
      ],
    ];
    const layer = layerFor([2]);
    placeStoryTargets(layer, squares);
    const button = layer.children[0];
    const [name, ...members] = Array.from(button.children) as HTMLElement[];
    expect(name.getAttribute("style")).toBeNull();
    expect(members.map(translate)).toEqual([
      { x: 10.5, y: -3.75 },
      { x: -20, y: 40 },
    ]);
    expect(members.map((m) => m.style.width)).toEqual(["30px", "12px"]);
  });

  it("re-places on every call: a resize moves the buttons it placed before", () => {
    const layer = layerFor([0]);
    placeStoryTargets(layer, [[{ x: 1, y: 2, side: 3 }]]);
    placeStoryTargets(layer, [[{ x: 4, y: 5, side: 6 }]]);
    expect(translate(layer.children[0])).toEqual({ x: 4, y: 5 });
    expect((layer.children[0] as HTMLElement).style.width).toBe("6px");
  });

  it("skips what the layer does not hold rather than throwing", () => {
    // A layer the stories outran (never rendered so by CornerStoryTargets, but
    // the writer must not be the thing that crashes the canvas's effect).
    const layer = layerFor([0]);
    expect(() =>
      placeStoryTargets(layer, [
        [
          { x: 1, y: 1, side: 1 },
          { x: 2, y: 2, side: 2 },
        ],
        [{ x: 3, y: 3, side: 3 }],
      ]),
    ).not.toThrow();
    expect(translate(layer.children[0])).toEqual({ x: 1, y: 1 });
  });
});
