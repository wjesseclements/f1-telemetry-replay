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
  it("labels the trace with the focused car and its speed range", () => {
    renderHud(replay);
    expect(
      screen.getByRole("img", { name: /Speed trace for VER/ }),
    ).toBeInTheDocument();
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
 * The fixture's own samples are the query points, so the expected gaps are exact: a
 * car sitting where the focused car was at t=2 is 2 s behind at t=4, by construction
 * rather than by tolerance.
 */
const laps = replay.cars[0].samples;

/** The fixture's lap driven by two cars, so gaps have someone to be measured against. */
const twoCarReplay: Replay = (() => {
  const raw = JSON.parse(JSON.stringify(sampleLap));
  const n = raw.cars[0].samples.length;
  const shift = Math.floor(n / 3);
  raw.cars.push({
    ...raw.cars[0],
    driver: "SEC",
    team: "Second Team",
    color: "#ff8000",
    // Rotated, not invented: every car must span `meta.duration` on the same grid.
    samples: raw.cars[0].samples.map((s: { t: number }, k: number) => ({
      ...raw.cars[0].samples[(k + shift) % n],
      t: s.t,
    })),
  });
  return parseReplay(raw, "two-cars.json");
})();

/** A snapshot sitting exactly where the focused car was at sample `k`. */
const atSample = (k: number, over: Partial<CarSnapshot> = {}): CarSnapshot =>
  snapshot({ x: laps[k].x, y: laps[k].y, ...over });

/** Publish two cars at `clock` and render the tower. */
function renderTower(clock: number, second: CarSnapshot) {
  telemetry.publish(1000, clock, [snapshot(), second]);
  return render(<Hud replay={twoCarReplay} />);
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
    expect(screen.getByText("+2.000")).toBeInTheDocument();
  });

  it("reads a car behind as + and a car ahead as -", () => {
    // Sitting where the focused car WILL be at t=6, at t=4: two seconds up the road.
    renderTower(4, atSample(60));
    expect(screen.getByText("-2.000")).toBeInTheDocument();
  });

  it("shows the ground between them as well as the time", () => {
    const { container } = renderTower(4, atSample(20));
    expect(container.textContent).toMatch(/\d+ m/);
  });

  it("renders an em dash, not a zero, when the gap has no answer", () => {
    // Nowhere near the focused car's path — a pit lane, a spin, or the window's edge.
    renderTower(4, snapshot({ x: 1e6, y: 1e6 }));
    // Both columns go blank together: there is one answer, and it is "no answer".
    expect(screen.getAllByText(NO_VALUE)).toHaveLength(2);
  });

  it("puts the car ahead above the car behind", () => {
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
 * The signature trap, on the car whose gap is actually rendered.
 *
 * The single-car suite above cannot see this: a lone car is focused, and a focused
 * row shows no gap, so no perturbation of its POSITION can change what is drawn. The
 * coupling that matters for the tower is the unfocused car's — its row is a function
 * of where it is, and if `x`/`y` were missing from the signature the channel could
 * suppress the emit that moves it.
 */
describe("HUD / signature coupling — the tower", () => {
  beforeEach(() => useTransport.setState({ focusedCarIndex: 0 }));

  const focusedCar = snapshot();
  const base = atSample(20);

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

  function renderedTower(second: CarSnapshot): string {
    telemetry.reset();
    telemetry.publish(1000, 4, [focusedCar, second]);
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
        displaySignature(4, [focusedCar, changed]),
        `\`${field}\` changes the tower but NOT the display signature, so the ` +
          `channel will suppress the emit that would update it.`,
      ).not.toBe(displaySignature(4, [focusedCar, base]));
    },
  );

  it("actually exercises the invariant — position DOES move the tower", () => {
    const changing = (
      Object.keys(PERTURBATIONS) as (keyof CarSnapshot)[]
    ).filter(
      (f) =>
        renderedTower(base) !==
        renderedTower({ ...base, [f]: PERTURBATIONS[f] } as CarSnapshot),
    );
    // Only position: an unfocused row shows a gap and nothing else, so speed, gear
    // and the pedals are invisible until that car is focused.
    expect(changing.sort()).toEqual(["x", "y"]);
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
