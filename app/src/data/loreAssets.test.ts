/**
 * loreAssets.test.ts — the corner lore kept honest about the gallery's files
 * (Slice 18).
 *
 * A replay finds its stories by its corner record, never by name. That fails safe at
 * runtime: a regenerated asset whose record moved gets no stories, never wrong ones.
 * But on the deployed site that would be a quiet loss, so it is caught here, at build
 * time, on the committed pairs, the same move `galleryAssets.test.ts` makes for the
 * manifest:
 *
 * - every gallery asset matches a lore layout, or is listed in `LORE_EXEMPT` with
 *   its reason;
 * - every lore layout is matched by at least one committed asset, so none goes
 *   unverified;
 * - the committed fixture matches nothing, so the draw-call digests (which run on
 *   it) keep measuring the no-lore page;
 * - on every matched asset, at the canvas sizes the layout check gates, the tap
 *   squares the app ships (`storySquares`, the call `TrackCanvas` makes after
 *   each measure) keep their three rules.
 *
 * Assets are read with `readFileSync`, never imported, so they stay out of the
 * bundle. This is a test-time read, not a fetch; the offline trap stays armed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../gallery/manifest.json";
import { parseGalleryManifest } from "../engine/gallery";
import { canvasInsets, fitTransform } from "../engine/geometry";
import { parseReplay } from "../engine/load";
import { cornerLabel, layoutOffsetM, resolveLore } from "../engine/lore";
import { LORE_TARGET_MAX_PX } from "../engine/loreTargets";
import type { Replay } from "../engine/schema";
import { LORE } from "../lore";
import { buildScenePaths } from "../render/paths";
import { buildScene } from "../render/scene";
import { storySquares } from "../render/storyTargets";
import { installCanvasEnvironment } from "../test/canvas";
import { loadFixtureReplay } from "./fixture";

const GALLERY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/gallery",
);

/**
 * Gallery assets that are allowed to carry no lore, each with its reason. Empty:
 * every committed scenario is at Monza or Silverstone. A scenario at a circuit
 * with no lore file goes here rather than weakening the rule for the rest.
 */
const LORE_EXEMPT: ReadonlyMap<string, string> = new Map();

/**
 * The canvas box at each of the layout check's ten viewports, in CSS px, as it
 * measured them on the loaded scenario (2026-10-15). The canvas fills its grid
 * cell, so the box depends on the viewport, not on the replay.
 *
 * A SNAPSHOT: nothing here can measure a layout, so a layout change that moves
 * these boxes leaves this table stale without failing. The live gate is the
 * layout check's state D, which sizes the real squares in Chrome at every
 * viewport ("badges inside the canvas", "of different stories disjoint"), on the
 * largest scenario; its "inside the canvas" row prints the box to refresh this
 * from.
 */
const GATED_CANVASES: readonly (readonly [string, number, number])[] = [
  ["375x812", 375, 381],
  ["1280x720", 1056, 623],
  ["1440x900", 1216, 803],
  ["375x667", 375, 270],
  ["360x640", 360, 243],
  ["667x375", 411, 286],
  ["740x360", 484, 271],
  ["375x626", 375, 229],
  ["814x312", 590, 223],
  ["724x257", 468, 212],
];

const SCENARIOS = parseGalleryManifest(manifest).scenarios;
const FILES = [...new Set(SCENARIOS.map((s) => s.file))];

const replays = new Map<string, Replay>();
const replayOf = (file: string): Replay => {
  let replay = replays.get(file);
  if (replay === undefined) {
    replay = parseReplay(
      JSON.parse(readFileSync(join(GALLERY_DIR, file), "utf8")),
      file,
    );
    replays.set(file, replay);
  }
  return replay;
};

