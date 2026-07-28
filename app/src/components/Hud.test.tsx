/**
 * HUD tests — the values, and the DRS indicator in BOTH states.
 *
 * Rule 8 says the indicator exists only when the data carries a DRS channel. The
 * committed fixture HAS one, so the absent case needs a `drs`-stripped clone — testing
 * only the rendered state would leave the branch that matters for 2026+ replays
 * completely uncovered.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { CarSnapshot } from "../engine/interpolate";
import type { Replay } from "../engine/schema";
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
