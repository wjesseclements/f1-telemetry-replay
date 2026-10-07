/**
 * legacyReferenceLap.test.ts — the legacy synthesis, proven on the SHIPPED files.
 *
 * Slice 24 made the reference lap explicit (`track.referenceLap`), and a file
 * without one must keep the reference SPAN it had — what that does and does not
 * keep downstream is `engine/referenceLap.ts`'s header. "Exactly" was checked here
 * against the engine that defined the old behaviour: for every committed gallery
 * asset, the span the loader synthesizes was the span `gaps.ts`'s `buildReference`
 * then SEARCHED for (`ProgressIndex.lapSeconds`, i.e. `findLapEnd(cars[0]) / rate`).
 * Since the consumer half, `buildReference` reads the settled span instead, so
 * `toT === lapSeconds` now pins that the consumer reads what the loader settled; the
 * `LEGACY_TO_T` values below — measured while the engine still searched, and
 * unchanged by the regeneration (every sample is byte-identical) — are what keep
 * "exactly as before" honest.
 *
 * The field is DELETED from the raw JSON before parsing, so this keeps testing the
 * legacy path even after the assets are regenerated with an explicit field.
 *
 * The pinned values are the record of what the implicit reference WAS on each
 * asset as committed when Slice 24 landed — two of them are the defect the slice
 * exists for: the red-flag window's legacy lap starts on RUS's grid slot, and the
 * restart window's runs 166.1 s because it contains the formation lap and the
 * grid hold. A regenerated asset re-measures here; update the pin with the PLAN
 * entry that explains the change.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../gallery/manifest.json";
import { parseGalleryManifest } from "../engine/gallery";
import { buildProgressIndex } from "../engine/gaps";
import { parseReplay } from "../engine/load";

const GALLERY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/gallery",
);

/** Legacy `toT` per asset, seconds — measured at Slice 24. */
const LEGACY_TO_T: Record<string, number> = {
  "monza-2026-red-flag": 92.3,
  "monza-2026-restart": 166.1,
  "silverstone-2024-rain": 91.6,
  "silverstone-2024-finale": 89.6,
  "monza-2024-pit-cycle": 84.9,
};

const SCENARIOS = parseGalleryManifest(manifest).scenarios;

describe.each(SCENARIOS.map((s) => [s.id, s.file] as const))(
  "legacy reference lap: %s",
  (id, file) => {
    it("is the span gaps.ts's buildReference uses today", () => {
      const raw = JSON.parse(readFileSync(join(GALLERY_DIR, file), "utf8"));
      delete raw.track.referenceLap;
      const replay = parseReplay(raw, file);
      const { referenceLap } = replay.track;

      expect(replay.meta.loop).toBe("open");
      expect(referenceLap.car).toBe(0);
      expect(referenceLap.fromT).toBe(0);
      expect(referenceLap.toT).toBe(buildProgressIndex(replay).lapSeconds);
      expect(referenceLap.toT).toBe(LEGACY_TO_T[id]);
    });
  },
);
