/**
 * galleryReferenceLap.test.ts — the reference lap each SHIPPED asset carries, and
 * the engine reading it (Slice 24, consumer half).
 *
 * The five assets were regenerated offline with an explicit `track.referenceLap`
 * chosen by the pipeline's rule; a structural diff against the previous commit
 * showed nothing else moved but `startFinish` (red flag, restart) and the finale's
 * known `trackStatus` drift. These pins are the record of that choice, and the
 * check that the gap engine measures its circuit and its pace from it rather than
 * from `cars[0]`'s first lap (`legacyReferenceLap.test.ts` keeps what that was).
 *
 * Two of them are the defect the slice exists for, now read from a racing lap:
 *  - red flag: the legacy lap ran 92.3 s from RUS's pole slot. The rule takes
 *    RUS's lap 2, 86.6 s, timing line to timing line. RUS's plan is declined, but
 *    its one fault (a jump at t=290.6 s, in the pit lane under red) lies 115 s
 *    after that lap, and the exclusion is lap-level (Slice 24 follow-up; the
 *    consumer half's car-level rule took VER's lap 2 instead — the re-run moved
 *    only this file's `referenceLap` and `startFinish`, byte-checked);
 *  - restart: the legacy lap was 166.1 s of formation lap and grid hold; RUS's lap
 *    7 is 86.4 s, so the order key's pace is no longer 1.92x a racing lap's.
 *
 * Read from disk like `galleryAssets.test.ts` — a test-time read, not a fetch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../gallery/manifest.json";
import { parseGalleryManifest } from "../engine/gallery";
import { buildProgressIndex } from "../engine/gaps";
import { parseReplay } from "../engine/load";
import type { ReferenceLap } from "../engine/schema";

const GALLERY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/gallery",
);

/** The pipeline's choice per asset, as regenerated 2026-10-07. */
const CHOSEN: Record<string, ReferenceLap> = {
  "monza-2026-red-flag": { car: 0, fromT: 89, toT: 175.6 },
  "monza-2026-restart": { car: 0, fromT: 166.2, toT: 252.6 },
  "silverstone-2024-rain": { car: 0, fromT: 0, toT: 91.6 },
  "silverstone-2024-finale": { car: 0, fromT: 0, toT: 89.6 },
  "monza-2024-pit-cycle": { car: 0, fromT: 0, toT: 85 },
};

const SCENARIOS = parseGalleryManifest(manifest).scenarios;

describe.each(SCENARIOS.map((s) => [s.id, s.file] as const))(
  "explicit reference lap: %s",
  (id, file) => {
    it("is the file's own, and the gap engine's circuit and pace are that lap", () => {
      const raw = JSON.parse(readFileSync(join(GALLERY_DIR, file), "utf8"));
      // Carried by the file, not synthesized: the loader would have produced
      // `{0, 0, …}` for every one of them.
      expect(raw.track.referenceLap).toEqual(CHOSEN[id]);
      const replay = parseReplay(raw, file);
      const { fromT, toT } = replay.track.referenceLap;
      const index = buildProgressIndex(replay);
      expect(index.lapUnits).toBeGreaterThan(0);
      expect(index.lapSeconds).toBeCloseTo(toT - fromT, 9);
      expect(index.paceSecondsPerUnit).toBeCloseTo(
        index.lapSeconds / index.lapUnits,
        15,
      );
    });
  },
);
