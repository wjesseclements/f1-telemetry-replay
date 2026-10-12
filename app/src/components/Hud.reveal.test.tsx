/**
 * Hud.reveal.test.tsx — the tower brings the focused car into view (Slice 26).
 *
 * jsdom has no layout and no `scrollTo` on elements, so both are stood in for: a
 * compact row is 30 px (its header line too), the focused row (the one with a
 * readout `<dl>`) 200 px, the rows 4 px apart (`gap-1`), the list `listHeight` tall
 * with its top at 0, and every box drawn where its offset minus the list's
 * `scrollTop` puts it; `Element.scrollTo` records its calls — from where, to where,
 * how — and moves `scrollTop` (which jsdom stores). The assertions are then exact
 * over the real component and the real engine. The geometry in a real browser is
 * the PLAN entry's (headless Chrome at 375x626, 724x257, 375x812 and 1440x900).
 *
 * What is pinned, per the slice's trigger ruling:
 *  - a focus change reveals the focused block — by a click, by the store (the
 *    keyboard's cycle), by a replay load (even at the same index), once its row
 *    renders;
 *  - nearest when the block fits, its top when it does not, nothing when it is
 *    already whole;
 *  - first, a row that was on screen is HELD where the viewer saw it while the
 *    readout above it closes (a scroll by exactly as far as it moved);
 *  - smooth, or an instant jump (`"auto"`, with no CSS `scroll-behavior`
 *    anywhere) under `prefers-reduced-motion`;
 *  - NOTHING else scrolls the list: no reorder, no tick, no re-click;
 *  - it is the LIST that scrolls (`scrollTo` on it), never `scrollIntoView`.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CarSnapshot } from "../engine/interpolate";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";
import css from "../index.css?inline";
import { Hud } from "./Hud";

const ROW_H = 30;
const BLOCK_H = 200;
const GAP = 4;
let listHeight = 100;

type ScrollCall = { el: Element; from: number; options: ScrollToOptions };
let scrollCalls: ScrollCall[] = [];
const scrollIntoView = vi.fn();

const isRow = (el: Element) => el.tagName === "LI";
const rowHeight = (li: Element) =>
  li.querySelector("dl") === null ? ROW_H : BLOCK_H;
const rowsOf = (ul: Element) => Array.from(ul.children).filter(isRow);

beforeEach(() => {
  telemetry.reset();
  useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null });
  listHeight = 100;
  scrollCalls = [];
  scrollIntoView.mockClear();
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
    function (this: HTMLElement) {
      const ul = this.parentElement;
      if (!isRow(this) || ul === null) return 0;
      let y = 0;
      for (const li of rowsOf(ul)) {
        if (li === this) return y;
        y += rowHeight(li) + GAP;
      }
      return 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      if (isRow(this)) return rowHeight(this);
      // A row's header line: the compact row's whole height.
      const li = this.parentElement;
      return li !== null && isRow(li) && li.firstElementChild === this
        ? ROW_H
        : 0;
    },
  );
  // Drawn boxes: a row sits at its offset less the list's scroll, the list at 0.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const ul = this.parentElement;
      const top =
        isRow(this) && ul !== null
          ? (this as HTMLElement).offsetTop - ul.scrollTop
          : 0;
      return { top, toJSON: () => ({}) } as DOMRect;
    },
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    function (this: Element) {
      return this.tagName === "UL" ? listHeight : 0;
    },
  );
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(
    function (this: Element) {
      if (this.tagName !== "UL") return 0;
      const rows = rowsOf(this);
      return (
        rows.reduce((sum, li) => sum + rowHeight(li), 0) +
        Math.max(0, rows.length - 1) * GAP
      );
    },
  );
  Element.prototype.scrollTo = function (
    this: Element,
    options?: ScrollToOptions | number,
  ) {
    const o = options as ScrollToOptions;
    scrollCalls.push({ el: this, from: this.scrollTop, options: o });
    this.scrollTop = o.top ?? this.scrollTop;
  } as Element["scrollTo"];
  Element.prototype.scrollIntoView = scrollIntoView;
  // A reorder over this layout really moves rows, so the FLIP pass animates: jsdom
  // has no WAAPI, and the slides are Hud.flip.test.tsx's to pin, not this file's.
  Element.prototype.animate = function () {
    return { cancel: () => undefined } as unknown as Animation;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "animate");
});

// ---------------------------------------------------------------------------------
// The analytic ring of Hud.flip.test.tsx: a 1000 m circle at 180 km/h, cars spaced
// by whole samples, so the running order is exact by construction — a larger
// shift runs further ahead and sorts higher.
// ---------------------------------------------------------------------------------
const RATE = 10;
const PER_LAP = 200;

function ringSamples(shift: number) {
  const radius = 1000 / (2 * Math.PI);
  return Array.from({ length: PER_LAP * 2 }, (_, k) => {
    const a = (2 * Math.PI * (k + shift)) / PER_LAP;
    return {
      t: k / RATE,
      x: radius * Math.cos(a),
      y: radius * Math.sin(a),
      speed: 180,
      throttle: 100,
      brake: 0,
      gear: 8,
    };
  });
}

type RawCar = { driver: string; shift: number; retiredAt?: number };

function ringReplay(name: string, ...cars: RawCar[]): Replay {
  return parseReplay(
    {
      meta: {
        schemaVersion: 1,
        sampleRateHz: RATE,
        duration: (PER_LAP * 2) / RATE,
        rotation: 0,
        loop: "open",
        units: { speed: "km/h" },
        year: 2026,
        event: "Test",
        track: "Test",
        session: "R",
      },
      track: {
        corners: [],
        startFinish: { x: 0, y: 0, angle: 0 },
        pitLane: [],
      },
      cars: cars.map(({ driver, shift, retiredAt }) => ({
        driver,
        team: "Test",
        color: "#888888",
        samples: ringSamples(shift),
        laps: [],
        stints: [],
        dropouts: [],
        ...(retiredAt === undefined ? {} : { retiredAt }),
      })),
      trackStatus: [],
    },
    name,
  );
}

const snapshotsFor = (replay: Replay): CarSnapshot[] =>
  replay.cars.map((_, index) => ({
    index,
    t: 0,
    x: 0,
    y: 0,
    heading: 0,
    speed: 180,
    throttle: 100,
    brake: 0,
    gear: 8,
    drs: 0,
  }));

/** Six cars, A0 leading A5 by 10 samples a place: the order is A0..A5. */
const SIX = ringReplay(
  "six.json",
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ driver: `A${k}`, shift: 50 - 10 * k })),
);

