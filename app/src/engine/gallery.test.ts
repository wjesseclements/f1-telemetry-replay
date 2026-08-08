/**
 * Gallery manifest + resolver tests.
 *
 * Two jobs. The first is to hold the COMMITTED manifest to its own schema, so a
 * malformed scenario entry fails here rather than in front of a visitor — that is
 * the whole argument for bundling the catalogue instead of fetching it.
 *
 * The second is the degradation behaviour. The manifest is committed and the
 * payloads are regenerable, so the two can legitimately drift; the resolvers have to
 * cope with a drifted pair without throwing, and these tests say what "cope" means.
 *
 * No network anywhere: the committed manifest and the committed fixture only.
 */
import { describe, it, expect } from "vitest";
import manifest from "../gallery/manifest.json";
import sampleLap from "./__fixtures__/sample-lap.json";
import {
  GALLERY_SCHEMA_VERSION,
  GalleryManifestError,
  parseGalleryManifest,
  resolveFocusIndex,
  resolveStartClock,
  scenarioUrl,
} from "./gallery";
import { parseReplay } from "./load";
import type { Replay } from "./schema";

const replay: Replay = parseReplay(sampleLap, "sample-lap.json");

/** A deep copy typed loosely, so a test can break it on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutations are deliberately invalid; that is the point
type Mutable = any;
const clone = (): Mutable => structuredClone(manifest) as Mutable;

describe("the committed manifest", () => {
  it("conforms to its own schema", () => {
    const parsed = parseGalleryManifest(manifest);
    expect(parsed.schemaVersion).toBe(GALLERY_SCHEMA_VERSION);
    expect(parsed.scenarios.length).toBeGreaterThanOrEqual(1);
  });

  it("gives every scenario a unique id", () => {
    const ids = parseGalleryManifest(manifest).scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names a distinct asset file per scenario", () => {
    const files = parseGalleryManifest(manifest).scenarios.map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("parseGalleryManifest — rejection", () => {
  it("rejects a wrong schemaVersion", () => {
    const bad = clone();
    bad.schemaVersion = 2;
    expect(() => parseGalleryManifest(bad)).toThrow(GalleryManifestError);
  });

  it("rejects an empty scenario list", () => {
    const bad = clone();
    bad.scenarios = [];
    expect(() => parseGalleryManifest(bad)).toThrow(/at least one scenario/);
  });

  it("rejects a missing hook", () => {
    const bad = clone();
    delete bad.scenarios[0].hook;
    expect(() => parseGalleryManifest(bad)).toThrow(GalleryManifestError);
  });

  it("rejects a non-ISO generated date", () => {
    const bad = clone();
    bad.scenarios[0].provenance.generated = "August 2026";
    expect(() => parseGalleryManifest(bad)).toThrow(/ISO date/);
  });

  it("rejects a zero or negative speed multiplier", () => {
    const bad = clone();
    bad.scenarios[0].suggested.speedMult = 0;
    expect(() => parseGalleryManifest(bad)).toThrow(GalleryManifestError);
  });

  // The offline law, enforced in the contract rather than trusted to reviewers: a
  // manifest entry must not be able to point the app off its own origin.
  it.each([
    ["an absolute URL", "https://example.com/evil.json"],
    ["a protocol-relative URL", "//example.com/evil.json"],
    ["a leading slash", "/gallery/x.json"],
    ["a parent traversal", "../secrets.json"],
    ["a nested path", "sub/dir/x.json"],
    ["a non-json extension", "payload.js"],
  ])("rejects %s as a scenario file", (_label, file) => {
    const bad = clone();
    bad.scenarios[0].file = file;
    expect(() => parseGalleryManifest(bad)).toThrow(/same-origin/);
  });
});

describe("scenarioUrl", () => {
  const scenario = parseGalleryManifest(manifest).scenarios[0];

  it("resolves under the site root by default", () => {
    expect(scenarioUrl(scenario)).toBe(`/gallery/${scenario.file}`);
  });

  it("respects a non-root base path", () => {
    expect(scenarioUrl(scenario, "/preview/")).toBe(
      `/preview/gallery/${scenario.file}`,
    );
  });

  it("tolerates a base with no trailing slash", () => {
    expect(scenarioUrl(scenario, "/preview")).toBe(
      `/preview/gallery/${scenario.file}`,
    );
  });
});

describe("resolveFocusIndex — drift degrades, never throws", () => {
  it("finds the requested driver", () => {
    expect(resolveFocusIndex(replay, replay.cars[0].driver)).toBe(0);
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    const code = replay.cars[0].driver;
    expect(resolveFocusIndex(replay, `  ${code.toLowerCase()} `)).toBe(0);
  });

  it("falls back to car 0 for a driver who is not in the file", () => {
    // The realistic drift: the asset was regenerated with a different driver list.
    // The visitor loses the suggested camera, not the scenario.
    expect(resolveFocusIndex(replay, "ZZZ")).toBe(0);
  });

  it("returns an index that is always valid for the replay", () => {
    for (const code of ["ZZZ", "", "  ", replay.cars[0].driver]) {
      const index = resolveFocusIndex(replay, code);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(replay.cars.length);
    }
  });
});

describe("resolveStartClock — never lands on a frozen final frame", () => {
  it("passes through a clock inside the replay", () => {
    expect(resolveStartClock(replay, 1.5)).toBe(1.5);
  });

  it("returns 0 for a clock at or past the end", () => {
    // A rebuilt window can be shorter than the one the manifest was written
    // against. Seeking past the end would freeze on the last sample, silently.
    expect(resolveStartClock(replay, replay.meta.duration)).toBe(0);
    expect(resolveStartClock(replay, replay.meta.duration + 10)).toBe(0);
  });

  it("returns 0 for a negative or non-finite clock", () => {
    expect(resolveStartClock(replay, -1)).toBe(0);
    expect(resolveStartClock(replay, Number.NaN)).toBe(0);
    expect(resolveStartClock(replay, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
