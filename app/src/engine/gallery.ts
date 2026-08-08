/**
 * gallery.ts — the featured-replay catalogue, as a contract.
 *
 * The gallery is data, not code: three curated scenarios described by a committed
 * manifest, so adding a fourth is one array entry and one asset rather than a
 * component change. This module holds the shape of that manifest and the one piece
 * of logic that turns an entry into something the transport store can be told.
 *
 * It is in `src/engine/` because it is pure — no React, no DOM, no fetch (CLAUDE.md
 * rule 4). The fetching lives in `src/data/loadGalleryReplay.ts`, the rendering in
 * `src/components/FeaturedPanel.tsx`.
 *
 * WHY THE MANIFEST IS BUNDLED AND THE PAYLOADS ARE FETCHED
 * -------------------------------------------------------
 * `src/gallery/manifest.json` is imported, so it is part of the JS bundle: about a
 * kilobyte, validated by the schema below, and therefore incapable of failing at
 * runtime. The replay payloads it names live in `public/gallery/` and are fetched on
 * click, because they are megabytes.
 *
 * That split is the reason a network failure can only ever cost you ONE scenario.
 * The panel itself always renders, because the catalogue never travelled.
 */
import { z } from "zod";
import type { Replay } from "./schema";

/** Bump only for a breaking manifest change. Independent of the replay schema's. */
export const GALLERY_SCHEMA_VERSION = 1;

/**
 * Where the payloads sit, relative to the site root.
 *
 * A path segment, not a full URL, and that is a constraint rather than a shortcut:
 * the offline law's single exception is "the repo's own committed assets from its
 * own origin", and a manifest that could name `https://…` would be a hole in it.
 * `file` is validated below as a bare filename for the same reason.
 */
export const GALLERY_DIR = "gallery";

const SuggestedSchema = z.object({
  /**
   * A driver CODE ("HAM"), never an index.
   *
   * An index would silently mean a different car if the file were regenerated with
   * a different driver order — and regenerating is a normal thing to do. The code
   * is resolved against the loaded replay by `resolveFocusIndex` below.
   */
  driver: z.string().min(1),
  /** Seconds into the window: where the interesting moment actually starts. */
  clock: z.number().nonnegative(),
  /** Playback rate to land on. 1 is real time. */
  speedMult: z.number().positive(),
});

/** Provenance, so a curated excerpt can always be traced back to its session. */
const ProvenanceSchema = z.object({
  session: z.string().min(1),
  laps: z.string().min(1),
  drivers: z.array(z.string().min(1)).min(1),
  /** ISO date the asset was generated: `YYYY-MM-DD`. */
  generated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    error: "generated must be an ISO date, e.g. 2026-08-08",
  }),
});

const ScenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** One line. It is the pitch, and it is what the visitor reads before clicking. */
  hook: z.string().min(1),
  /**
   * A BARE FILENAME under `public/gallery/`, enforced rather than trusted.
   *
   * No scheme, no host, no `..`, no leading slash. The manifest is committed and so
   * is every asset it names, so nothing here needs the expressiveness of a URL —
   * and refusing it is what keeps the offline exception the narrow thing it claims
   * to be. A manifest entry can never point the app off its own origin.
   */
  file: z.string().regex(/^[a-z0-9][a-z0-9-]*\.json$/, {
    error:
      "file must be a bare lowercase filename ending in .json — gallery assets are same-origin only",
  }),
  suggested: SuggestedSchema,
  provenance: ProvenanceSchema,
});

export const GalleryManifestSchema = z.object({
  schemaVersion: z.literal(GALLERY_SCHEMA_VERSION, {
    error: `gallery manifest schemaVersion must be ${GALLERY_SCHEMA_VERSION}`,
  }),
  scenarios: z.array(ScenarioSchema).min(1, {
    error: "the gallery needs at least one scenario",
  }),
});

export type GalleryScenario = z.infer<typeof ScenarioSchema>;
export type GalleryManifest = z.infer<typeof GalleryManifestSchema>;

/** Thrown when the committed manifest does not match its own schema. */
export class GalleryManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GalleryManifestError";
  }
}

/**
 * Validate the manifest, failing loudly.
 *
 * Loud is right here in a way it is not for a payload: the manifest is COMMITTED and
 * bundled, so a malformed one is a build-time mistake that a test catches, never
 * something a visitor can hit. There is no graceful degradation to design, because
 * there is no runtime failure mode to degrade from.
 */
export function parseGalleryManifest(json: unknown): GalleryManifest {
  const result = GalleryManifestSchema.safeParse(json);
  if (result.success) return result.data;
  throw new GalleryManifestError(
    `Invalid gallery manifest.\n${z.prettifyError(result.error)}`,
  );
}

/** The same-origin path a scenario's payload is fetched from. */
export function scenarioUrl(scenario: GalleryScenario, base = "/"): string {
  return `${base}${base.endsWith("/") ? "" : "/"}${GALLERY_DIR}/${scenario.file}`;
}

/**
 * Which car a scenario wants focused, as an index into `replay.cars`.
 *
 * Falls back to car 0 when the code is absent, and that is a deliberate degradation
 * rather than an oversight: the manifest is committed but the payload is
 * regenerable, so the two can legitimately drift when a session is rebuilt with a
 * different driver list. A missing driver should cost the visitor the suggested
 * camera, not the whole scenario. Matching is case-insensitive because driver codes
 * are conventionally upper-case but nothing enforces it.
 */
export function resolveFocusIndex(replay: Replay, driver: string): number {
  const wanted = driver.trim().toUpperCase();
  const index = replay.cars.findIndex(
    (car) => car.driver.trim().toUpperCase() === wanted,
  );
  return index === -1 ? 0 : index;
}

/**
 * Clamp a suggested start clock into the replay it is being applied to.
 *
 * Same reasoning as `resolveFocusIndex`: a rebuilt window can be shorter than the
 * one the manifest was written against, and seeking past the end would land the
 * visitor on a frozen final frame — the worst possible first impression, and a
 * silent one. Out-of-range lands at the start instead, which is at least honest.
 */
export function resolveStartClock(replay: Replay, clock: number): number {
  if (!Number.isFinite(clock) || clock < 0) return 0;
  return clock < replay.meta.duration ? clock : 0;
}
