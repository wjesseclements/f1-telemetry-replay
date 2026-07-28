/**
 * pipelineContract.test.ts — the pipeline's acceptance test, run by the app.
 *
 * `pipeline/tests/golden/*.json` is real output from `build_replay_dict`, committed
 * so that the contract between the two languages is checked by CI rather than by a
 * human noticing a blank canvas. This runs the app's actual `parseReplay` over it:
 * if a pipeline change would emit JSON the app rejects, `npm run test` goes red even
 * though nobody ran FastF1 and nothing touched the network.
 *
 * The other half of the loop lives in `pipeline/tests/test_golden.py`, which fails if
 * the goldens no longer match what the pipeline produces. Together: pytest keeps the
 * goldens honest about the pipeline, and this keeps the pipeline honest about the
 * schema. Either one alone can be fooled by a stale file.
 *
 * The goldens are read from disk rather than imported so that nothing in `src/`
 * depends on a path outside the Vite root — this is a test-time `readFileSync`, and
 * the app bundle is unaffected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReplay } from "../engine/load";
import { SCHEMA_VERSION, SPEED_UNIT } from "../engine/schema";

const GOLDEN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../pipeline/tests/golden",
);

function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, name), "utf8"));
}

const WITH_DRS = "lap-drs.golden.json";
const WITHOUT_DRS = "lap-nodrs.golden.json";

describe("pipeline output against the schema", () => {
  it.each([WITH_DRS, WITHOUT_DRS])(
    "%s validates through parseReplay",
    (name) => {
      // Not a smoke test: `parseReplay` is the same function `main.tsx` boots with,
      // including the uniform-grid and span-agreement refinements, so this asserts the
      // pipeline satisfies every load-time guard the engine relies on.
      expect(() => parseReplay(readGolden(name), name)).not.toThrow();
    },
  );

  it("emits the meta contract the engine is calibrated for", () => {
    const replay = parseReplay(readGolden(WITH_DRS), WITH_DRS);
    expect(replay.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(replay.meta.units.speed).toBe(SPEED_UNIT);
  });

  it("lands every sample exactly on the uniform grid", () => {
    // The schema allows 2 ms of slack; the pipeline should need none of it, because
    // its grid step is exactly 1/sampleRateHz. Asserting exactness here means a
    // regression to a `linspace`-style grid fails on the first sample rather than
    // creeping up on the tolerance.
    const replay = parseReplay(readGolden(WITH_DRS), WITH_DRS);
    const { sampleRateHz } = replay.meta;
    replay.cars[0].samples.forEach((sample, k) => {
      expect(sample.t).toBe(Number((k / sampleRateHz).toFixed(3)));
    });
  });

  it("agrees with meta.duration on the number of samples", () => {
    const replay = parseReplay(readGolden(WITH_DRS), WITH_DRS);
    const { duration, sampleRateHz } = replay.meta;
    expect(replay.cars[0].samples.length).toBe(
      Math.round(duration * sampleRateHz),
    );
  });

  it("carries the raw DRS code on every sample when the season has DRS", () => {
    const replay = parseReplay(readGolden(WITH_DRS), WITH_DRS);
    const samples = replay.cars[0].samples;
    expect(samples.every((s) => s.drs !== undefined)).toBe(true);
    // Raw FastF1 codes, undecoded — `drs.ts` owns the 10/12/14 mapping, and a
    // pipeline that started emitting 0/1 booleans would pass the schema silently.
    expect(samples.some((s) => s.drs === 12)).toBe(true);
  });

  it("omits DRS entirely for a season without it", () => {
    // 2026+: DRS is removed and F1 publishes no replacement channel. The HUD renders
    // its indicator only when the data carries one, so "omitted" has to survive the
    // whole pipeline rather than becoming a column of zeros (CLAUDE.md rule 8).
    const replay = parseReplay(readGolden(WITHOUT_DRS), WITHOUT_DRS);
    expect(replay.cars[0].samples.every((s) => s.drs === undefined)).toBe(true);
  });

  it("keeps throttle inside the range the schema accepts", () => {
    // The synthetic source frames overshoot 100 deliberately, mirroring real FastF1.
    // If the pipeline's clamp were removed, `parseReplay` above would already throw;
    // this states the intent so the reason survives the next refactor.
    const replay = parseReplay(readGolden(WITH_DRS), WITH_DRS);
    replay.cars[0].samples.forEach((sample) => {
      expect(sample.throttle).toBeGreaterThanOrEqual(0);
      expect(sample.throttle).toBeLessThanOrEqual(100);
    });
  });

  it("computes a real start/finish angle rather than a hard-coded zero", () => {
    const replay = parseReplay(readGolden(WITH_DRS), WITH_DRS);
    const { startFinish } = replay.track;
    const [first, second] = replay.cars[0].samples;
    expect(startFinish.x).toBe(first.x);
    expect(startFinish.y).toBe(first.y);
    expect(startFinish.angle).toBeCloseTo(
      Math.atan2(second.y - first.y, second.x - first.x),
      2,
    );
  });
});
