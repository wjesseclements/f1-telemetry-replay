/**
 * Hud.flip.test.tsx — the tower reshuffle animation (Slice 21), at the seam.
 *
 * jsdom has no layout and no Web Animations API, so both halves of FLIP are stood in
 * for here: `getBoundingClientRect` answers with the element's index among its
 * siblings (each row 30px tall), and `Element.prototype.animate` records its calls.
 * That makes the assertions exact — a row that moved one place slides exactly ±30px —
 * while the code under test is the real component over the real engine.
 *
 * What is pinned, per the slice's what-animates ruling:
 *  - a REORDER applies transforms (a retirement dropping to the bottom is the
 *    deterministic case; the Monza restart launch is the real-overtake case);
 *  - a replay/scenario switch does NOT (fresh tower, no false continuity), even when
 *    the same drivers land in a different order;
 *  - `prefers-reduced-motion` suppresses the animation, not the reorder;
 *  - a focus change alone animates nothing (the readout's height change snaps).
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import restartJson from "../../public/gallery/monza-2026-restart.json";
import type { CarSnapshot } from "../engine/interpolate";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";
import { Hud } from "./Hud";
import { TOWER_MOVE_EASING, TOWER_MOVE_MS, flipRows } from "./towerFlip";

const ROW_H = 30;

/** Every `el.animate(...)` the component made, with the element that made it. */
type AnimateCall = {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
};
let animateCalls: AnimateCall[] = [];

/** A layout for jsdom: an element's top is its index among its siblings × ROW_H. */
function fakeRect(this: Element): DOMRect {
  const parent = this.parentElement;
  const index =
    parent === null ? 0 : Array.prototype.indexOf.call(parent.children, this);
  const top = index * ROW_H;
  return {
    top,
    bottom: top + ROW_H,
    left: 0,
    right: 0,
    width: 0,
    height: ROW_H,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  telemetry.reset();
  useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null });
  animateCalls = [];
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    fakeRect,
  );
  // jsdom has no WAAPI; install a recorder in its place. The stub is not a full
  // Animation — `flipRows` only ever calls `cancel()` on what it gets back.
  Element.prototype.animate = function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ) {
    const cancel = vi.fn();
    animateCalls.push({
      el: this,
      keyframes: keyframes as Keyframe[],
      options: options as KeyframeAnimationOptions,
      cancel,
    });
    return { cancel } as unknown as Animation;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, "animate");
});

/** The rows' driver codes, in rendered order. */
const rowDrivers = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Running order"] > li')].map(
    (li) => (li.textContent ?? "").slice(0, 3),
  );

/** The driver code of the row an animate call was made on. */
const animatedDriver = (call: AnimateCall) =>
  (call.el.textContent ?? "").slice(0, 3);

// ---------------------------------------------------------------------------------
// The analytic ring from Hud.test.tsx's Slice 19 exhibits: a 1000 m circle at
// 180 km/h, so states, order and therefore the reorder instant are exact by
// construction. A retirement mid-window is the deterministic reorder: GON runs 2 s
// ahead of FOC until t=10, then drops to the bottom as DNF.
// ---------------------------------------------------------------------------------
const RATE = 10;
const PER_LAP = 200;

function ringSamples(shift = 0) {
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

type RawCar = {
  driver: string;
  samples: ReturnType<typeof ringSamples>;
  retiredAt?: number;
};

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
      track: { corners: [], startFinish: { x: 0, y: 0, angle: 0 } },
      cars: cars.map((car) => ({
        team: "Test",
        color: "#888888",
        laps: [],
        stints: [],
        dropouts: [],
        ...car,
      })),
      trackStatus: [],
    },
    name,
  );
}

const ringSnapshots = (replay: Replay): CarSnapshot[] =>
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

