/**
 * HUD tests — the values, and the DRS indicator in BOTH states.
 *
 * Rule 8 says the indicator exists only when the data carries a DRS channel. The
 * committed fixture HAS one, so the absent case needs a `drs`-stripped clone — testing
 * only the rendered state would leave the branch that matters for 2026+ replays
 * completely uncovered.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { CarSnapshot } from "../engine/interpolate";
import type { Replay } from "../engine/schema";
import { NO_VALUE } from "../engine/format";
import { useTransport } from "../store/transport";
import { displaySignature, telemetry } from "../telemetry/channel";
import { Hud } from "./Hud";

const replay = parseReplay(sampleLap, "sample-lap.json");

/** The same fixture with the DRS channel removed — a stand-in for a 2026+ replay. */
const noDrsReplay: Replay = (() => {
  const raw = JSON.parse(JSON.stringify(sampleLap));
  for (const car of raw.cars) {
    for (const s of car.samples) delete s.drs;
  }
  return parseReplay(raw, "no-drs.json");
})();

function snapshot(over: Partial<CarSnapshot> = {}): CarSnapshot {
  return {
    index: 0,
    t: 0,
    x: 0,
    y: 0,
    heading: 0,
    speed: 243.6,
    throttle: 72,
    brake: 0,
    gear: 6,
    drs: 8,
    ...over,
  };
}

/** Publish a frame and render — the only way values reach the HUD. */
function renderHud(target: Replay, snap: CarSnapshot = snapshot()) {
  telemetry.publish(1000, 12.4, [snap]);
  return render(<Hud replay={target} />);
}

beforeEach(() => telemetry.reset());
afterEach(cleanup);

