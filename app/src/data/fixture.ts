/**
 * fixture.ts — the replay the app boots with.
 *
 * The committed engine fixture is imported statically rather than fetched, which is
 * what makes the app run with zero network (CLAUDE.md "Testing", PRD acceptance).
 * Slice 6 adds an optional real lap from `public/data/`; the fixture stays the
 * default so the app, its tests and CI never depend on a file that is gitignored.
 *
 * It goes through `parseReplay` like any other replay — the schema is the single
 * contract and nothing in the app consumes raw JSON, not even data it shipped with
 * (architecture rule 7). A hand-edited fixture that drifts from the schema fails
 * here, loudly, instead of rendering something subtly wrong.
 */
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";

export const FIXTURE_SOURCE = "sample-lap.json";

/** @throws {ReplayValidationError} if the committed fixture does not conform. */
export function loadFixtureReplay(): Replay {
  return parseReplay(sampleLap, FIXTURE_SOURCE);
}
