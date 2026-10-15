/**
 * badges.ts — the verdicts on the corner-story badges, state D (Slice 18).
 *
 * The badges are invisible buttons over the corner numbers the canvas paints,
 * one per story, each with one tap square per number it covers
 * (`src/render/storyTargets.ts`). jsdom has no layout and evaluates no `:has()`,
 * so the four facts a visitor depends on are read here from Chrome's boxes and
 * hit tests (`probeStoryTargets`): hidden while a dialog is open; inside the
 * canvas; no square sharing area with another story's (a contested tap); and
 * every square's centre reaching its own button (nothing painted over it,
 * nothing of another story's on top). Pure and unit-tested; the probe is the
 * plumbing.
 */
import { judgeNames, type NameCheck } from "./accessibility";
import { contains, overlaps, size, xySpan } from "./geometry";
import type { BadgePaint, StoryTargetsProbe } from "./probe";

export interface Verdict {
  pass: boolean;
  measured: string;
}

/** The stories the probe could not find, or "" when it found them all. */
function missing(probe: StoryTargetsProbe): string {
  const ids = probe.targets.filter((t) => !t.found).map((t) => t.id);
  return ids.length === 0 ? "" : ` · not found: ${ids.join(", ")}`;
}

/**
 * Under a dialog no badge is visible. At least one must exist, so the row can
 * never pass for want of anything to hide.
 */
export function judgeHidden(probe: StoryTargetsProbe): Verdict {
  const n = probe.targets.length;
  const found = probe.targets.filter((t) => t.found);
  const visible = found.filter((t) => t.visible).map((t) => t.id);
  return {
    pass: n > 0 && found.length === n && visible.length === 0,
    measured:
      n === 0
        ? "no stories to hide"
        : `${visible.length} of ${n} visible` +
          (visible.length > 0 ? `: ${visible.join(", ")}` : "") +
          missing(probe),
  };
}

/** Every square of every story lies within the canvas, give or take 1 px. */
export function judgeInside(probe: StoryTargetsProbe): Verdict {
  const { canvas, targets } = probe;
  if (canvas === null) return { pass: false, measured: "no canvas" };
  const squares = targets.flatMap((t) =>
    t.squares.map((box, k) => ({ id: t.id, k, box })),
  );
  const outside = squares.filter((s) => !contains(canvas, s.box));
  const sides = squares.map((s) => s.box.width);
  const range =
    sides.length === 0
      ? "no squares"
      : `sides ${Math.min(...sides).toFixed(1)} to ${Math.max(...sides).toFixed(1)} px`;
  return {
    pass:
      targets.length > 0 &&
      targets.every((t) => t.found) &&
      outside.length === 0,
    measured:
      `${squares.length} squares of ${targets.length} stories, ${range}, canvas ${xySpan(canvas)}` +
      outside.map((s) => ` · ${s.id}[${s.k}] at ${xySpan(s.box)}`).join("") +
      missing(probe),
  };
}

/**
 * No square shares area with a square of ANOTHER story (squares of one story
 * may: either opens the same card). Touching edges are not sharing area
 * (`overlaps`, 1 px).
 */
export function judgeDisjoint(probe: StoryTargetsProbe): Verdict {
  const { targets } = probe;
  let pairs = 0;
  const clashes: string[] = [];
  for (let a = 0; a < targets.length; a++) {
    for (let b = a + 1; b < targets.length; b++) {
      for (const p of targets[a].squares) {
        for (const q of targets[b].squares) {
          pairs++;
          if (overlaps(p, q)) {
            clashes.push(`${targets[a].id}/${targets[b].id}`);
          }
        }
      }
    }
  }
  return {
    pass:
      targets.length > 0 &&
      targets.every((t) => t.found) &&
      clashes.length === 0,
    measured:
      `${clashes.length} of ${pairs} cross-story pairs overlap` +
      (clashes.length > 0 ? `: ${clashes.join(", ")}` : "") +
      missing(probe),
  };
}

