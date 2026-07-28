/**
 * validate-replay.ts — the schema, as a command line.
 *
 * The Python pipeline cannot check its own output: the contract is a Zod schema in
 * TypeScript (`src/engine/schema.ts`), and a second copy of it in Python would be a
 * second contract that drifts. So the pipeline shells out to this, which runs the
 * app's REAL `parseReplay` — the same function `main.tsx` boots through — over the
 * file it just wrote. There is exactly one definition of a valid replay and the
 * pipeline is checked against it.
 *
 * Run through `vite-node`, which is what lets a CLI import the app's TypeScript
 * directly:
 *
 *     npm run validate:replay -- path/to/replay.json [more.json ...]
 *
 * Exits 0 when every file conforms, 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseReplay, ReplayValidationError } from "../src/engine/load";

/** One line summarising what the app would render, for a human sanity check. */
function summarise(
  path: string,
  replay: ReturnType<typeof parseReplay>,
): string {
  const { meta, track, cars } = replay;
  // Derived across every car, not from `cars[0]`: the schema enforces DRS
  // all-or-nothing per CAR, so a v2 multi-car file could legitimately disagree
  // between drivers, and a summary that only looked at the first would hide it
  // (CLAUDE.md rule 2 — nothing branches on, or assumes, the count).
  const withDrs = cars.filter((c) => c.samples[0].drs !== undefined).length;
  const drs =
    withDrs === 0 ? "omitted" : withDrs === cars.length ? "present" : "MIXED";
  const samples = Math.max(...cars.map((c) => c.samples.length));
  return [
    `OK  ${path}`,
    `    ${meta.event} · ${meta.session} · ${meta.track} (${meta.year})`,
    `    ${cars.length} car(s) · ${samples} samples · ${meta.duration}s @ ${meta.sampleRateHz} Hz`,
    `    drs ${drs} · ${track.corners.length} corners · rotation ${meta.rotation}°`,
  ].join("\n");
}

function validateFile(path: string): boolean {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    console.error(`FAIL ${path}\n    cannot read the file`);
    return false;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // A truncated or half-written file is a syntax error, not a schema error, and
    // deserves to say so rather than producing 600 confusing schema violations.
    console.error(
      `FAIL ${path}\n    not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  try {
    console.log(summarise(path, parseReplay(json, path)));
    return true;
  } catch (err) {
    // `ReplayValidationError.message` is already written for a human — one line per
    // issue plus a `→ at cars[0].samples[3].speed` path. Printed verbatim, exactly
    // as the app's error state renders it.
    if (err instanceof ReplayValidationError) {
      console.error(`FAIL ${err.message}`);
      return false;
    }
    throw err;
  }
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: npm run validate:replay -- <replay.json> [...]");
  process.exit(1);
}

const failures = paths.filter((path) => !validateFile(path)).length;
if (failures > 0) {
  console.error(
    `\n${failures} of ${paths.length} file(s) do NOT conform to the replay schema.`,
  );
  process.exit(1);
}
