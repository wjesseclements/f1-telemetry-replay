import { describe, expect, it } from "vitest";
import {
  judgeBadgeNames,
  judgeDisjoint,
  judgeHidden,
  judgeHits,
  judgeInside,
  judgeOnPaint,
} from "./badges";
import type {
  BadgePaint,
  Box,
  StoryTargetReading,
  StoryTargetsProbe,
} from "./probe";

/** A square of side `s` centred on (x, y). */
const sq = (x: number, y: number, s: number): Box => ({
  top: y - s / 2,
  left: x - s / 2,
  bottom: y + s / 2,
  right: x + s / 2,
  width: s,
  height: s,
});

const story = (
  id: string,
  squares: Box[],
  over: Partial<StoryTargetReading> = {},
): StoryTargetReading => ({
  id,
  found: true,
  visible: true,
  squares,
  hits: squares.map(() => true),
  ...over,
});

const CANVAS: Box = {
  top: 50,
  left: 0,
  bottom: 650,
  right: 800,
  width: 800,
  height: 600,
};

/** Two stories, one over two numbers, every square clear of the other's. */
const good = (): StoryTargetsProbe => ({
  canvas: CANVAS,
  targets: [
    story("pair", [sq(100, 100, 44), sq(110, 104, 44)]),
    story("lone", [sq(300, 300, 26)]),
  ],
});

describe("judgeHidden", () => {
  it("passes when every badge is found and none is visible", () => {
    const probe = good();
    probe.targets = probe.targets.map((t) => ({ ...t, visible: false }));
    expect(judgeHidden(probe)).toEqual({
      pass: true,
      measured: "0 of 2 visible",
    });
  });

  it("fails naming each badge still visible under the dialog", () => {
    const probe = good();
    probe.targets[0].visible = false;
    expect(judgeHidden(probe)).toEqual({
      pass: false,
      measured: "1 of 2 visible: lone",
    });
  });

  it("never passes with nothing to hide, or with a badge missing", () => {
    expect(judgeHidden({ canvas: CANVAS, targets: [] })).toEqual({
      pass: false,
      measured: "no stories to hide",
    });
    const probe = good();
    probe.targets = probe.targets.map((t) => ({ ...t, visible: false }));
    probe.targets[1] = { ...probe.targets[1], found: false, squares: [] };
    const verdict = judgeHidden(probe);
    expect(verdict.pass).toBe(false);
    expect(verdict.measured).toMatch(/not found: lone$/);
  });
});

describe("judgeInside", () => {
  it("passes squares inside the canvas, reporting the size range", () => {
    expect(judgeInside(good())).toEqual({
      pass: true,
      measured:
        "3 squares of 2 stories, sides 26.0 to 44.0 px, canvas x=[0.0,800.0] y=[50.0,650.0]",
    });
  });

  it("allows the 1 px of rounding every other layout row allows", () => {
    const probe = good();
    probe.targets[1].squares = [sq(22 - 0.9, 300, 44)];
    expect(judgeInside(probe).pass).toBe(true);
  });

  it("fails a square past an edge, naming it", () => {
    const probe = good();
    probe.targets[1].squares = [sq(10, 300, 44)];
    const verdict = judgeInside(probe);
    expect(verdict.pass).toBe(false);
    expect(verdict.measured).toMatch(/ · lone\[0\] at x=\[-12\.0,32\.0\]/);
  });

  it("fails without a canvas, without stories, or with one missing", () => {
    expect(judgeInside({ ...good(), canvas: null })).toEqual({
      pass: false,
      measured: "no canvas",
    });
    expect(judgeInside({ canvas: CANVAS, targets: [] }).pass).toBe(false);
    expect(judgeInside({ canvas: CANVAS, targets: [] }).measured).toMatch(
      /, no squares,/,
    );
    const probe = good();
    probe.targets[0] = { ...probe.targets[0], found: false, squares: [] };
    expect(judgeInside(probe).pass).toBe(false);
  });
});

describe("judgeDisjoint", () => {
  it("passes when squares of different stories never share area; one story's may", () => {
    // The pair's own two squares overlap heavily: either opens the same card.
    expect(judgeDisjoint(good())).toEqual({
      pass: true,
      measured: "0 of 2 cross-story pairs overlap",
    });
  });

  it("lets squares of different stories touch along an edge", () => {
    const probe = good();
    probe.targets[1].squares = [sq(110 + 44, 100, 44)];
    expect(judgeDisjoint(probe).pass).toBe(true);
  });

  it("fails squares of different stories that share area, naming the pair", () => {
    const probe = good();
    probe.targets[1].squares = [sq(130, 100, 26)];
    expect(judgeDisjoint(probe)).toEqual({
      pass: false,
      measured: "2 of 2 cross-story pairs overlap: pair/lone, pair/lone",
    });
  });

  it("never passes with nothing to compare, or a badge missing", () => {
    expect(judgeDisjoint({ canvas: CANVAS, targets: [] }).pass).toBe(false);
    const probe = good();
    probe.targets[1] = { ...probe.targets[1], found: false, squares: [] };
    expect(judgeDisjoint(probe).pass).toBe(false);
  });
});