describe("Hud values", () => {
  it("shows speed rounded to whole km/h", () => {
    renderHud(replay, snapshot({ speed: 243.6 }));
    expect(screen.getByText("244")).toBeInTheDocument();
  });

  it("shows the gear, with N for neutral", () => {
    renderHud(replay, snapshot({ gear: 6 }));
    expect(screen.getByText("6")).toBeInTheDocument();

    cleanup();
    telemetry.reset();
    renderHud(replay, snapshot({ gear: 0 }));
    expect(screen.getByText("N")).toBeInTheDocument();
  });

  it("reports throttle and brake as meters a screen reader can read", () => {
    renderHud(replay, snapshot({ throttle: 72, brake: 0 }));
    expect(screen.getByRole("meter", { name: "Throttle" })).toHaveAttribute(
      "aria-valuenow",
      "72",
    );
    expect(screen.getByRole("meter", { name: "Brake" })).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("treats brake as the 0/1 channel the schema defines", () => {
    renderHud(replay, snapshot({ brake: 1 }));
    expect(screen.getByRole("meter", { name: "Brake" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });

  it("renders one readout per car, by mapping the array", () => {
    renderHud(replay);
    // v1 fixture has one car; the point is that nothing branches on the count.
    expect(screen.getAllByRole("meter", { name: "Throttle" })).toHaveLength(
      replay.cars.length,
    );
  });

  it("renders nothing car-shaped before the first publish", () => {
    // EMPTY_FRAME has `cars: []`, so the map produces nothing — no "not loaded" branch.
    render(<Hud replay={replay} />);
    expect(screen.queryByRole("meter", { name: "Throttle" })).toBeNull();
  });
});

describe("Hud DRS indicator (rule 8)", () => {
  it("renders the pill when the data carries a DRS channel", () => {
    renderHud(replay, snapshot({ drs: 8 }));
    expect(screen.getByText(/^DRS (OPEN|CLOSED)$/)).toBeInTheDocument();
  });

  it("reads OPEN for an open code and CLOSED otherwise", () => {
    renderHud(replay, snapshot({ drs: 12 })); // 12 is an open code
    expect(screen.getByText("DRS OPEN")).toBeInTheDocument();

    cleanup();
    telemetry.reset();
    renderHud(replay, snapshot({ drs: 8 })); // 8 is not
    expect(screen.getByText("DRS CLOSED")).toBeInTheDocument();
  });

  it("renders NO pill at all when the replay has no DRS channel", () => {
    // The 2026+ case. Not "renders CLOSED" — renders nothing.
    renderHud(noDrsReplay, snapshot({ drs: undefined }));
    expect(screen.queryByText(/^DRS (OPEN|CLOSED)$/)).toBeNull();
  });

  it("keys off the DATA, not the year — the fixture is 2024 either way", () => {
    expect(replay.meta.year).toBe(noDrsReplay.meta.year);
    renderHud(noDrsReplay, snapshot({ drs: undefined }));
    expect(screen.queryByText(/^DRS (OPEN|CLOSED)$/)).toBeNull();
  });
});

describe("Hud speed trace", () => {
  /** The fixture's lap repeated six times: 3510 samples, 351 s — a long open window. */
  const longReplay: Replay = (() => {
    const raw = JSON.parse(JSON.stringify(sampleLap));
    const one = raw.cars[0].samples;
    const many = Array.from({ length: 6 }, () => one)
      .flat()
      .map((s: { t: number }, k: number) => ({
        ...s,
        t: k / raw.meta.sampleRateHz,
      }));
    raw.cars[0].samples = many;
    raw.meta.duration = many.length / raw.meta.sampleRateHz;
    raw.meta.loop = "open";
    return parseReplay(raw, "long.json");
  })();

  /** The rendered curve's points, and where the playhead line sits. */
  function traceAt(target: Replay, clock: number) {
    telemetry.reset();
    telemetry.publish(1000, clock, [snapshot()]);
    const view = render(<Hud replay={target} />);
    const svg = screen.getByRole("img", { name: /Speed trace/ });
    const d = svg.querySelector("path")?.getAttribute("d") ?? "";
    const x1 = svg.querySelector("line")?.getAttribute("x1") ?? "";
    view.unmount();
    return { points: (d.match(/[ML]/g) ?? []).length, playheadX: x1 };
  }

  it("labels the trace with the focused car, the window and the speed range", () => {
    renderHud(replay);
    expect(
      screen.getByRole("img", {
        name: /Speed trace for VER, the last 20 seconds, 157 to 338 km\/h/,
      }),
    ).toBeInTheDocument();
  });

  it("draws a BOUNDED curve however deep into the window the clock runs", () => {
    // The defect, at the integration level: the old trace put one point per sample of
    // the whole replay into the DOM — 3510 of them here — so legibility died with
    // window length. Slice 9b's bound test, one component up.
    const early = traceAt(longReplay, 60);
    const deep = traceAt(longReplay, 340);
    expect(deep.points).toBe(early.points);
    expect(deep.points).toBeLessThanOrEqual(202);
    expect(longReplay.cars[0].samples.length).toBe(3510);
  });

  it("keeps the playhead FIXED while the history scrolls past it", () => {
    expect(traceAt(longReplay, 60).playheadX).toBe(
      traceAt(longReplay, 340).playheadX,
    );
  });

  it("still fills in from the line at the start, on the v1 fixture", () => {
    // Degradation the other way: a clock younger than the window has no history to
    // show yet, so the playhead sweeps rather than sitting at the edge.
    expect(traceAt(replay, 5).playheadX).not.toBe(
      traceAt(replay, 30).playheadX,
    );
    expect(traceAt(replay, 30).playheadX).toBe(traceAt(replay, 45).playheadX);
  });
});

describe("Hud accessibility", () => {
  it("does NOT announce live — 30 updates a second would flood a screen reader", () => {
    const { container } = renderHud(replay);
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});

/**
 * Signature coupling — the trap this closes.
 *
 * The channel suppresses an emit when its display signature is unchanged, so anything
 * the HUD renders must be part of that signature or the field silently freezes (most
 * visibly while paused, where nothing else forces a re-render).
 *
 * Rather than a hand-maintained list of "displayed fields" — which drifts exactly the
 * way the thing it guards drifts — this walks EVERY key of a `CarSnapshot` and asserts
 * the one-directional invariant:
 *
 *     perturbing a field changes what is RENDERED  =>  it changes the SIGNATURE
 *
 * A field newly surfaced in the readout is therefore covered without anyone updating
 * this test, and a snapshot field added with no perturbation defined fails loudly below
 * rather than being skipped.
 */
describe("HUD / signature coupling", () => {
  const base = snapshot({
    speed: 200,
    throttle: 50,
    brake: 0,
    gear: 5,
    drs: 8,
  });

  /** A visibly different value for each snapshot field. */
  const PERTURBATIONS: { [K in keyof CarSnapshot]-?: CarSnapshot[K] } = {
    index: 7,
    t: 9.5,
    x: 123,
    y: 456,
    heading: 1.5,
    speed: 301,
    throttle: 91,
    brake: 1,
    gear: 2,
    drs: 12, // 8 is closed, 12 is open
  };

  /**
   * What the HUD paints for a given snapshot.
   *
   * `innerHTML`, not `textContent`: throttle and brake render as bar widths and
   * `aria-valuenow` attributes with no text of their own, so a text-only comparison
   * silently omits them — which would have left two of the five displayed fields
   * uncovered by the invariant below.
   */
  function renderedMarkup(snap: CarSnapshot): string {
    telemetry.reset();
    telemetry.publish(1000, 12.4, [snap]);
    const view = render(<Hud replay={replay} />);
    const html = screen.getByLabelText("Telemetry").innerHTML;
    view.unmount();
    return html;
  }

  it("defines a perturbation for every field, so none are silently skipped", () => {
    expect(Object.keys(PERTURBATIONS).sort()).toEqual(Object.keys(base).sort());
  });

  it.each(Object.keys(PERTURBATIONS) as (keyof CarSnapshot)[])(
    "keeps the signature coupled to what is rendered: %s",
    (field) => {
      const changed = { ...base, [field]: PERTURBATIONS[field] } as CarSnapshot;

      const renderedBefore = renderedMarkup(base);
      const renderedAfter = renderedMarkup(changed);
      const sigBefore = displaySignature(12.4, [base]);
      const sigAfter = displaySignature(12.4, [changed]);

      if (renderedBefore !== renderedAfter) {
        expect(
          sigAfter,
          `\`${field}\` changes what the HUD renders but NOT the display signature. ` +
            `The channel will suppress the emit that would update it and the field ` +
            `will freeze. Add it to \`displaySignature\` in telemetry/channel.ts.`,
        ).not.toBe(sigBefore);
      }
      // The converse is deliberately NOT asserted: a signature may legitimately track
      // more than the HUD shows (another consumer may render it).
    },
  );

  it("actually exercises the invariant — some fields DO change the render", () => {
    // Guards against the whole suite above passing vacuously because nothing rendered.
    const changing = (
      Object.keys(PERTURBATIONS) as (keyof CarSnapshot)[]
    ).filter(
      (f) =>
        renderedMarkup(base) !==
        renderedMarkup({ ...base, [f]: PERTURBATIONS[f] } as CarSnapshot),
    );
    expect(changing.sort()).toEqual([
      "brake",
      "drs",
      "gear",
      "speed",
      "throttle",
    ]);
  });
});

/**
 * The tower — running order, gaps, and selection.
 *
 * SINCE SLICE 9d A GAP IS A FUNCTION OF THE REPLAY AND THE CLOCK, not of the published
 * snapshot. `gaps.ts` reads each car's precomputed progress around a shared circuit, so
 * these tests set up the DATA rather than injecting a position into a frame. In
 * production the two agree by construction — the snapshot IS `sampleAt(replay, clock)`,
 * published with that same clock — but a test can no longer move one without the other,
 * and should not be able to.
 *
 * The second car is the fixture's own lap shifted by exactly 20 samples, so at 10 Hz it
 * is 2.000 s AHEAD of the first at every clock: the expected gaps are exact by
 * construction rather than by tolerance.
 */
const laps = replay.cars[0].samples;

/** How far ahead the second car runs, in samples. 20 at 10 Hz is exactly 2 s. */
const SHIFT = 20;

function shiftedTwoCarReplay(displaceX = 0): Replay {
  const raw = JSON.parse(JSON.stringify(sampleLap));
  const n = raw.cars[0].samples.length;
  raw.cars.push({
    ...raw.cars[0],
    driver: "SEC",
    team: "Second Team",
    color: "#ff8000",
    // Rotated, not invented: every car must span `meta.duration` on the same grid.
    samples: raw.cars[0].samples.map((s: { t: number }, k: number) => ({
      ...raw.cars[0].samples[(k + SHIFT) % n],
      x: raw.cars[0].samples[(k + SHIFT) % n].x + displaceX,
      t: s.t,
    })),
  });
  return parseReplay(raw, "two-cars.json");
}

const twoCarReplay: Replay = shiftedTwoCarReplay();
/** The same pair, with the second car parked a long way off the circuit. */
const offPathReplay: Replay = shiftedTwoCarReplay(1e6);

/** A snapshot sitting exactly where the focused car was at sample `k`. */
const atSample = (k: number, over: Partial<CarSnapshot> = {}): CarSnapshot =>
  snapshot({ x: laps[k].x, y: laps[k].y, ...over });

/** Publish two cars at `clock` and render the tower. */
function renderTower(
  clock: number,
  second: CarSnapshot,
  target: Replay = twoCarReplay,
) {
  telemetry.publish(1000, clock, [snapshot(), second]);
  return render(<Hud replay={target} />);
}

describe("Hud timing tower", () => {
  beforeEach(() => useTransport.setState({ focusedCarIndex: 0 }));

  it("shows a row per car, naming the team on the focused one", () => {
    // The team name goes where there is width for it. A compact row identifies its
    // team by the colour swatch instead — at the sidebar's real width, "Red Bull
    // Racing" truncates to "R…", which is worse than not showing it.
    renderTower(4, atSample(20));
    expect(screen.getByRole("button", { name: /VER/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SEC/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Demo/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Second Team/ })).toBeNull();
  });

  it("gives the focused car the full readout and the others a gap", () => {
    renderTower(4, atSample(20));
    // One speed readout, not two: the tower is compact for everyone else.
    expect(screen.getAllByRole("meter", { name: "Throttle" })).toHaveLength(1);
    // SEC runs 20 samples up the road, so it is 2 s AHEAD of the focused car.
    expect(screen.getByText("-2.000")).toBeInTheDocument();
  });

  it("reads a car behind as + and a car ahead as -", () => {
    // The same pair from the other end: focus the car up the road and the first car
    // is two seconds behind it. Both signs off one construction, so a sign flip in
    // `gapTo` cannot pass by being symmetric.
    renderTower(4, atSample(60));
    expect(screen.getByText("-2.000")).toBeInTheDocument();

    cleanup();
    useTransport.setState({ focusedCarIndex: 1 });
    renderTower(4, atSample(60));
    expect(screen.getByText("+2.000")).toBeInTheDocument();
  });

  it("shows the ground between them as well as the time", () => {
    const { container } = renderTower(4, atSample(20));
    expect(container.textContent).toMatch(/\d+ m/);
  });

  it("renders an em dash, not a zero, when the gap has no answer", () => {
    // Nowhere near the circuit — a pit lane, a spin, or a car in its garage.
    renderTower(4, atSample(20), offPathReplay);
    // Both columns go blank together: there is one answer, and it is "no answer".
    expect(screen.getAllByText(NO_VALUE)).toHaveLength(2);
  });

  it("puts the car ahead above the car behind", () => {
    // SEC is second in `cars[]` and first on the road, so this fails for any ordering
    // that quietly falls back to source order.
    renderTower(4, atSample(60));
    const rows = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(rows[0]).toMatch(/SEC/);
    expect(rows[1]).toMatch(/VER/);
  });

  it("marks exactly one row as pressed, and moves it on a click", () => {
    renderTower(4, atSample(20));
    expect(screen.getByRole("button", { name: /VER/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /SEC/ }));

    expect(useTransport.getState().focusedCarIndex).toBe(1);
    expect(screen.getByRole("button", { name: /SEC/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /VER/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("moves the speed trace to the newly focused car", () => {
    renderTower(4, atSample(20));
    fireEvent.click(screen.getByRole("button", { name: /SEC/ }));
    expect(
      screen.getByRole("img", { name: /Speed trace for SEC/ }),
    ).toBeInTheDocument();
  });

  it("keeps the running order when the focus changes", () => {
    // Gaps all shift by the same constant when the reference car changes, so track
    // order is focus-independent. Rows move at overtakes and at nothing else.
    renderTower(4, atSample(60));
    const before = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "");
    fireEvent.click(screen.getByRole("button", { name: /SEC/ }));
    const after = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(after.map((t) => t.slice(0, 3))).toEqual(
      before.map((t) => t.slice(0, 3)),
    );
  });
});

/**
 * The signature trap, on what the tower is actually a function of.
 *
 * `displaySignature` decides when the channel emits, so anything the HUD DRAWS has to be
 * in it or the channel will suppress the emit that would update it. Slice 9 aimed this
 * at the unfocused car's POSITION, because a row was a function of where that car was.
 *
 * **Slice 9d moved the target, and the test moved with it.** A gap now comes from the
 * replay's precomputed progress and the CLOCK; the published position does not enter it.
 * So the coupling that matters is the clock's (it moves every row) and the focused car's
 * channels (they move the readout). Perturbing an unfocused car's snapshot now correctly
 * changes nothing, and a test still asserting that it does would be asserting a defect.
 */
describe("HUD / signature coupling — the tower", () => {
  beforeEach(() => useTransport.setState({ focusedCarIndex: 0 }));

  const base = snapshot();
  const second = atSample(20);

  const PERTURBATIONS: { [K in keyof CarSnapshot]-?: CarSnapshot[K] } = {
    index: 7,
    t: 9.5,
    x: laps[60].x,
    y: laps[60].y,
    heading: 1.5,
    speed: 301,
    throttle: 91,
    brake: 1,
    gear: 2,
    drs: 12,
  };

  function renderedTower(focused: CarSnapshot, clock = 4): string {
    telemetry.reset();
    telemetry.publish(1000, clock, [focused, second]);
    const view = render(<Hud replay={twoCarReplay} />);
    const html = screen.getByLabelText("Telemetry").innerHTML;
    view.unmount();
    return html;
  }

  it.each(Object.keys(PERTURBATIONS) as (keyof CarSnapshot)[])(
    "keeps the signature coupled to the tower: %s",
    (field) => {
      const changed = { ...base, [field]: PERTURBATIONS[field] } as CarSnapshot;
      if (renderedTower(base) === renderedTower(changed)) return;

      expect(
        displaySignature(4, [changed, second]),
        `\`${field}\` changes the tower but NOT the display signature, so the ` +
          `channel will suppress the emit that would update it.`,
      ).not.toBe(displaySignature(4, [base, second]));
    },
  );

  it("actually exercises the invariant — the focused car's channels move the tower", () => {
    const changing = (
      Object.keys(PERTURBATIONS) as (keyof CarSnapshot)[]
    ).filter(
      (f) =>
        renderedTower(base) !==
        renderedTower({ ...base, [f]: PERTURBATIONS[f] } as CarSnapshot),
    );
    // Everything the focused readout draws, and nothing else. `index`, `t`, `x`, `y`
    // and `heading` are the canvas's business — the tower does not render them, and
    // since 9d it does not compute gaps from them either.
    expect(changing.sort()).toEqual([
      "brake",
      "drs",
      "gear",
      "speed",
      "throttle",
    ]);
  });

  it("moves every gap when the CLOCK moves, which is what 9d made the tower ride on", () => {
    // The complement of the test above, and the one that would catch a signature that
    // dropped the clock: with every snapshot field held fixed, advancing the clock alone
    // must still redraw the tower AND change the signature.
    expect(renderedTower(base, 4)).not.toBe(renderedTower(base, 6));
    expect(displaySignature(4, [base, second])).not.toBe(
      displaySignature(6, [base, second]),
    );
  });
});

describe("Hud across a replay swap", () => {
  beforeEach(() => useTransport.setState({ focusedCarIndex: 0 }));

  it("survives a frame that still describes the previous replay", () => {
    // Loading a replay swaps `replay` immediately, but the last frame the render
    // loop published still holds the old replay's cars for up to 16 ms. Read against
    // the new one it indexes past the end of `cars`, which took the whole app down
    // with a white screen — reached in about a second by loading a one-car lap after
    // a three-car window, and present before the tower existed too.
    telemetry.publish(1000, 4, [snapshot(), atSample(20)]);
    expect(() => render(<Hud replay={replay} />)).not.toThrow();
    // Nothing car-shaped until a consistent frame lands — the same state as before
    // the first publish, rather than half a tower.
    expect(screen.queryByRole("meter", { name: "Throttle" })).toBeNull();
  });

  it("renders again as soon as a frame for the new replay arrives", () => {
    telemetry.publish(1000, 4, [snapshot(), atSample(20)]);
    const view = render(<Hud replay={replay} />);
    view.unmount();

    telemetry.publish(2000, 4, [snapshot()]);
    render(<Hud replay={replay} />);
    expect(screen.getByRole("meter", { name: "Throttle" })).toBeInTheDocument();
  });
});
