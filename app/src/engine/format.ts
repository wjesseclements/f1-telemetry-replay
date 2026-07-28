/**
 * format.ts — numbers as the HUD says them.
 *
 * Formatting lives in the engine because it is pure and because the HUD is not the only
 * caller: the scrubber's `aria-valuetext` announces the same lap time, and two
 * implementations of "how a lap time is written" would drift the moment one is tuned.
 *
 * Rounding is a DISPLAY concern and belongs here, not in `interpolate.ts` — the engine
 * samples speed unrounded on purpose (see `CarSnapshot.speed`) so that the trail's
 * colour and the HUD's text can disagree about precision without either being wrong.
 */

/**
 * A lap clock as `m:ss.mmm`.
 *
 * Milliseconds are shown because a scrub lands to a tenth of a second and a HUD that
 * only showed seconds would look frozen while the thumb moved. Minutes are unpadded
 * (`1:02.500`), seconds always two digits, so the string is monospace-stable within a
 * minute.
 *
 * Negative and non-finite inputs clamp to zero rather than rendering `NaN:aN.aNN` — the
 * transport can never produce them, but a HUD is the wrong place to discover that.
 */
export function formatLapTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.floor(safe * 1000);
  const minutes = Math.floor(totalMs / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Speed as the HUD shows it: whole km/h, never negative, never `NaN`. */
export function formatSpeed(kmh: number): number {
  return Number.isFinite(kmh) ? Math.max(0, Math.round(kmh)) : 0;
}

/**
 * Gear as the HUD shows it: `N` for neutral, otherwise the number.
 *
 * The schema allows 0–8 and 0 means neutral (`schema.ts:68`), so this is the one place
 * that spelling is decided.
 */
export function formatGear(gear: number): string {
  return gear === 0 ? "N" : String(gear);
}

/** A 0–100 channel as a 0–1 fraction, clamped — for bar widths. */
export function pedalFraction(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(1, Math.max(0, percent / 100));
}
