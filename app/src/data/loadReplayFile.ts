/**
 * loadReplayFile.ts — a replay the human picked off their own disk.
 *
 * This is how real data reaches the app. The pipeline writes to
 * `app/public/data/`, which is gitignored and therefore never in a deployed build,
 * so a `fetch("/data/…")` path would work on the author's laptop and 404 everywhere
 * else. Reading the file the human chose works identically in dev and in production,
 * needs no network at all, and keeps the committed fixture as the thing the app
 * boots with (CLAUDE.md: app, tests and CI run fully offline).
 *
 * Validation is not re-implemented here: it delegates to `bootstrapReplay`, so a
 * picked file goes through the exact same `parseReplay` and the exact same error
 * shaping as the fixture does. One door for replay data, as architecture rule 7 asks.
 */
import { type BootstrapResult, bootstrapReplay } from "./bootstrap";

/**
 * Read, parse and validate a replay file.
 *
 * Returns the failure rather than throwing it — the caller renders the message and
 * keeps whatever replay was already loaded.
 */
export async function loadReplayFile(file: File): Promise<BootstrapResult> {
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    return {
      replay: null,
      error: `Could not read ${file.name}: ${messageOf(err)}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // A truncated or half-written file is a SYNTAX error, and saying so is more use
    // than the several hundred schema violations a malformed file would otherwise
    // produce. The pipeline's CLI validator draws the same distinction.
    return {
      replay: null,
      error: `${file.name} is not valid JSON.\n${messageOf(err)}`,
    };
  }

  return bootstrapReplay(json, file.name);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
