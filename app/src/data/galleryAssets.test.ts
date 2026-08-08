/**
 * galleryAssets.test.ts — the manifest kept honest about the files it names.
 *
 * `engine/gallery.ts` degrades gracefully when the manifest and a payload disagree:
 * an absent driver falls back to car 0, an out-of-range clock falls back to the
 * start. That is the right RUNTIME behaviour — assets are regenerable and drift is
 * legitimate — but it is a safety net, not a plan. Silently losing the suggested
 * camera on the deployed site is exactly the class of quiet wrongness this repo
 * keeps removing.
 *
 * So the drift is caught here instead, at build time, on the committed pair. This is
 * the gallery's version of `pipelineContract.test.ts`: that one keeps the pipeline
 * honest about the schema, this one keeps the catalogue honest about the payloads.
 *
 * Read from disk with `readFileSync` rather than imported, for the same reason the
 * goldens are: nothing in `src/` should depend on these multi-megabyte files, and
 * the app bundle must not carry them. This is a test-time read, not a fetch — the
 * offline trap in `src/test/setup.ts` is untouched and still armed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../gallery/manifest.json";
import {
  parseGalleryManifest,
  resolveFocusIndex,
  resolveStartClock,
} from "../engine/gallery";
import { parseReplay } from "../engine/load";

const GALLERY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/gallery",
);

const SCENARIOS = parseGalleryManifest(manifest).scenarios;

const readAsset = (file: string) =>
  JSON.parse(readFileSync(join(GALLERY_DIR, file), "utf8"));

describe.each(SCENARIOS.map((s) => [s.id, s] as const))(
  "gallery asset: %s",
  (_id, scenario) => {
    it("exists and validates through the app's real parseReplay", () => {
      // The same function `main.tsx` boots with, refinements included. A scenario
      // that would render a blank canvas fails here instead.
      const replay = parseReplay(readAsset(scenario.file), scenario.file);
      expect(replay.cars.length).toBeGreaterThanOrEqual(1);
    });

    it("carries every driver the manifest advertises", () => {
      const replay = parseReplay(readAsset(scenario.file), scenario.file);
      const present = replay.cars.map((c) => c.driver.toUpperCase());
      // Provenance is a claim about the file, so it is checked against the file.
      expect(present).toEqual(
        scenario.provenance.drivers.map((d) => d.toUpperCase()),
      );
    });

    it("suggests a focus driver that is actually in the file", () => {
      const replay = parseReplay(readAsset(scenario.file), scenario.file);
      // `resolveFocusIndex` would quietly return 0 for a missing code. Here the
      // fallback must not be what is exercised — assert the driver was FOUND.
      const index = resolveFocusIndex(replay, scenario.suggested.driver);
      expect(replay.cars[index].driver.toUpperCase()).toBe(
        scenario.suggested.driver.toUpperCase(),
      );
    });

    it("suggests a start clock inside the window", () => {
      const replay = parseReplay(readAsset(scenario.file), scenario.file);
      // Same shape: `resolveStartClock` clamps to 0, so assert it did not have to.
      expect(resolveStartClock(replay, scenario.suggested.clock)).toBe(
        scenario.suggested.clock,
      );
      expect(scenario.suggested.clock).toBeLessThan(replay.meta.duration);
    });
  },
);

describe("the gallery as a whole", () => {
  it("stays inside its committed size budget", () => {
    // 6 MB is the budget agreed for Slice 13; 15 MB is the escalation line at which
    // the answer stops being "commit it" and becomes "propose an alternative".
    // Measured on the real three: 4.09 MB. This fails before a fourth scenario or a
    // widened window quietly turns the repo into a data host.
    const total = SCENARIOS.reduce(
      (bytes, s) => bytes + readFileSync(join(GALLERY_DIR, s.file)).byteLength,
      0,
    );
    expect(total / 1e6).toBeLessThan(6);
  });

  it("ships the assets minified, as deployed files rather than reviewable ones", () => {
    // `build_replay.py --compact`. A pretty-printed asset is 2.3x larger for no
    // benefit — nobody reads a replay payload as a diff.
    for (const scenario of SCENARIOS) {
      const text = readFileSync(join(GALLERY_DIR, scenario.file), "utf8");
      expect(text.trimEnd().split("\n")).toHaveLength(1);
    }
  });
});
