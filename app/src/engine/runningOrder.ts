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
