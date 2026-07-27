/**
 * drs.ts — the one place the undocumented DRS encoding lives.
 *
 * FastF1 documents the channel only as a "DRS indicator"; the integer meanings are
 * community-derived, not official (PRD source [2]). Everything that needs to know
 * whether the wing is open goes through `isDrsOpen` so that guess is isolated to a
 * single function and can be corrected in one edit.
 *
 * DRS is removed for 2026 and F1 publishes no active-aero or ERS replacement, so the
 * channel is simply ABSENT in 2026+ replays rather than special-cased by year: the
 * app asks `carHasDrs` and renders the indicator only when the data carries one.
 * (CLAUDE.md rule 8; PRD source [5].)
 */
import type { Car, Sample } from "./schema";

/** Raw codes understood to mean "DRS open"; every other code means closed. */
export const DRS_OPEN_CODES: readonly number[] = [10, 12, 14];

/**
 * Decode a raw FastF1 DRS code.
 *
 * @param code Raw code from `sample.drs`, or `undefined` when the replay carries
 *             no DRS channel at all — which reads as "not open".
 */
export function isDrsOpen(code: number | undefined): boolean {
  return code !== undefined && DRS_OPEN_CODES.includes(code);
}

/**
 * Does this car carry a DRS channel? The schema guarantees the channel is
 * all-or-nothing across a car's samples, so the first sample settles it.
 */
export function carHasDrs(car: Car): boolean {
  const first: Sample | undefined = car.samples[0];
  return first?.drs !== undefined;
}
