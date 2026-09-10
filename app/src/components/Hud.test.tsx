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
import { GAP_DNF, GAP_NO_SIGNAL, GAP_PIT, NO_VALUE } from "../engine/format";
import { SWATCH_MIN_LUMINANCE, floorLuminance } from "../engine/color";
import {
  COMPARISON_MIN_LUMINANCE,
  COMPARISON_STROKE_WIDTH,
} from "../engine/trace";
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

describe("Hud tyre indicators (Slice 14, rule 8 shape)", () => {
  /** The fixture carrying a lap table and one stint — clock 12.4 sits in lap 48. */
  const tyreReplay = (
    compound = "SOFT",
    ageAtStart: number | null = 12, // null = "age unknown": the field is omitted
  ): Replay => {
    const raw = JSON.parse(JSON.stringify(sampleLap));
    raw.cars[0].laps = [{ number: 48, startT: 0 }];
    raw.cars[0].stints = [
      ageAtStart === null
        ? { compound, fromLap: 48, toLap: 48 }
        : { compound, fromLap: 48, toLap: 48, ageAtStart },
    ];
    return parseReplay(raw, "tyres.json");
  };

  it("renders the compound dot with an ACCESSIBLE NAME, not colour alone", () => {
    const { container } = renderHud(tyreReplay());
    // The sr-only text is the information; the coloured dot is a mark.
    expect(screen.getByText("SOFT tyres")).toBeInTheDocument();
    expect(container.querySelector(".bg-tyre-soft")).not.toBeNull();
  });

  it("maps every compound to ITS colour class — an inverted map fails here", () => {
    const expected: Record<string, string> = {
      SOFT: "bg-tyre-soft",
      MEDIUM: "bg-tyre-medium",
      HARD: "bg-tyre-hard",
      INTERMEDIATE: "bg-tyre-inter",
      WET: "bg-tyre-wet",
      UNKNOWN: "bg-dim",
    };
    for (const [compound, cls] of Object.entries(expected)) {
      cleanup();
      telemetry.reset();
      const { container } = renderHud(tyreReplay(compound));
      expect(container.querySelector(`.${cls}`), compound).not.toBeNull();
      // ...and none of the OTHER compound colours leak in.
      for (const other of Object.values(expected)) {
        if (other !== cls && other !== "bg-dim") {
          expect(
            container.querySelector(`.${other}`),
            `${compound} shows ${other}`,
          ).toBeNull();
        }
      }
    }
  });

  it("shows the focused chip with the letter and the set's age", () => {
    renderHud(tyreReplay("SOFT", 12));
    expect(screen.getByText("S")).toBeInTheDocument();
    expect(screen.getByText(/12 laps/)).toBeInTheDocument();
  });

  it("omits the age (never zeroes it) when the starting age is unknown", () => {
    renderHud(tyreReplay("HARD", null));
    expect(screen.getByText("H")).toBeInTheDocument();
    expect(screen.queryByText(/laps/)).toBeNull();
    expect(screen.queryByText(/^0/)).toBeNull();
  });

  it("renders NO tyre marks at all for a replay without tyre data", () => {
    // Every pre-Slice-14 file. Not a grey dot — nothing.
    const { container } = renderHud(replay);
    expect(container.querySelector('[class*="tyre-"]')).toBeNull();
    expect(screen.queryByText(/tyres/)).toBeNull();
  });

  it("keys off the DATA, not the year — same fixture year either way", () => {
    expect(tyreReplay().meta.year).toBe(replay.meta.year);
    renderHud(replay);
    expect(screen.queryByText(/tyres/)).toBeNull();
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

/**
 * The tower's ROW buttons, without the per-row compare buttons (Slice 15): a row
 * carries the arrow-key shortcut hint, a compare button does not. Name-anchored
 * queries (`/^SEC/`) do the same job one row at a time — "vs SEC" contains the
 * driver code but does not start with it.
 */
function rowButtons() {
  return screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-keyshortcuts"));
}

describe("Hud timing tower", () => {
  beforeEach(() =>
    useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null }),
  );

  it("shows a row per car, naming the team on the focused one", () => {
    // The team name goes where there is width for it. A compact row identifies its
    // team by the colour swatch instead — at the sidebar's real width, "Red Bull
    // Racing" truncates to "R…", which is worse than not showing it.
    renderTower(4, atSample(20));
    expect(screen.getByRole("button", { name: /^VER/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^SEC/ })).toBeInTheDocument();
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

  it("labels a car off the line PIT — one word where the two gap columns were", () => {
    // Nowhere near the circuit — a pit lane, a spin, or a car in its garage. The
    // copy ruling's PIT label (see GAP_PIT's caveat) replaces the seconds AND the
    // metres columns: one label, not a label beside a dash, and never a zero.
    renderTower(4, atSample(20), offPathReplay);
    expect(screen.getByText(GAP_PIT)).toBeInTheDocument();
    expect(screen.queryByText(NO_VALUE)).toBeNull();
    expect(screen.queryByText(/[+-]\d/)).toBeNull();
  });

  it("puts the car ahead above the car behind", () => {
    // SEC is second in `cars[]` and first on the road, so this fails for any ordering
    // that quietly falls back to source order.
    renderTower(4, atSample(60));
    const rows = rowButtons().map((b) => b.textContent ?? "");
    expect(rows[0]).toMatch(/SEC/);
    expect(rows[1]).toMatch(/VER/);
  });

  it("marks exactly one row as pressed, and moves it on a click", () => {
    renderTower(4, atSample(20));
    expect(screen.getByRole("button", { name: /^VER/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: /^SEC/ }));

    expect(useTransport.getState().focusedCarIndex).toBe(1);
    expect(screen.getByRole("button", { name: /^SEC/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^VER/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("moves the speed trace to the newly focused car", () => {
    renderTower(4, atSample(20));
    fireEvent.click(screen.getByRole("button", { name: /^SEC/ }));
    expect(
      screen.getByRole("img", { name: /Speed trace for SEC/ }),
    ).toBeInTheDocument();
  });

  it("keeps the running order when the focus changes", () => {
    // Gaps all shift by the same constant when the reference car changes, so track
    // order is focus-independent. Rows move at overtakes and at nothing else.
    renderTower(4, atSample(60));
    const before = rowButtons().map((b) => b.textContent ?? "");
    fireEvent.click(screen.getByRole("button", { name: /^SEC/ }));
    const after = rowButtons().map((b) => b.textContent ?? "");
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
  beforeEach(() =>
    useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null }),
  );

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
  beforeEach(() =>
    useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null }),
  );

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

/**
 * The comparison overlay (Slice 15) — a second car's speed on the focused car's trace.
 *
 * The overlay is a function of (replay, clock, comparisonCarIndex): its identity is
 * store state that re-renders the HUD when it changes, its curve rides the clock the
 * signature already carries, so — like gaps and tyres — it adds NOTHING to
 * `displaySignature`. What these tests pin is the control's presence rules, the shared
 * axis, and keep-and-suppress across focus changes.
 */
describe("Hud speed-trace comparison", () => {
  beforeEach(() =>
    useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null }),
  );

  /** SEC's speeds halved, so the union axis differs from either car's own range. */
  const scaledReplay: Replay = (() => {
    const raw = JSON.parse(JSON.stringify(sampleLap));
    raw.cars.push({
      ...raw.cars[0],
      driver: "SEC",
      team: "Second Team",
      color: "#ff8000",
      samples: raw.cars[0].samples.map((s: { speed: number }) => ({
        ...s,
        speed: s.speed / 2,
      })),
    });
    return parseReplay(raw, "scaled.json");
  })();

  /** The two-car pair plus a third, so focus can move WITHOUT landing on the pair. */
  const threeCarReplay: Replay = (() => {
    const raw = JSON.parse(JSON.stringify(sampleLap));
    const n = raw.cars[0].samples.length;
    for (const [driver, color, shift] of [
      ["SEC", "#ff8000", SHIFT],
      ["TRD", "#00c000", SHIFT * 2],
    ] as const) {
      raw.cars.push({
        ...raw.cars[0],
        driver,
        color,
        samples: raw.cars[0].samples.map((s: { t: number }, k: number) => ({
          ...raw.cars[0].samples[(k + shift) % n],
          t: s.t,
        })),
      });
    }
    return parseReplay(raw, "three-cars.json");
  })();

  /** The trace SVG's curves: [comparison, focused] when comparing, [focused] alone. */
  function tracePaths() {
    const svg = screen.getByRole("img", { name: /Speed trace/ });
    return [...svg.querySelectorAll("path")];
  }

  it("offers a compare control on every row but the focused one", () => {
    renderTower(4, atSample(20));
    const vs = screen.getByRole("button", { name: "vs SEC" });
    expect(vs).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: "vs VER" })).toBeNull();
  });

  it("shows NO compare control on a single-car replay — nothing to compare", () => {
    // Not a count branch: the one row is always the focused row, which never has one.
    renderHud(replay);
    expect(screen.queryByRole("button", { name: /^vs / })).toBeNull();
  });

  it("overlays the compared car dashed, in its colour, under the focused line", () => {
    renderTower(4, atSample(20));
    expect(tracePaths()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));

    expect(useTransport.getState().comparisonCarIndex).toBe(1);
    const [overlay, focused] = tracePaths();
    expect(tracePaths()).toHaveLength(2);
    // The overlay: SEC's team colour (bright enough to pass the luminance floor
    // untouched), fully opaque at the tunable width, dashed — the dash being the
    // channel that survives colour-blindness.
    expect(overlay.getAttribute("stroke")).toBe("#ff8000");
    expect(overlay.getAttribute("stroke-width")).toBe(
      String(COMPARISON_STROKE_WIDTH),
    );
    expect(overlay.getAttribute("stroke-opacity")).toBeNull();
    expect(overlay.getAttribute("stroke-dasharray")).toBe("3 2");
    expect(overlay.getAttribute("d")).not.toBe("");
    // The focused line is untouched by the overlay's arrival.
    expect(focused.getAttribute("stroke")).toBe("var(--c-dim)");
    expect(focused.getAttribute("stroke-width")).toBe("1");
    expect(screen.getByRole("button", { name: "vs SEC" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("floors a dark team colour to the trace's minimum luminance — the browser-pass fix", () => {
    // Red Bull's navy (#3671C6, luminance ≈ 0.17) vanished on --c-bg; the overlay
    // must stroke the LIFTED colour, and the legend swatch must agree with the line.
    const darkReplay: Replay = (() => {
      const raw = JSON.parse(JSON.stringify(sampleLap));
      const n = raw.cars[0].samples.length;
      raw.cars.push({
        ...raw.cars[0],
        driver: "SEC",
        team: "Second Team",
        color: "#3671C6",
        samples: raw.cars[0].samples.map((s: { t: number }, k: number) => ({
          ...raw.cars[0].samples[(k + SHIFT) % n],
          t: s.t,
        })),
      });
      return parseReplay(raw, "dark.json");
    })();
    const lifted = floorLuminance("#3671C6", COMPARISON_MIN_LUMINANCE);
    expect(lifted).not.toBe("#3671C6"); // the fixture really exercises the floor

    renderTower(4, atSample(20), darkReplay);
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));

    const [overlay] = tracePaths();
    expect(overlay.getAttribute("stroke")).toBe(lifted);
    const legendLines = screen
      .getByRole("img", { name: /compared with SEC/ })
      .closest("figure")
      ?.querySelectorAll("svg[aria-hidden] line");
    expect(legendLines).toHaveLength(2);
    expect(legendLines?.[1].getAttribute("stroke")).toBe(lifted);
  });

  it("labels the pair and shows a legend naming both drivers in text", () => {
    renderTower(4, atSample(20));
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));
    const svg = screen.getByRole("img", {
      name: /Speed trace for VER compared with SEC, the last 20 seconds/,
    });
    // The legend binds line style to driver code in TEXT, inside the figure — a
    // colour-blind viewer maps dashed→SEC without reading a hue.
    const figure = svg.closest("figure");
    expect(figure?.textContent).toMatch(/VER/);
    expect(figure?.textContent).toMatch(/SEC/);
  });

  it("hides the legend when nothing is compared — the plain trace is unchanged", () => {
    renderTower(4, atSample(20));
    const figure = screen
      .getByRole("img", { name: /Speed trace/ })
      .closest("figure");
    expect(figure?.textContent).not.toMatch(/SEC/);
    expect(tracePaths()).toHaveLength(1);
    expect(tracePaths()[0].getAttribute("stroke")).toBe("var(--c-dim)");
  });

  it("draws BOTH lines to one union axis, so equal heights mean equal speeds", () => {
    // SEC's speeds are the fixture's halved: own ranges 157–338 and 78.5–169, so a
    // per-car axis would show two similar curves. The label carries the union.
    renderTower(4, atSample(20), scaledReplay);
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));
    expect(
      screen.getByRole("img", {
        name: /Speed trace for VER compared with SEC, the last 20 seconds, 78.5 to 338 km\/h/,
      }),
    ).toBeInTheDocument();
  });

  it("clears on a second press of the same control", () => {
    renderTower(4, atSample(20));
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));
    expect(useTransport.getState().comparisonCarIndex).toBeNull();
    expect(tracePaths()).toHaveLength(1);
  });

  it("suppresses, keeps, and restores across focus landing on the compared car", () => {
    // Keep-and-suppress: focusing the compared car does not mutate the choice — the
    // overlay is simply meaningless (self-comparison) until focus moves off again.
    renderTower(4, atSample(20));
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));

    fireEvent.click(screen.getByRole("button", { name: /^SEC/ }));
    expect(useTransport.getState().comparisonCarIndex).toBe(1);
    expect(tracePaths()).toHaveLength(1);
    expect(
      screen.getByRole("img", { name: /Speed trace for SEC, the last/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^VER/ }));
    expect(tracePaths()).toHaveLength(2);
    expect(
      screen.getByRole("img", {
        name: /Speed trace for VER compared with SEC/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the comparison across an ordinary focus change", () => {
    telemetry.publish(1000, 4, [snapshot(), atSample(20), atSample(40)]);
    render(<Hud replay={threeCarReplay} />);
    fireEvent.click(screen.getByRole("button", { name: "vs SEC" }));

    fireEvent.click(screen.getByRole("button", { name: /^TRD/ }));
    expect(useTransport.getState().comparisonCarIndex).toBe(1);
    expect(
      screen.getByRole("img", {
        name: /Speed trace for TRD compared with SEC/,
      }),
    ).toBeInTheDocument();
  });
});

describe("Hud swatch luminance floor (Slice 17)", () => {
  it("lifts a livery too dark for the panel — Cadillac's #444444 — and passes bright ones verbatim", () => {
    const raw = JSON.parse(JSON.stringify(sampleLap));
    raw.cars.push({
      ...raw.cars[0],
      driver: "CAD",
      team: "Cadillac",
      color: "#444444",
    });
    const dark = parseReplay(raw, "dark-swatch.json");
    useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null });
    telemetry.reset();
    telemetry.publish(1000, 0, [snapshot(), snapshot()]);
    const { container } = render(<Hud replay={dark} />);

    const swatches = Array.from(
      container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]'),
    ).filter((el) => el.style.backgroundColor !== "");
    expect(swatches.length).toBeGreaterThanOrEqual(2);

    const floored = floorLuminance("#444444", SWATCH_MIN_LUMINANCE);
    expect(floored).not.toBe("#444444"); // the fixture colour genuinely needs the lift
    const colors = swatches.map((el) => el.style.backgroundColor);
    // jsdom normalises hex to rgb(); compare through the same normalisation.
    const toRgb = (hex: string) => {
      const el = document.createElement("span");
      el.style.backgroundColor = hex;
      return el.style.backgroundColor;
    };
    expect(colors).toContain(toRgb(floored));
    expect(colors).not.toContain(toRgb("#444444"));
  });
});

