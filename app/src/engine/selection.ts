/**
 * selection.ts — moving the focus from one car to the next.
 *
 * Cycling runs over `cars[]` order, NOT the tower's sorted order, and that is the
 * whole content of this module. The tower resorts whenever cars change places, so if
 * "next" meant "the row below", a resort landing between two keypresses would silently
 * change which car the second press selects. Source order never moves.
 *
 * The modulo is also what keeps CLAUDE.md rule 2: with one car it returns 0 for any
 * delta, so there is no count to branch on anywhere else.
 */

/**
 * The car `delta` places along from `current`, wrapping at both ends.
 *
 * A `current` outside the array (a replay was swapped for a shorter one) resolves to
 * the first car rather than throwing: focus is presentation state, and the honest
 * recovery is to show a car.
 */
export function cycleFocus(
  count: number,
  current: number,
  delta: number,
): number {
  if (count <= 0) return 0;
  const from =
    Number.isInteger(current) && current >= 0 && current < count ? current : 0;
  return (((from + delta) % count) + count) % count;
}
