/**
 * index.ts — the corner-lore catalogue, parsed once at module load (Slice 18).
 *
 * Each circuit's lore is a committed JSON file in this directory, named after its
 * `id`. They are imported one by one, never by glob: a lazy glob would add a chunk
 * fetch that could fail, and the catalogue, like the gallery manifest, is bundled so
 * it cannot fail at runtime. The prose stays in the JSON files: Tailwind scans every
 * shipped `.ts` file for class names, and copy is not code.
 *
 * `lore.test.ts` beside this file fails if a JSON file here is not imported below.
 */
import { parseLoreCatalogue, type CircuitLore } from "../engine/lore";
import monza from "./monza.json";
import silverstone from "./silverstone.json";

export const LORE: readonly CircuitLore[] = parseLoreCatalogue([
  monza,
  silverstone,
]);