describe("judgeHits", () => {
  it("passes when every square's centre reaches its own button", () => {
    expect(judgeHits(good())).toEqual({
      pass: true,
      measured: "3/3 centres hit their own button",
    });
  });

  it("fails naming each square whose centre lands elsewhere", () => {
    const probe = good();
    probe.targets[0].hits = [true, false];
    expect(judgeHits(probe)).toEqual({
      pass: false,
      measured: "2/3 centres hit their own button · missed: pair[1] 44.0x44.0",
    });
  });

  it("never passes with nothing to hit, or a badge missing", () => {
    expect(judgeHits({ canvas: CANVAS, targets: [] }).pass).toBe(false);
    const probe = good();
    probe.targets[1] = {
      ...probe.targets[1],
      found: false,
      squares: [],
      hits: [],
    };
    const verdict = judgeHits(probe);
    expect(verdict.pass).toBe(false);
    expect(verdict.measured).toBe(
      "2/2 centres hit their own button · not found: lone",
    );
  });
});

describe("judgeBadgeNames", () => {
  const named = (what: string, name: string, description = "") => ({
    what,
    expected: [what === "a" ? "Turn 1: A" : "Turn 2: B"],
    reading: { name, description },
  });

  it("passes every badge named exactly as its story, with no description, as a count", () => {
    expect(
      judgeBadgeNames([named("a", "Turn 1: A"), named("b", "Turn 2: B")]),
    ).toEqual({
      pass: true,
      measured: "2 badges, each named as its story, no description",
    });
  });

  it("fails printing only the badges that failed, as Chrome read them", () => {
    expect(
      judgeBadgeNames([
        named("a", "Turn 1: A"),
        named("b", "Turn 2: B", "Turn 2: B"),
      ]),
    ).toEqual({
      pass: false,
      measured: 'b: name "Turn 2: B", description "Turn 2: B"',
    });
    // Chrome's spacing of separate boxes is a wrong name, not a near miss.
    expect(judgeBadgeNames([named("a", "Turn 1 : A")]).pass).toBe(false);
    expect(
      judgeBadgeNames([{ what: "a", expected: ["x"], reading: "not found" }])
        .measured,
    ).toBe("a: not found");
  });

  it("never passes with no badges to read", () => {
    expect(judgeBadgeNames([])).toEqual({ pass: false, measured: "no badges" });
  });
});

describe("judgeOnPaint", () => {
  /** good()'s squares, as painted: the pair on discs 0 and 1, lone on the S/F label. */
  const anchors = [
    { startFinish: false, corners: [0, 1] },
    { startFinish: true, corners: [] },
  ];
  const paint = (): BadgePaint => ({
    // Canvas-relative: CANVAS is at (0, 50).
    arcs: [
      [100, 50],
      [110, 54],
    ],
    startFinish: [300, 250],
  });

  it("passes squares centred on their painted discs and S/F label", () => {
    expect(judgeOnPaint(good(), anchors, paint())).toEqual({
      pass: true,
      measured: "3 squares, worst 0.000 px from its painted point (max 0.5)",
    });
  });

  it("allows layout rounding, and fails a square half a pixel off, naming it", () => {
    const near = paint();
    near.arcs[1] = [110.3, 54];
    expect(judgeOnPaint(good(), anchors, near).pass).toBe(true);
    const off = paint();
    off.startFinish = [300, 262];
    expect(judgeOnPaint(good(), anchors, off)).toEqual({
      pass: false,
      measured:
        "3 squares, worst 12.000 px from its painted point (max 0.5) · lone[0] 12.0 px off",
    });
  });

  it("fails a square with no painted point, no frame, or no canvas", () => {
    const short = paint();
    short.arcs = [[100, 50]];
    expect(judgeOnPaint(good(), anchors, short).measured).toMatch(
      /pair\[1\] has no painted point/,
    );
    expect(judgeOnPaint(good(), anchors, null)).toEqual({
      pass: false,
      measured: "no frame recorded",
    });
    expect(judgeOnPaint({ ...good(), canvas: null }, anchors, paint())).toEqual(
      { pass: false, measured: "no canvas" },
    );
    const noSf = paint();
    noSf.startFinish = null;
    expect(judgeOnPaint(good(), anchors, noSf).pass).toBe(false);
  });

  it("never passes with nothing to place, or a story the check did not expect", () => {
    expect(
      judgeOnPaint({ canvas: CANVAS, targets: [] }, [], paint()).pass,
    ).toBe(false);
    expect(judgeOnPaint(good(), anchors.slice(0, 1), paint()).pass).toBe(false);
  });
});