describe("tower reshuffle animation (Slice 21)", () => {
  it("slides both rows of a reorder by exactly the rows they crossed — the DNF drop", () => {
    const replay = ringReplay(
      "flip.json",
      { driver: "FOC", samples: ringSamples() },
      { driver: "GON", samples: ringSamples(20), retiredAt: 10 },
    );
    const { container } = render(<Hud replay={replay} />);
    act(() => telemetry.publish(1000, 5, ringSnapshots(replay)));
    expect(rowDrivers(container)).toEqual(["GON", "FOC"]);
    expect(animateCalls).toHaveLength(0); // rows appearing is not a reorder

    act(() => telemetry.publish(1080, 30, ringSnapshots(replay)));
    expect(rowDrivers(container)).toEqual(["FOC", "GON"]);

    // Both rows slide, each from its old place: FOC rose one row (starts 30px
    // below its new top), GON dropped one (starts 30px above).
    expect(animateCalls).toHaveLength(2);
    const byDriver = Object.fromEntries(
      animateCalls.map((c) => [animatedDriver(c), c]),
    );
    expect(byDriver.FOC.keyframes).toEqual([
      { transform: `translateY(${ROW_H}px)` },
      { transform: "none" },
    ]);
    expect(byDriver.GON.keyframes).toEqual([
      { transform: `translateY(${-ROW_H}px)` },
      { transform: "none" },
    ]);
    for (const call of animateCalls) {
      expect(call.options).toEqual({
        duration: TOWER_MOVE_MS,
        easing: TOWER_MOVE_EASING,
      });
    }
  });

  it("animates a real overtake on the shipped restart asset — the reference case", () => {
    // NOR passes COL off the restart launch with the swap landing at ~88.5 s
    // (measured in Hud.launch.test.tsx). Sweeping the tower across it must produce
    // slides: rows moving in both directions, all with the registered duration.
    const replay = parseReplay(restartJson, "monza-2026-restart.json");
    const snapshots: CarSnapshot[] = replay.cars.map((_, index) => ({
      index,
      t: 0,
      x: 0,
      y: 0,
      heading: 0,
      speed: 0,
      throttle: 0,
      brake: 0,
      gear: 0,
      drs: 0,
    }));
    render(<Hud replay={replay} />);

    let nowMs = 1000;
    for (let clock = 88.0; clock <= 89.0; clock += 0.1) {
      nowMs += 40;
      act(() => telemetry.publish(nowMs, clock, snapshots));
    }

    expect(animateCalls.length).toBeGreaterThanOrEqual(2);
    const deltas = animateCalls.map((c) =>
      parseFloat(String(c.keyframes[0].transform).replace("translateY(", "")),
    );
    // A swap moves someone up and someone down, always by whole rows.
    expect(deltas.some((d) => d > 0)).toBe(true);
    expect(deltas.some((d) => d < 0)).toBe(true);
    for (const d of deltas) expect(Math.abs(d) % ROW_H).toBe(0);
    for (const call of animateCalls) {
      expect(call.options).toEqual({
        duration: TOWER_MOVE_MS,
        easing: TOWER_MOVE_EASING,
      });
    }
  });

  it("does NOT animate a replay/scenario switch, even one that reorders the same drivers", () => {
    // Same two drivers, opposite order: A has SEC 2 s ahead, B has SEC 2 s behind.
    // The rows visibly swap on the switch — and must snap, not slide: the same
    // driver's row in a different session is a different fact, and sliding it would
    // invent continuity the data does not have.
    const a = ringReplay(
      "a.json",
      { driver: "FOC", samples: ringSamples() },
      { driver: "SEC", samples: ringSamples(20) },
    );
    const b = ringReplay(
      "b.json",
      { driver: "FOC", samples: ringSamples() },
      { driver: "SEC", samples: ringSamples(-20) },
    );
    const { container, rerender } = render(<Hud replay={a} />);
    act(() => telemetry.publish(1000, 5, ringSnapshots(a)));
    expect(rowDrivers(container)).toEqual(["SEC", "FOC"]);

    rerender(<Hud replay={b} />);
    act(() => telemetry.publish(1080, 5, ringSnapshots(b)));
    expect(rowDrivers(container)).toEqual(["FOC", "SEC"]);
    expect(animateCalls).toHaveLength(0);
  });

  it("respects prefers-reduced-motion: the reorder lands, the slide does not", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
    }));
    const replay = ringReplay(
      "reduced.json",
      { driver: "FOC", samples: ringSamples() },
      { driver: "GON", samples: ringSamples(20), retiredAt: 10 },
    );
    const { container } = render(<Hud replay={replay} />);
    act(() => telemetry.publish(1000, 5, ringSnapshots(replay)));
    act(() => telemetry.publish(1080, 30, ringSnapshots(replay)));
    expect(rowDrivers(container)).toEqual(["FOC", "GON"]); // the reorder itself lands
    expect(animateCalls).toHaveLength(0);
  });

  it("animates nothing on a focus change — the readout's height change snaps", () => {
    const replay = ringReplay(
      "focus.json",
      { driver: "FOC", samples: ringSamples() },
      { driver: "SEC", samples: ringSamples(20) },
    );
    render(<Hud replay={replay} />);
    act(() => telemetry.publish(1000, 5, ringSnapshots(replay)));

    const secRow = screen
      .getAllByRole("button")
      .find((b) => /^SEC/.test(b.textContent ?? ""));
    fireEvent.click(secRow as HTMLElement);
    expect(useTransport.getState().focusedCarIndex).toBe(1);
    expect(animateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------
// flipRows in isolation: the retarget contract the component tests cannot reach —
// a resort landing mid-animation must cancel the in-flight slide before measuring,
// and sub-pixel jitter must not animate at all.
// ---------------------------------------------------------------------------------
describe("flipRows", () => {
  function rowAt(top: number): HTMLElement {
    const el = document.createElement("li");
    el.getBoundingClientRect = () => ({ top, toJSON: () => ({}) }) as DOMRect;
    return el;
  }

  it("returns tops without animating when given no history", () => {
    const rows = [rowAt(0), rowAt(30)];
    const tops = flipRows(rows, ["A", "B"], new Map(), true);
    expect([...tops]).toEqual([
      ["A", 0],
      ["B", 30],
    ]);
    expect(animateCalls).toHaveLength(0);
  });

  it("slides a swap both ways, then cancels those slides when a resort lands mid-flight", () => {
    const rows = [rowAt(0), rowAt(30)];
    const first = flipRows(rows, ["A", "B"], new Map(), false);
    // A swap: A now measures 30, B measures 0.
    rows[0].getBoundingClientRect = () =>
      ({ top: 30, toJSON: () => ({}) }) as DOMRect;
    rows[1].getBoundingClientRect = () =>
      ({ top: 0, toJSON: () => ({}) }) as DOMRect;
    const second = flipRows(rows, ["A", "B"], first, true);
    expect(animateCalls.map((c) => c.keyframes[0].transform)).toEqual([
      "translateY(-30px)",
      "translateY(30px)",
    ]);

    // A second resort while those run: the in-flight slides are cancelled BEFORE
    // the new measurement, so the Last positions are pure layout and the new slide
    // starts from where `second` (the previous pass's answer) says the eye left off.
    const inFlight = [...animateCalls];
    rows[0].getBoundingClientRect = () =>
      ({ top: 90, toJSON: () => ({}) }) as DOMRect;
    flipRows(rows, ["A", "B"], second, true);
    for (const call of inFlight) expect(call.cancel).toHaveBeenCalledOnce();
    // A moved again (cached 30 → measured 90): a fresh slide from the cached spot.
    expect(animateCalls).toHaveLength(3);
    expect(animateCalls[2].keyframes[0].transform).toBe("translateY(-60px)");
  });

  it("snaps sub-pixel movement instead of animating it", () => {
    const rows = [rowAt(0)];
    const first = flipRows(rows, ["A"], new Map(), false);
    rows[0].getBoundingClientRect = () =>
      ({ top: 0.4, toJSON: () => ({}) }) as DOMRect;
    flipRows(rows, ["A"], first, true);
    expect(animateCalls).toHaveLength(0);
  });

  it("measures without animating when animate is false, feeding the next pass", () => {
    const rows = [rowAt(0), rowAt(30)];
    const tops = flipRows(rows, ["A", "B"], new Map([["A", 90]]), false);
    expect(tops.get("A")).toBe(0);
    expect(animateCalls).toHaveLength(0);
  });
});