let nowMs = 1000;
function publish(replay: Replay, clock: number) {
  nowMs += 40;
  act(() => telemetry.publish(nowMs, clock, snapshotsFor(replay)));
}

const list = () => screen.getByRole("list", { name: "Running order" });
const rowButton = (driver: string) =>
  screen
    .getAllByRole("button")
    .find(
      (b) =>
        b.getAttribute("aria-keyshortcuts") !== null &&
        (b.textContent ?? "").startsWith(driver),
    ) as HTMLElement;

describe("tower focus reveal (Slice 26) — what it does", () => {
  it("shows a block taller than the list from its top when a row is clicked", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    // A0 is focused and first: its top is already the list's top.
    expect(scrollCalls).toHaveLength(0);

    fireEvent.click(rowButton("A3"));
    // A0..A2 are compact now, so A3's block starts at 3 x (30 + 4) = 102, and at
    // 200 px it cannot fit a 100 px list: its top goes to the list's top.
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(list());
    expect(scrollCalls[0].options).toEqual({ top: 102, behavior: "smooth" });
  });

  it("scrolls the least distance when the block fits, keeping the cars ahead", () => {
    listHeight = 250;
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    fireEvent.click(rowButton("A3"));
    // 102..302 in a 0..250 port: 52 px down shows it whole with A1 and A2 above.
    expect(scrollCalls.map((c) => c.options)).toEqual([
      { top: 52, behavior: "smooth" },
    ]);
  });

  it("does not scroll at all when the focused block is already whole", () => {
    listHeight = 1000;
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    fireEvent.click(rowButton("A3"));
    expect(scrollCalls).toHaveLength(0);
  });

  it("jumps instead of gliding under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
    }));
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    fireEvent.click(rowButton("A3"));
    expect(scrollCalls.map((c) => c.options)).toEqual([
      { top: 102, behavior: "auto" },
    ]);
  });

  it("jumps with `auto` because no stylesheet makes `auto` smooth", () => {
    // `behavior: "auto"` takes the list's CSS `scroll-behavior`; it is an
    // instant jump only while no rule sets that to `smooth` (`towerReveal.ts`).
    // The compiled stylesheet is the whole app's CSS.
    expect(css).not.toMatch(/scroll-behavior/);
  });

  it("reveals a focus change made through the store — the keyboard's path", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    // useTransportKeys' ArrowDown is exactly this call (cycleFocus over cars[]).
    act(() => useTransport.getState().setFocusedCarIndex(4));
    expect(scrollCalls.map((c) => c.options)).toEqual([
      { top: 136, behavior: "smooth" },
    ]);
  });

  it("scrolls the list itself and never calls scrollIntoView, which would scroll the page", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    fireEvent.click(rowButton("A5"));
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].el).toBe(list());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("tower focus reveal (Slice 26) — what triggers it", () => {
  it("reveals the focused car of a newly loaded replay once its rows render — even at the same index", () => {
    const { rerender } = render(<Hud replay={SIX} />);
    act(() => useTransport.getState().setFocusedCarIndex(2));
    publish(SIX, 5);
    expect(scrollCalls.map((c) => c.options.top)).toEqual([68]);
    list().scrollTop = 0; // the viewer scrolls back to the leaders

    // A three-car replay with index 2 still focused: a different car, so a reveal
    // is owed. Until a frame of the new length is published the tower renders no
    // rows (Hud's stale-frame guard), and the reveal waits for them rather than
    // being spent on an empty list.
    const three = ringReplay(
      "three.json",
      { driver: "B0", shift: 20 },
      { driver: "B1", shift: 10 },
      { driver: "B2", shift: 0 },
    );
    rerender(<Hud replay={three} />);
    expect(list().children).toHaveLength(0);
    expect(scrollCalls).toHaveLength(1);

    publish(three, 5);
    // B2 is third: its block starts at 2 x 34 = 68.
    expect(scrollCalls.map((c) => c.options.top)).toEqual([68, 68]);
    publish(three, 6); // a tick: nothing more
    expect(scrollCalls).toHaveLength(2);
  });

  it("does not follow the focused car through a reorder, or scroll on a tick", () => {
    // FOC third behind AHE and GON; GON retires at t=10 and drops to the bottom,
    // which lifts FOC a place. The list stays where the reveal left it.
    const replay = ringReplay(
      "reorder.json",
      { driver: "AHE", shift: 40 },
      { driver: "GON", shift: 20, retiredAt: 10 },
      { driver: "FOC", shift: 0 },
    );
    act(() => useTransport.getState().setFocusedCarIndex(2));
    render(<Hud replay={replay} />);
    publish(replay, 5);
    expect(scrollCalls.map((c) => c.options.top)).toEqual([68]);

    publish(replay, 30);
    const order = Array.from(list().children).map((li) =>
      (li.textContent ?? "").slice(0, 3),
    );
    expect(order).toEqual(["AHE", "FOC", "GON"]); // the reorder landed
    publish(replay, 31);
    publish(replay, 32);
    expect(scrollCalls).toHaveLength(1);
    expect(list().scrollTop).toBe(68);
  });

  it("does not scroll when the focused row is clicked again", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    fireEvent.click(rowButton("A3"));
    expect(scrollCalls).toHaveLength(1);
    list().scrollTop = 0; // the viewer scrolls away
    // Not a focus change: the store keeps the same index and nothing commits, so
    // this pins the end-to-end no-op (the trigger guard is pinned by the reorder
    // and comparison tests, which do commit).
    fireEvent.click(rowButton("A3"));
    expect(scrollCalls).toHaveLength(1);
    expect(list().scrollTop).toBe(0);
  });

  it("holds a clicked row under the finger while the readout above it closes, then glides", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    // The viewer scrolls past A0's open block: A3 shows 22 px down the list.
    list().scrollTop = 250;
    fireEvent.click(rowButton("A3"));
    // A0 closing moved A3 from 272 up to 102, so the list first follows it by the
    // same 170 px (80), keeping it 22 px down; the reveal glides on from there.
    expect(scrollCalls).toHaveLength(1);
    expect(scrollCalls[0].from).toBe(80);
    expect(scrollCalls[0].options).toEqual({ top: 102, behavior: "smooth" });
  });

  it("holds under prefers-reduced-motion too — keeping still is not motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
    }));
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    list().scrollTop = 250;
    fireEvent.click(rowButton("A3"));
    expect(scrollCalls.map((c) => [c.from, c.options])).toEqual([
      [80, { top: 102, behavior: "auto" }],
    ]);
  });

  it("holds a row clicked on its lower half, whose top had scrolled just out of view", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    list().scrollTop = 280; // A3's top (272) is 8 px above the list; its line shows
    fireEvent.click(rowButton("A3"));
    expect(scrollCalls.map((c) => c.from)).toEqual([110]);
  });

  it("does not hold a row that was off screen — the keyboard's next car", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    // A5 sat at 340, below a 100..200 view (A0's open block): following it up the
    // 170 px it moved would drag every visible row down, to keep still a row
    // nobody could see. The reveal starts from where the viewer was.
    list().scrollTop = 100;
    act(() => useTransport.getState().setFocusedCarIndex(5));
    expect(scrollCalls.map((c) => [c.from, c.options.top])).toEqual([
      [100, 170],
    ]);
  });

  it("does not hold across a replay load — a new session's row was never seen", () => {
    const { rerender } = render(<Hud replay={SIX} />);
    publish(SIX, 5);
    list().scrollTop = 250;
    // The same six drivers in a new file: a row keyed A3 exists in both, but the
    // one on screen belonged to the other session.
    const again = ringReplay(
      "again.json",
      ...[0, 1, 2, 3, 4, 5].map((k) => ({
        driver: `A${k}`,
        shift: 50 - 10 * k,
      })),
    );
    // One commit, as applyScenario lands it: the new replay and its driver.
    act(() => {
      useTransport.getState().setFocusedCarIndex(3);
      rerender(<Hud replay={again} />);
    });
    expect(scrollCalls.map((c) => [c.from, c.options.top])).toEqual([
      [250, 102],
    ]);
  });

  it("does not scroll when the comparison car changes", () => {
    render(<Hud replay={SIX} />);
    publish(SIX, 5);
    // The viewer has scrolled A0's open block half out of view: a reveal now
    // WOULD move the list (back to 0), so a toggle that commits must not run one.
    list().scrollTop = 120;
    fireEvent.click(screen.getByRole("button", { name: "vs A5" }));
    expect(useTransport.getState().comparisonCarIndex).toBe(5);
    expect(scrollCalls).toHaveLength(0);
    expect(list().scrollTop).toBe(120);
  });
});