/**
 * Slice 19 — retired, stopped and pit-lane semantics, at the exhibit level.
 *
 * Each recorded exhibit is rebuilt here as the smallest replay that reproduces it, in
 * the analytic-ring style of `carState.test.ts`: a 1000 m circle at 180 km/h, so
 * states and gaps are exact by construction. The BEFORE numbers (a parked focused car
 * "leading" everyone; pit-lane starters on P1/P2; RUS −52.8 s from a stationary ANT)
 * are recorded in the slice's PLAN entry, measured on the shipped assets through the
 * unmodified engine; these tests pin the AFTER.
 */
describe("Hud tower states (Slice 19)", () => {
  const RATE = 10;
  const PER_LAP = 200;

  function ringSamples(shift = 0, radiusBoost = 0) {
    const radius = 1000 / (2 * Math.PI) + radiusBoost;
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
    dropouts?: { fromT: number; toT: number }[];
  };

  function stateReplay(...cars: RawCar[]): Replay {
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
      "slice19.json",
    );
  }

  function renderStates(target: Replay, clock: number) {
    telemetry.publish(
      1000,
      clock,
      target.cars.map((_, index) => ({ ...snapshot(), index })),
    );
    return render(<Hud replay={target} />);
  }

  const rows = () =>
    screen
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-keyshortcuts"));

  beforeEach(() =>
    useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null }),
  );

  it("sends a retired car to the bottom, greyed, saying OUT — while the others keep numbers", () => {
    // GON retires at t=10 while running 2 s AHEAD: without the state he would sit on
    // P1 with a confident number for the rest of the window.
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      { driver: "GON", samples: ringSamples(20), retiredAt: 10 },
      { driver: "RUN", samples: ringSamples(-10) },
    );
    renderStates(replay, 30);

    const order = rows().map((b) => b.textContent ?? "");
    expect(order[0]).toMatch(/FOC/);
    expect(order[1]).toMatch(/RUN/);
    expect(order[2]).toMatch(/GON/);
    expect(order[2]).toContain(GAP_DNF);
    // RUN, 1 s behind the focus, keeps its number: one car's retirement is not
    // everyone's blackout.
    expect(screen.getByText("+1.000")).toBeInTheDocument();
    // The broadcast grey, on the row button so the swatch desaturates with the text.
    const gone = screen.getByRole("button", { name: /^GON/ });
    expect(gone.className).toContain("grayscale");
    expect(
      screen.getByRole("button", { name: /^FOC/ }).className,
    ).not.toContain("grayscale");
  });

  it("keeps a retired car focusable, and blanks every number while it IS the focus — exhibit 1", () => {
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      { driver: "GON", samples: ringSamples(20), retiredAt: 10 },
      { driver: "RUN", samples: ringSamples(-10) },
    );
    useTransport.setState({ focusedCarIndex: 1 });
    renderStates(replay, 30);

    // The parked exhibit: LEC focused read as leading everyone by up to a lap. Now:
    // no number anywhere, OUT on the focused row, and the running order intact.
    expect(screen.queryByText(/^[+-]\d/)).toBeNull();
    expect(screen.getAllByText(GAP_DNF)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^GON/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const order = rows().map((b) => b.textContent ?? "");
    expect(order[0]).toMatch(/FOC/);
    expect(order[1]).toMatch(/RUN/);
    expect(order[2]).toMatch(/GON/);
  });

  it("un-retires on a rewind: before retiredAt the same car races with a number", () => {
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      { driver: "GON", samples: ringSamples(20), retiredAt: 10 },
    );
    renderStates(replay, 5);
    expect(screen.queryByText(GAP_DNF)).toBeNull();
    expect(screen.getByText("-2.000")).toBeInTheDocument();
  });

  it("sinks a pit-lane starter still in its box to the bottom with no number — exhibit 2", () => {
    // BOX sits 15 m off the line at speed 0 for 3 s and then drives its off-line lane
    // from where it parked — LAW and ALO's shape, deliberately NOT a never-moves car
    // (that was already handled as degenerate). Its box is 60 samples AHEAD of the
    // reference in the Monza pit-box band, so the old key put it on P1 with a
    // confident number.
    const exit = ringSamples(60, 15);
    const parkedBox = exit.map((s, k) => ({
      ...(k < 30 ? { ...exit[0], speed: 0 } : exit[k - 30]),
      t: s.t,
    }));
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      { driver: "BOX", samples: parkedBox },
      { driver: "RUN", samples: ringSamples(-10) },
    );
    renderStates(replay, 2);

    const order = rows().map((b) => b.textContent ?? "");
    expect(order[2]).toMatch(/BOX/);
    expect(order[2]).toContain(GAP_PIT);
    expect(order[2]).not.toMatch(/[+-]\d/);

    // Once it is rolling it has JOINED: the row sorts by progress again — its lane
    // runs ahead of the reference, so it holds P1 — but an off-line car still shows
    // no number, just the PIT label: a row is a position, a number is a claim.
    cleanup();
    telemetry.reset();
    renderStates(replay, 5);
    const later = rows().map((b) => b.textContent ?? "");
    expect(later[0]).toMatch(/BOX/);
    expect(later[0]).toContain(GAP_PIT);
    expect(later[0]).not.toMatch(/[+-]\d/);
  });

  it("shows NO SIGNAL — not a fabricated readout — for a focused car inside a dropout (Slice 9m)", () => {
    // FOC carries a bridged dropout over [4, 8). At t=6 its speed/pedals are
    // fabricated coasts, so the readout must say NO SIGNAL, not 243.6 km/h. The row's
    // gap column says NO SIGNAL too. Before and after the span the numbers are real.
    const replay = stateReplay(
      {
        driver: "FOC",
        samples: ringSamples(),
        dropouts: [{ fromT: 4, toT: 8 }],
      },
      { driver: "RUN", samples: ringSamples(-10) },
    );
    renderStates(replay, 6);
    // The 5xl speed readout is gone; NO SIGNAL stands in its place (readout + gap col).
    // The published snapshot's 243.6 km/h rounds to 244, which must NOT appear.
    expect(screen.queryByText("244")).toBeNull();
    expect(screen.getAllByText(GAP_NO_SIGNAL).length).toBeGreaterThanOrEqual(1);
    // The focused car quotes no gap to anyone while its own feed is out.
    expect(screen.queryByText(/^[+-]\d/)).toBeNull();

    // Rewind before the dropout: the real readout is back.
    cleanup();
    telemetry.reset();
    renderStates(replay, 2);
    expect(screen.queryByText(GAP_NO_SIGNAL)).toBeNull();
    expect(screen.getByText("244")).toBeInTheDocument();
  });

  it("labels a dropout NO SIGNAL, never PIT, even when the car is also off the line — 2a precedence", () => {
    // OFF rides 15 m off the reference line (off-line by residual) AND carries a
    // dropout over [4, 8). The pipeline-flagged dropout must win: NO SIGNAL, not the
    // PIT inference. FOC is focused so OFF renders its unfocused row label.
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      {
        driver: "OFF",
        samples: ringSamples(20, 15), // 15 m off the line, past the 10 m gate
        dropouts: [{ fromT: 4, toT: 8 }],
      },
    );
    renderStates(replay, 6);
    const offRow = rows().find((b) => /^OFF/.test(b.textContent ?? ""));
    expect(offRow?.textContent).toContain(GAP_NO_SIGNAL);
    expect(offRow?.textContent).not.toContain(GAP_PIT);

    // Outside the dropout the same offset reads PIT again — the label is state, not a
    // property of the car.
    cleanup();
    telemetry.reset();
    renderStates(replay, 12);
    const later = rows().find((b) => /^OFF/.test(b.textContent ?? ""));
    expect(later?.textContent).toContain(GAP_PIT);
    expect(later?.textContent).not.toContain(GAP_NO_SIGNAL);
  });

  it("shows a standing field as order without numbers until launch, then numbers — exhibit 3", () => {
    // All three cars below the floor for the first 15 s (a grid hold with quorum),
    // then racing. The BEFORE behaviour quoted RUS −52.8 s from a stationary ANT.
    const held = (shift: number) =>
      ringSamples(shift).map((s, k) => (k < 150 ? { ...s, speed: 0 } : s));
    const replay = stateReplay(
      { driver: "FOC", samples: held(0) },
      { driver: "AHD", samples: held(20) },
      { driver: "BHD", samples: held(-20) },
    );
    renderStates(replay, 5);

    // Grid order, no numbers anywhere.
    expect(screen.queryByText(/^[+-]\d/)).toBeNull();
    const order = rows().map((b) => b.textContent ?? "");
    expect(order[0]).toMatch(/AHD/);
    expect(order[1]).toMatch(/FOC/);
    expect(order[2]).toMatch(/BHD/);

    // After the launch, with the measurement no longer spanning the hold, the
    // numbers return at the true spacings.
    cleanup();
    telemetry.reset();
    renderStates(replay, 20);
    expect(screen.getByText("-2.000")).toBeInTheDocument();
    expect(screen.getByText("+2.000")).toBeInTheDocument();
  });

  it("lists a car retired BEFORE the window opened: grey, OUT, at the bottom, focusable — never dropped", () => {
    // retiredAt 0 is the pre-window retirement spelling: the car was already out
    // when the data begins. It must hold a row at every clock, not vanish.
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      { driver: "PRE", samples: ringSamples(20), retiredAt: 0 },
      { driver: "RUN", samples: ringSamples(-10) },
    );
    for (const clock of [0, 17]) {
      renderStates(replay, clock);
      const order = rows().map((b) => b.textContent ?? "");
      expect(order).toHaveLength(3);
      expect(order[2]).toMatch(/PRE/);
      expect(order[2]).toContain(GAP_DNF);
      const pre = screen.getByRole("button", { name: /^PRE/ });
      expect(pre.className).toContain("grayscale");
      fireEvent.click(pre);
      expect(pre).toHaveAttribute("aria-pressed", "true");
      cleanup();
      telemetry.reset();
      useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null });
    }
  });

  it("renders the speed trace INSIDE the focused row, under the readout — the ruled placement", () => {
    const replay = stateReplay(
      { driver: "FOC", samples: ringSamples() },
      { driver: "RUN", samples: ringSamples(-10) },
    );
    renderStates(replay, 5);
    const focusedRow = screen
      .getByRole("button", { name: /^FOC/ })
      .closest("li");
    expect(focusedRow).not.toBeNull();
    const trace = screen.getByRole("img", { name: /^Speed trace for FOC/ });
    expect(focusedRow).toContainElement(trace);
    // The readout (the dl with the pills) precedes it inside the same row.
    expect(focusedRow!.querySelector("dl")).not.toBeNull();
  });

  it("blanks even two MOVING cars while the field forms up — the launch rule, not the states", () => {
    // A fourth pair drives normally while three others hold the grid: with a moving
    // focus and a moving car, neither per-car state nor the focus rule blanks
    // anything — only the pre-launch rule can. This is the forming-up phase, where
    // the BEFORE tower showed plausible-looking numbers between cars driving to
    // their slots.
    const held = (shift: number) =>
      ringSamples(shift).map((s, k) => (k < 150 ? { ...s, speed: 0 } : s));
    const replay = stateReplay(
      { driver: "GRD", samples: held(0) },
      { driver: "GR2", samples: held(20) },
      { driver: "GR3", samples: held(-20) },
      { driver: "FOC", samples: ringSamples(-40) },
      { driver: "MOV", samples: ringSamples(-60) },
    );
    useTransport.setState({ focusedCarIndex: 3 });
    renderStates(replay, 5);
    expect(screen.queryByText(/^[+-]\d/)).toBeNull();

    // The same pair after the launch: the number is real again.
    cleanup();
    telemetry.reset();
    renderStates(replay, 20);
    expect(screen.getByText("+2.000")).toBeInTheDocument();
  });
});