/** A hit test at every square's centre reaches the story's own button. */
export function judgeHits(probe: StoryTargetsProbe): Verdict {
  const { targets } = probe;
  const total = targets.reduce((n, t) => n + t.hits.length, 0);
  const misses = targets.flatMap((t) =>
    t.hits.flatMap((hit, k) =>
      hit ? [] : [`${t.id}[${k}] ${size(t.squares[k])}`],
    ),
  );
  return {
    pass:
      targets.length > 0 &&
      targets.every((t) => t.found) &&
      misses.length === 0,
    measured:
      `${total - misses.length}/${total} centres hit their own button` +
      (misses.length > 0 ? ` · missed: ${misses.join(", ")}` : "") +
      missing(probe),
  };
}

/**
 * Every badge carries exactly its story's ruled name and no description, as
 * Chrome's accessibility tree reads it (`judgeNames`, per badge). One row for a
 * whole circuit's badges, so a pass prints the count and a FAIL prints only the
 * badges that failed, each with the name and description Chrome gave it.
 */
export function judgeBadgeNames(checks: readonly NameCheck[]): Verdict {
  if (checks.length === 0) return { pass: false, measured: "no badges" };
  const failed = checks.filter((check) => !judgeNames([check]).pass);
  return failed.length === 0
    ? {
        pass: true,
        measured: `${checks.length} badges, each named as its story, no description`,
      }
    : { pass: false, measured: judgeNames(failed).measured };
}

/** Where a story's badge squares belong: on the S/F label, or on these discs. */
export interface StoryAnchor {
  startFinish: boolean;
  /** Indices of the painted discs, in the replay's corner order. */
  corners: readonly number[];
}

/**
 * How far a square's centre may sit from its painted point, CSS px. The squares
 * are placed from the very numbers the frame is painted from, so the only
 * difference is layout rounding (measured: 0.011 px at worst); half a pixel is
 * far below a misplacement anyone could see, and far above that rounding.
 */
export const ON_PAINT_PX = 0.5;

/**
 * Every square is centred on what the canvas painted for it: a corner story's
 * k-th square on its k-th corner's disc, a start/finish story's on the `S/F`
 * label's point (`installPaintRecorder`, the last whole frame). And every story
 * has exactly one square per painted point, so a badge that lost a member
 * square (a number with no tap area) cannot pass by having fewer to check.
 */
export function judgeOnPaint(
  probe: StoryTargetsProbe,
  anchors: readonly StoryAnchor[],
  paint: BadgePaint | null,
): Verdict {
  const { canvas, targets } = probe;
  if (canvas === null) return { pass: false, measured: "no canvas" };
  if (paint === null) return { pass: false, measured: "no frame recorded" };
  let worst = 0;
  let squares = 0;
  const off: string[] = [];
  targets.forEach((target, i) => {
    const anchor = anchors[i];
    const want =
      anchor === undefined
        ? null
        : anchor.startFinish
          ? 1
          : anchor.corners.length;
    if (target.found && want !== null && target.squares.length !== want) {
      off.push(
        `${target.id}: ${target.squares.length} squares for ${want} painted points`,
      );
    }
    target.squares.forEach((square, k) => {
      squares++;
      const at = anchor?.startFinish
        ? paint.startFinish
        : (paint.arcs[anchor?.corners[k] ?? -1] ?? null);
      if (at === null) {
        off.push(`${target.id}[${k}] has no painted point`);
        return;
      }
      const d = Math.hypot(
        square.left + square.width / 2 - (canvas.left + at[0]),
        square.top + square.height / 2 - (canvas.top + at[1]),
      );
      worst = Math.max(worst, d);
      if (!(d <= ON_PAINT_PX)) {
        off.push(`${target.id}[${k}] ${d.toFixed(1)} px off`);
      }
    });
  });
  return {
    pass:
      targets.length > 0 &&
      targets.length === anchors.length &&
      targets.every((t) => t.found) &&
      off.length === 0,
    measured:
      `${squares} squares, worst ${worst.toFixed(3)} px from its painted point (max ${ON_PAINT_PX})` +
      (off.length > 0 ? ` · ${off.join(", ")}` : "") +
      missing(probe),
  };
}