/** Why a record matches no layout: what a failure prints next to the record. */
function diagnose(replay: Replay): string {
  const corners = replay.track.corners;
  const labels = corners.map(cornerLabel).join(",");
  const lines = LORE.flatMap((circuit) =>
    circuit.layouts.map((layout) => {
      const want = layout.corners.map(cornerLabel).join(",");
      const why =
        corners.length !== layout.corners.length
          ? `${corners.length} corners, layout has ${layout.corners.length}`
          : labels !== want
            ? `labels ${labels}, layout has ${want}`
            : "a corner is past the tolerance";
      return `  ${circuit.id}/${layout.id}: ${why}`;
    }),
  );
  return [
    "matches no lore layout. Its corner record, ready to paste as a layout:",
    JSON.stringify(corners),
    ...lines,
  ].join("\n");
}

describe.each(FILES)("gallery asset %s", (file) => {
  it("matches a lore layout, or is exempt", () => {
    const lore = resolveLore(replayOf(file).track.corners, LORE);
    if (LORE_EXEMPT.has(file)) {
      expect(lore, `${file} is exempt but now has lore`).toBeNull();
      return;
    }
    expect(lore, `${file} ${diagnose(replayOf(file))}`).not.toBeNull();
    expect(lore!.offsetM).toBe(0);
  });
});

describe("the lore as a whole", () => {
  it("exempts only files the gallery ships", () => {
    for (const file of LORE_EXEMPT.keys()) expect(FILES).toContain(file);
  });

  it("has every layout matched by at least one committed asset", () => {
    for (const circuit of LORE) {
      for (const layout of circuit.layouts) {
        const matched = FILES.filter(
          (file) =>
            layoutOffsetM(replayOf(file).track.corners, layout) !== null,
        );
        expect(
          matched,
          `${circuit.id}/${layout.id} is matched by no gallery asset`,
        ).not.toHaveLength(0);
      }
    }
  });

  it("gives the committed fixture no lore", () => {
    expect(resolveLore(loadFixtureReplay().track.corners, LORE)).toBeNull();
  });
});

describe("tap areas at the gated canvas sizes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(FILES.filter((file) => !LORE_EXEMPT.has(file)))(
    "%s: at most 44 px, inside the canvas, and disjoint between stories",
    (file) => {
      // Only for `Path2D`, which jsdom does not provide.
      installCanvasEnvironment(800, 600);
      const replay = replayOf(file);
      const lore = resolveLore(replay.track.corners, LORE)!;
      const scene = buildScene(replay);
      for (const [viewport, w, h] of GATED_CANVASES) {
        const paths = buildScenePaths(
          scene,
          fitTransform(scene.bounds, w, h, canvasInsets(w, h)),
        );
        // The squares the app places: the same call `TrackCanvas` makes.
        const perStory = storySquares(lore.stories, paths, w, h);
        // One square per painted number, plus the S/F label where it has a story.
        lore.stories.forEach((story, k) =>
          expect(
            perStory[k],
            `${file} at ${viewport}, ${story.id}`,
          ).toHaveLength(story.startFinish ? 1 : story.cornerIndices.length),
        );
        const squares = perStory.flatMap((own, story) =>
          own.map((square) => ({ story, ...square })),
        );
        squares.forEach((p) => {
          const half = p.side / 2;
          const where = `${file} at ${viewport}, story ${lore.stories[p.story].id}`;
          expect(p.side, where).toBeLessThanOrEqual(LORE_TARGET_MAX_PX);
          expect(p.x - half, where).toBeGreaterThanOrEqual(0);
          expect(p.y - half, where).toBeGreaterThanOrEqual(0);
          expect(p.x + half, where).toBeLessThanOrEqual(w + 1e-9);
          expect(p.y + half, where).toBeLessThanOrEqual(h + 1e-9);
          squares.forEach((q) => {
            if (q.story === p.story) return;
            expect(
              Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y)),
              `${where} against ${lore.stories[q.story].id}`,
            ).toBeGreaterThanOrEqual((p.side + q.side) / 2 - 1e-9);
          });
        });
      }
    },
  );
});
