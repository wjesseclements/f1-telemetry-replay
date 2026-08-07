import { describe, expect, it } from "vitest";
import { ORDER_HYSTERESIS_S, orderByGap, sameOrder } from "./runningOrder";

describe("orderByGap", () => {
  it("sorts ahead-to-behind when there is no previous order to prefer", () => {
    // Negative is ahead of the focused car, positive is behind.
    expect(orderByGap([], [0, 1.2, -3.4])).toEqual([2, 0, 1]);
  });

  it("leaves an already-ordered tower alone", () => {
    const previous = [2, 0, 1];
    expect(orderByGap(previous, [0, 1.2, -3.4])).toEqual(previous);
  });

  it("is idempotent — running it again changes nothing", () => {
    const once = orderByGap([], [0, 1.2, -3.4, 0.3]);
    expect(orderByGap(once, [0, 1.2, -3.4, 0.3])).toEqual(once);
  });
});

describe("orderByGap hysteresis", () => {
  const gaps = (a: number, b: number) => [a, b];

  it("does NOT reorder on a crossing smaller than the dead band", () => {
    const previous = [0, 1];
    // Car 1 is now ahead of car 0, but only just: side-by-side noise, not an overtake.
    const closer = ORDER_HYSTERESIS_S / 2;
    expect(orderByGap(previous, gaps(0, -closer))).toEqual([0, 1]);
  });

  it("reorders on a crossing that is decisively better", () => {
    const previous = [0, 1];
    const clear = ORDER_HYSTERESIS_S * 2;
    expect(orderByGap(previous, gaps(0, -clear))).toEqual([1, 0]);
  });

  it("cannot oscillate: coming back needs the same margin again", () => {
    const clear = ORDER_HYSTERESIS_S * 2;
    const swapped = orderByGap([0, 1], gaps(0, -clear));
    expect(swapped).toEqual([1, 0]);
    // Car 0 edges back ahead by less than the band — the rows must hold.
    expect(orderByGap(swapped, gaps(0, ORDER_HYSTERESIS_S / 2))).toEqual([
      1, 0,
    ]);
    // Now decisively, and they swap back.
    expect(orderByGap(swapped, gaps(0, clear))).toEqual([0, 1]);
  });

  it("accepts a hysteresis of zero, which is a plain sort", () => {
    expect(orderByGap([0, 1], gaps(0, -0.001), 0)).toEqual([1, 0]);
  });

  it("moves a car as far up as it deserves in one pass, not one place at a time", () => {
    // Car 3 arrives from the back of a four-car tower with the best gap of all.
    expect(orderByGap([0, 1, 2, 3], [0, 1, 2, -5])).toEqual([3, 0, 1, 2]);
  });
});

describe("orderByGap with unknown gaps", () => {
  it("pins cars without a gap to the bottom, in cars[] order", () => {
    expect(orderByGap([], [0, null, -2, null])).toEqual([2, 0, 1, 3]);
  });

  it("keeps an unknown gap out of the sort rather than treating it as zero", () => {
    // Car 1's gap is unknown; it must not sit between the two timed cars just because
    // zero would put it there.
    expect(orderByGap([1, 0, 2], [-1, null, 1])).toEqual([0, 2, 1]);
  });

  it("returns a car to the running order when its gap comes back", () => {
    const away = orderByGap([], [0, null]);
    expect(away).toEqual([0, 1]);
    expect(orderByGap(away, [0, -9])).toEqual([1, 0]);
  });
});

describe("orderByGap when the replay changes underneath it", () => {
  it("drops indices that are no longer cars", () => {
    expect(orderByGap([3, 2, 0, 1], [0, -1])).toEqual([1, 0]);
  });

  it("adds cars the previous order had never seen, in source order", () => {
    expect(orderByGap([0], [0, 5, 6])).toEqual([0, 1, 2]);
  });

  it("ignores a duplicated index in the previous order", () => {
    expect(orderByGap([1, 1, 0], [0, -1])).toEqual([1, 0]);
  });

  it("returns an empty order for an empty tower", () => {
    expect(orderByGap([0, 1], [])).toEqual([]);
  });
});

/**
 * THE DEAD BAND IS DENOMINATED IN SECONDS, and these are the tests that say so.
 *
 * Slice 9d considered moving the sort key from `seconds` to the progress difference
 * `ΔP` and rejected it (see `runningOrder.ts`), because `ORDER_HYSTERESIS_S` would then
 * be a seconds constant applied to a progress quantity. The failure is silent in both
 * directions — vacuous at ~0.9 mm of track, or ~4 s and enormous — and **every existing
 * test above passes either way**, because none of them lands near the boundary. These do.
 */
describe("the hysteresis dead band, probed at its boundary", () => {
  /** The smallest gap improvement that actually takes a place, found by bisection. */
  function measuredBand(): number {
    let no = 0;
    let yes = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (no + yes) / 2;
      // Car 1 is `mid` better than car 0, starting from the order [0, 1].
      if (orderByGap([0, 1], [0, -mid])[0] === 1) yes = mid;
      else no = mid;
    }
    return yes;
  }

  it("swaps at exactly ORDER_HYSTERESIS_S, in seconds", () => {
    expect(measuredBand()).toBeCloseTo(ORDER_HYSTERESIS_S, 9);
  });

  it("holds just inside the band and swaps just outside it", () => {
    const inside = ORDER_HYSTERESIS_S * 0.99;
    const outside = ORDER_HYSTERESIS_S * 1.01;
    expect(orderByGap([0, 1], [0, -inside])).toEqual([0, 1]);
    expect(orderByGap([0, 1], [0, -outside])).toEqual([1, 0]);
  });

  it("is not denominated in progress units — 0.05 of a LAP must swap", () => {
    // A lap of the real circuit is ~85 s. If the constant had been wired to `ΔP` as a
    // fraction of a lap, the band would be ~4 s and this pair would NOT swap.
    const lapSeconds = 85.5;
    expect(orderByGap([0, 1], [0, -0.05 * lapSeconds])).toEqual([1, 0]);
  });

  it("is not denominated in raw position units either — 0.05 units must NOT swap", () => {
    // The other misreading: 0.05 of a position unit is under a millimetre of track,
    // which at racing speed is well under a microsecond. Wired that way the band is
    // vacuous and two cars running together strobe. Expressed in seconds, this is far
    // inside the band and must be ignored.
    const secondsPerUnit = 1 / 673; // ~673 position units per second on the real file
    expect(orderByGap([0, 1], [0, -0.05 * secondsPerUnit])).toEqual([0, 1]);
  });

  it("keeps damping a pair that crosses and re-crosses", () => {
    // What the band is FOR, and the reason 9d did not touch it: two cars swapping by
    // milliseconds many times a second must not restrobe the tower.
    let order = [0, 1];
    for (let i = 0; i < 50; i++) {
      order = orderByGap(order, [0, i % 2 === 0 ? 0.01 : -0.01]);
    }
    expect(order).toEqual([0, 1]);
  });
});

describe("sameOrder", () => {
  it("is true only for the same cars in the same places", () => {
    expect(sameOrder([2, 0, 1], [2, 0, 1])).toBe(true);
    expect(sameOrder([2, 0, 1], [2, 1, 0])).toBe(false);
    expect(sameOrder([], [])).toBe(true);
  });

  it("is false when the field changes size", () => {
    expect(sameOrder([0, 1], [0, 1, 2])).toBe(false);
    expect(sameOrder([0, 1, 2], [0, 1])).toBe(false);
  });
});
