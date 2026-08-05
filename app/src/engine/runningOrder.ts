/**
 * runningOrder.ts — the timing tower's row order, with hysteresis.
 *
 * Cars are listed by signed gap: furthest ahead at the top, furthest behind at the
 * bottom. Two properties make that the right key rather than `cars[]` order:
 *
 *  - It is the RUNNING ORDER. A tower exists so that "who is ahead" is preattentive —
 *    readable from row position without reading a single number. Source order encodes
 *    nothing, and at twenty cars that costs the reader twenty comparisons.
 *  - It is FOCUS-INDEPENDENT. Changing the focused car shifts every gap by the same
 *    constant, so the order does not move. Rows change places at overtakes and at
 *    nothing else.
 *
 * The hysteresis is what keeps that promise honest. Two cars running side by side
 * cross and re-cross by milliseconds many times a second, and a plain sort would
 * strobe their rows at the HUD's refresh rate. So a car only takes a place off the car
 * above it when it is more than `ORDER_HYSTERESIS_S` better — a dead band of twice
 * that around every crossing, which cannot oscillate. This is a comparison rule, not a
 * mechanism: no timers, no animation state, nothing retained but the previous order.
 *
 * NOTE what the order is made of: `cars[]` INDICES. Selection binds to those, never to
 * a row position, so a resort can never change which car a click or a keypress means.
 *
 * SLICE 9d CHANGED NOTHING HERE, AND THAT IS A RESULT RATHER THAN AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * 9d replaced the folded half-lap gap with a true cumulative one, and lapped cars became
 * reportable. Both were expected to land on the sort key. Neither did:
 *
 *  - **Lapped cars order themselves.** A car a lap down has a `seconds` of about a lap,
 *    which is simply a large gap; it sorts below the field by the existing comparison.
 *    `Gap.lapsDown` is a DISPLAY concern (`formatGap`) and never a sort key.
 *  - **The sort key stays `seconds`, and the alternative was a unit bug waiting to
 *    happen.** Sorting on the progress difference `ΔP` was considered and rejected:
 *    `ORDER_HYSTERESIS_S` is denominated in SECONDS, and against a progress-denominated
 *    key it would read either as ~0.9 mm of track (vacuous, hysteresis silently gone) or
 *    as a fraction of a lap (~4 s, enormous, the tower frozen). Both would have passed
 *    every test that does not probe the dead band — so `runningOrder.test.ts` now probes
 *    it, in both units.
 *  - It buys nothing anyway: `P_F` is monotone in time, so `P_F⁻¹` is monotone, so
 *    ordering by `ΔP` and ordering by `seconds` are **identical** — always, not
 *    approximately.
 *
 * What 9d DID fix here is the input. The hysteresis was being asked to damp a ±lap
 * discontinuity at the half-lap boundary and could not — a 0.05 s dead band against an
 * 85 s jump. That discontinuity is gone from `gaps.ts`, so the dead band is back to
 * doing the job it was sized for: genuine close-quarters swaps.
 */

/**
 * How much better a car's gap must be before it takes the place above it, in seconds.
 *
 * Small enough that a real overtake reorders the tower immediately, large enough to
 * absorb the millisecond-scale crossing and re-crossing of two cars running together.
 */
export const ORDER_HYSTERESIS_S = 0.05;

/**
 * Order car indices by signed gap, preferring the order they were already in.
 *
 * @param previous the last order this returned; `[]` on the first call, which yields a
 *                 plain sort because there is nothing to prefer yet.
 * @param gaps     gap in seconds per car index, `null` where there is no honest answer.
 *                 Those cars pin to the BOTTOM in `cars[]` order: an unknown gap has no
 *                 position in the running order, and inventing one would put a car in
 *                 the tower at a place the data does not support.
 */
export function orderByGap(
  previous: readonly number[],
  gaps: readonly (number | null)[],
  hysteresisS: number = ORDER_HYSTERESIS_S,
): number[] {
  const count = gaps.length;
  const seen = new Set<number>();
  const base: number[] = [];

  // Start from the previous order, dropping anything that is no longer a car (a
  // shorter replay was loaded) and de-duplicating defensively.
  for (const i of previous) {
    if (i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      base.push(i);
    }
  }
  // Anything new joins at the end, in source order, and sorts itself from there.
  for (let i = 0; i < count; i++) {
    if (!seen.has(i)) base.push(i);
  }

  const timed = base.filter((i) => gaps[i] !== null);
  const untimed = base.filter((i) => gaps[i] === null).sort((a, b) => a - b);

  // Insertion sort, because the list is nearly ordered every time and the comparison
  // is not a total order — it deliberately refuses to swap near-equal pairs, which is
  // exactly what a comparison sort may not be given. n <= 20, run at <= 30 Hz.
  for (let i = 1; i < timed.length; i++) {
    for (let j = i; j > 0; j--) {
      const gap = gaps[timed[j]] as number;
      const above = gaps[timed[j - 1]] as number;
      if (!(gap < above - hysteresisS)) break;
      [timed[j - 1], timed[j]] = [timed[j], timed[j - 1]];
    }
  }

  return [...timed, ...untimed];
}

/**
 * Are these the same order?
 *
 * The caller keeps the previous order as React state and feeds it back in, so it needs
 * a cheap way to tell "nothing moved" from "a car changed places" — writing the state
 * unconditionally would re-render the tower on every telemetry frame for no reason.
 */
export function sameOrder(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
