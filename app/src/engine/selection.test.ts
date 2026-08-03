import { describe, expect, it } from "vitest";
import { cycleFocus } from "./selection";

describe("cycleFocus", () => {
  it("steps forward and backward through the cars", () => {
    expect(cycleFocus(3, 0, 1)).toBe(1);
    expect(cycleFocus(3, 1, -1)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(cycleFocus(3, 2, 1)).toBe(0);
    expect(cycleFocus(3, 0, -1)).toBe(2);
  });

  it("is a no-op with one car, without anything branching on the count", () => {
    expect(cycleFocus(1, 0, 1)).toBe(0);
    expect(cycleFocus(1, 0, -1)).toBe(0);
  });

  it("recovers to the first car when the focus is out of range", () => {
    // A shorter replay was loaded while car 7 was focused.
    expect(cycleFocus(3, 7, 1)).toBe(1);
    expect(cycleFocus(3, -1, 0)).toBe(0);
    expect(cycleFocus(3, 1.5, 1)).toBe(1);
  });

  it("returns the first car for an empty tower rather than throwing", () => {
    expect(cycleFocus(0, 0, 1)).toBe(0);
  });

  it("handles a delta larger than the field", () => {
    expect(cycleFocus(3, 0, 4)).toBe(1);
    expect(cycleFocus(3, 0, -4)).toBe(2);
  });
});
