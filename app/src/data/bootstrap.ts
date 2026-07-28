/**
 * bootstrap.ts — turning a load failure into something a human can see.
 *
 * Slice 4a validated the fixture at module scope in `main.tsx`, outside any try/catch.
 * That was loud in the right way and useless in another: a schema mismatch threw
 * before `createRoot` ran, so the carefully-worded `ReplayValidationError` message —
 * one line per issue plus a `→ at cars[0].samples[3].speed` path — went to the console
 * and the visitor got a blank page.
 *
 * This is the seam that fixes it. It takes the JSON rather than a loader function so
 * that a test can feed it a deliberately-broken fixture and exercise the REAL
 * `parseReplay` path, and it returns the failure instead of throwing so the caller can
 * render it. The error deliberately does not go in the transport store: that store
 * holds discrete transport state and nothing else (CLAUDE.md architecture rule 1), and
 * a bootstrap failure is not transport state.
 */
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";
import { FIXTURE_SOURCE } from "./fixture";

/** Either a validated replay, or a message fit to put on screen. */
export type BootstrapResult =
  | { replay: Replay; error: null }
  | { replay: null; error: string };

/**
 * Load and validate the replay the app boots with.
 *
 * @param json   Already-parsed JSON. Defaults to the committed fixture, which is what
 *               makes the app run with zero network.
 * @param source Label quoted in the error message.
 */
export function bootstrapReplay(
  json: unknown = sampleLap,
  source: string = FIXTURE_SOURCE,
): BootstrapResult {
  try {
    return { replay: parseReplay(json, source), error: null };
  } catch (err) {
    // `ReplayValidationError.message` is written for a human and is passed through
    // verbatim. The fallback is for a throw that is not an Error at all — rendering
    // "undefined" would be worse than useless.
    return {
      replay: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
