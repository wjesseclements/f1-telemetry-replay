/**
 * load.ts — the only door replay JSON comes through.
 *
 * Validation happens at load, not at first use, and failure is loud: the thrown
 * error names every offending path so a pipeline/frontend mismatch is obvious
 * without a debugger. (PRD acceptance: "Loader rejects non-conforming JSON with a
 * clear, actionable error.")
 */
import { z } from "zod";
import { ReplaySchema, type Replay } from "./schema";

/**
 * Thrown when replay JSON does not match the schema. Carries the raw Zod issues
 * so a UI (Slice 4b's error state) can render them however it likes, while
 * `message` stays human-readable on its own.
 */
export class ReplayValidationError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  readonly source: string | undefined;

  constructor(message: string, issues: readonly z.core.$ZodIssue[], source?: string) {
    super(message);
    this.name = "ReplayValidationError";
    this.issues = issues;
    this.source = source;
  }
}

/**
 * Validate parsed JSON against the replay schema.
 *
 * @param json   Already-parsed JSON (an imported fixture, or `await res.json()`).
 * @param source Optional label — a filename or URL — quoted in the error message.
 * @throws {ReplayValidationError} if the data does not conform.
 */
export function parseReplay(json: unknown, source?: string): Replay {
  const result = ReplaySchema.safeParse(json);
  if (result.success) return result.data;

  const { issues } = result.error;
  const where = source === undefined ? "" : ` in ${source}`;
  const count = `${issues.length} schema ${issues.length === 1 ? "violation" : "violations"}`;
  // z.prettifyError is Zod 4's unified error formatter: one line per issue plus an
  // "→ at cars[0].samples[3].speed" path line. It replaces v3's .format()/.flatten().
  const message = `Invalid replay data${where}: ${count}.\n${z.prettifyError(result.error)}`;

  throw new ReplayValidationError(message, issues, source);
}
