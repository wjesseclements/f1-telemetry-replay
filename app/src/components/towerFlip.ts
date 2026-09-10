/**
 * towerFlip.ts — the tower's reshuffle animation (Slice 21), as one FLIP pass.
 *
 * When the running order changes, React reorders the row elements in one commit and
 * every displaced row teleports. FLIP puts the motion back: measure where each row
 * WAS (First), let the commit put it where it IS (Last), start it at the old place
 * with a transform (Invert) and animate the transform away (Play). The eye follows
 * the row through the overtake instead of re-finding it.
 *
 * WHY THE WEB ANIMATIONS API AND NOT A CSS TRANSITION
 * ---------------------------------------------------
 * Both animate `transform` on the compositor — no layout, no paint, no per-frame
 * JS — so rule 1 is equally safe either way. The difference is what happens when a
 * resort lands MID-ANIMATION: React moves a row with `insertBefore`, which removes
 * and reinserts the node, and a CSS transition is cancelled by that removal — the
 * row would snap to its inline `transform` value and the promised slide would
 * teleport exactly when reshuffles are fastest (the restart launch). A WAAPI
 * animation belongs to the element and keeps its timeline across the move, so this
 * pass can read the row's CURRENT VISUAL position, cancel the old animation and
 * start the new one from where the eye actually left off. That retarget is also the
 * answer to "what happens when a resort lands mid-animation": the row curves
 * smoothly through P5 → P2 → P7 rather than restarting from a stale place.
 *
 * WHY THE CALLER MEASURES EVERY COMMIT, NOT JUST REORDERS
 * -------------------------------------------------------
 * First positions must predate the commit that moved the rows, so they are cached on
 * the PREVIOUS commit — and because rows also move for reasons that must NOT animate
 * (the focused readout collapsing on one row and opening on another, a scroll, a
 * viewport resize), the cache is refreshed on every ≤30 Hz commit rather than
 * derived. `getBoundingClientRect` deliberately: it includes any in-flight
 * transform, so the cache always holds where the row is SEEN, which is what a
 * retarget needs. The cost is one batched read pass after a commit that already
 * dirtied layout (the gap digits changed), so the browser does the same layout it
 * was about to do for paint, just earlier — measured by fps-probe in this slice's
 * PLAN entry rather than assumed.
 */

/**
 * How long a row takes to slide to its new place, in milliseconds.
 *
 * Eyeball-tunable like `COMET_SECONDS`, and PRE-REGISTERED at 300 before the
 * acceptance watch. The bracket it must sit in:
 *
 *  - **Floor:** a tick is ~33 ms and a frame ~16 ms; anything under a few frames
 *    reads as the teleport this slice exists to remove. 300 ms is ~9 ticks.
 *  - **Ceiling:** the reference case (the Monza restart launch at 2×) swaps places
 *    about every 250–500 ms of wall clock, so a longer animation is permanently
 *    behind the field. 300 ms overlaps the fastest swaps — and that is what the
 *    WAAPI retarget above is for: an overlapping resort continues the motion from
 *    the row's current visual position instead of queueing or teleporting.
 *  - The hysteresis dead band (`ORDER_HYSTERESIS_S`, 0.05 s of sort key) already
 *    guarantees a pair cannot legitimately re-swap faster than it takes to build
 *    0.1 s of relative progress, so the animation never fights an oscillation —
 *    that was damped upstream, where it belongs.
 */
export const TOWER_MOVE_MS = 300;

/**
 * Ease-out, because the START of the motion is the information: the row leaves its
 * old place the instant the overtake registers, then settles. It also keeps a
 * retarget honest — a new animation beginning at full speed hides the velocity
 * discontinuity that ease-in would put right where the eye is watching.
 */
export const TOWER_MOVE_EASING = "ease-out";

/**
 * Movements smaller than this many pixels snap instead of animating. Sub-pixel
 * layout jitter (a truncated gap column changing width) is not a reshuffle.
 */
const MIN_MOVE_PX = 1;

/**
 * The one in-flight animation per row. A WeakMap so a row unmounting (a shorter
 * replay was loaded) drops its entry with the element.
 */
const inFlight = new WeakMap<Element, Animation>();

/**
 * One commit's FLIP pass over the tower rows.
 *
 * Always measures and returns the rows' current visual tops (the next commit's
 * First positions). When `animate` is true — the caller saw the order change on an
 * unchanged replay, with motion allowed — every row whose cached top differs from
 * its measured top slides from the old place to the new one.
 *
 * @param rows     the row elements, in rendered order.
 * @param keys     a stable identity per row (the driver code — the same value React
 *                 keys the rows by), aligned with `rows`. Tops are cached by key,
 *                 not element, so the cache survives React reusing or replacing
 *                 nodes.
 * @param previous the tops this returned on the previous commit. Pass an empty map
 *                 to forget continuity (a replay/scenario switch: a fresh tower
 *                 must not slide from where a different session's rows sat).
 * @param animate  whether row movement should animate this commit.
 * @returns the tops to hand back as `previous` next commit.
 */
export function flipRows(
  rows: readonly HTMLElement[],
  keys: readonly string[],
  previous: ReadonlyMap<string, number>,
  animate: boolean,
): Map<string, number> {
  // Cancel before measuring, so every read below is pure layout — the Last
  // position — with no in-flight transform left in it. (The current VISUAL
  // position was already captured: it is what `previous` holds.)
  if (animate) for (const el of rows) inFlight.get(el)?.cancel();

  // One batched read pass; the writes below are transform-only and cannot dirty
  // layout, so this is a single forced layout, not a read/write interleave.
  const tops = rows.map((el) => el.getBoundingClientRect().top);

  const next = new Map<string, number>();
  rows.forEach((el, k) => {
    const top = tops[k];
    next.set(keys[k], top);
    if (!animate) return;
    const first = previous.get(keys[k]);
    if (first === undefined) return; // a row with no history has nowhere to slide from
    const delta = first - top;
    if (Math.abs(delta) < MIN_MOVE_PX) return;
    inFlight.set(
      el,
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        { duration: TOWER_MOVE_MS, easing: TOWER_MOVE_EASING },
      ),
    );
  });
  return next;
}
