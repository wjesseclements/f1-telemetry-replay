/**
 * scenarios.ts — the parsed manifest, as a module-level constant.
 *
 * Validated once at module load, not per render. The manifest is bundled rather
 * than fetched, so this cannot fail at runtime in a way a visitor could see — a
 * malformed entry fails `gallery.test.ts` first. Extracted from `FeaturedPanel`
 * when the event card became a second consumer (Slice 17): the panel lists the
 * catalogue, the card follows a `next` chain through it, and both must be reading
 * the same parse.
 */
import { parseGalleryManifest, type GalleryScenario } from "../engine/gallery";
import manifestJson from "./manifest.json";

export const SCENARIOS: readonly GalleryScenario[] =
  parseGalleryManifest(manifestJson).scenarios;

/**
 * The scenario with this id, or `null`.
 *
 * `null` rather than a throw for the card's sake: the manifest schema already
 * rejects a dangling `next` at build time, so a miss here is unreachable through
 * committed data — but the card degrades to "no continue button" rather than
 * crashing an overlay over a working replay.
 */
export function findScenario(id: string): GalleryScenario | null {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
