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
