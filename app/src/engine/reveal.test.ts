import { describe, expect, it } from "vitest";
import { holdOffset, revealOffset } from "./reveal";

/** A 100 px port over 1000 px of content, scrolled to `offset`. */
const port = (offset: number) => ({ offset, size: 100, content: 1000 });

describe("revealOffset — an item that fits", () => {
  it("does not move when the item is already whole", () => {
    expect(revealOffset(port(200), { start: 220, size: 50 })).toBe(200);
  });

  it("does not move when the item exactly fills the port", () => {
    // Both edges on the port's edges: whole, and the start-edge rule agrees.
    expect(revealOffset(port(200), { start: 200, size: 100 })).toBe(200);
  });

  it("scrolls the least distance when the item is cut at the bottom", () => {
    // 280–330 in a 200–300 port: 30 px down puts its end on the port's end, and the
    // rows above it stay in view.
    expect(revealOffset(port(200), { start: 280, size: 50 })).toBe(230);
  });

  it("scrolls the least distance when the item is cut at the top", () => {
    expect(revealOffset(port(200), { start: 180, size: 50 })).toBe(180);
  });

  it("reveals an item that is entirely out of view, from either side", () => {
    expect(revealOffset(port(200), { start: 500, size: 50 })).toBe(450);
    expect(revealOffset(port(200), { start: 20, size: 50 })).toBe(20);
  });

  it("treats an end exactly on the port's end as whole", () => {
    expect(revealOffset(port(200), { start: 250, size: 50 })).toBe(200);
  });
});

describe("revealOffset — an item taller than the port", () => {
  it("shows its top when it runs off the bottom", () => {
    expect(revealOffset(port(0), { start: 60, size: 227 })).toBe(60);
  });

  it("shows its top when its top is above the port (not its bottom, as `nearest` would)", () => {
    expect(revealOffset(port(200), { start: 150, size: 227 })).toBe(150);
  });

  it("shows its top when it spans the whole port (where `nearest` would not move)", () => {
    expect(revealOffset(port(200), { start: 150, size: 400 })).toBe(150);
  });

  it("does not move when its top is already the port's top", () => {
    expect(revealOffset(port(150), { start: 150, size: 400 })).toBe(150);
  });
});

describe("revealOffset — the offsets the port can take", () => {
  it("never asks for less than zero", () => {
    expect(revealOffset(port(50), { start: -10, size: 20 })).toBe(0);
  });

  it("never asks for more than the content allows", () => {
    // The last item, taller than the port: its top is past the last offset, so the
    // port stops at the end of the content instead.
    expect(revealOffset(port(0), { start: 950, size: 120 })).toBe(900);
  });

  it("asks for nothing in a port with no size (no layout: jsdom, a hidden list)", () => {
    expect(
      revealOffset({ offset: 0, size: 0, content: 0 }, { start: 0, size: 0 }),
    ).toBe(0);
  });

  it("asks for nothing when the content is shorter than the port", () => {
    expect(
      revealOffset(
        { offset: 0, size: 300, content: 200 },
        { start: 150, size: 50 },
      ),
    ).toBe(0);
  });
});

describe("holdOffset — keeping a moved item where it was seen", () => {
  it("follows an item the content moved up, so it stays put on screen", () => {
    // Seen at 272 in a port at 250 (22 px down); a readout above it closed and it
    // now starts at 102: the port moves up the same 170 px.
    expect(holdOffset(port(250), 272, 102, 30)).toBe(80);
  });

  it("follows an item the content moved down", () => {
    expect(holdOffset(port(200), 220, 385, 30)).toBe(365);
  });

  it("does not move when the item did not", () => {
    expect(holdOffset(port(200), 220, 220, 30)).toBe(200);
  });

  it("holds an item whose start is above the port by less than its reach", () => {
    // Clicked on its lower half: its first line still showed.
    expect(holdOffset(port(280), 272, 102, 30)).toBe(110);
  });

  it("does not hold an item that was off screen, above or below", () => {
    expect(holdOffset(port(305), 272, 102, 30)).toBe(305); // a full reach above
    expect(holdOffset(port(0), 340, 170, 30)).toBe(0); // below the port
    expect(holdOffset(port(0), 100, 50, 30)).toBe(0); // exactly at the port's end
  });

  it("never asks for an offset the port cannot take", () => {
    expect(holdOffset(port(50), 60, 0, 30)).toBe(0);
    expect(holdOffset(port(880), 890, 1000, 30)).toBe(900);
  });
});
