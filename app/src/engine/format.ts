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

/** What a readout shows where the data has no answer. An em dash, never a zero. */
export const NO_VALUE = "—";

/**
 * A gap in seconds, signed, as a timing tower writes it.
 *
 * `+` is behind and `-` is ahead, which is the broadcast convention and the one the
 * DRS one-second rule is quoted in. Three decimals because that is the resolution the
 * projection actually has (`gaps.ts` resolves `t*` within a grid step, not to it) and
 * because a tenth would hide the 0.14 s a following car takes under braking.
 *
 * `null` is a real state — the focused car never passed that point inside the window,
 * or the car is off its path entirely — and it renders as `NO_VALUE` rather than as a
 * zero that would read as "alongside".
 */
export function formatGapSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return NO_VALUE;
  return `${seconds >= 0 ? "+" : "-"}${Math.abs(seconds).toFixed(3)}`;
}

/**
 * The same gap as ground, in whole metres.
 *
 * UNSIGNED: it always carries the same sign as the seconds beside it, and printing it
 * twice adds a character to every row of a twenty-car tower to say nothing new.
 */
export function formatGapMetres(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return NO_VALUE;
  return `${Math.round(Math.abs(metres))} m`;
}
