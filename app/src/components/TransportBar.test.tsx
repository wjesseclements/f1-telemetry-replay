/**
 * TransportBar tests — the lap indicator (Slice 14).
 *
 * The transport controls themselves are exercised through `App.test.tsx` and
 * `Scrubber.test.tsx`; this file pins the one thing new here: the leader-lap
 * readout, which must exist exactly when the data carries laps (the rule-8
 * shape) and must read the HIGHEST lap across cars, not any particular car's.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";
import { telemetry } from "../telemetry/channel";
import { COMPACT_FOCUS_RING } from "./focus";
import { TOUCH_TARGET } from "./touchTarget";
import { TransportBar } from "./TransportBar";

const bare = parseReplay(sampleLap, "sample-lap.json");

/** The fixture with per-car lap tables laid over its samples. */
function withLaps(...tables: { number: number; startT: number }[][]): Replay {
  const raw = JSON.parse(JSON.stringify(sampleLap));
  raw.cars = tables.map((laps, i) => ({
    ...JSON.parse(JSON.stringify(raw.cars[0])),
    driver: `C${i}`,
    laps,
  }));
  return parseReplay(raw, "laps.json");
}

/** Publish a clock and render — the only way the clock reaches the bar. */
function renderBar(replay: Replay, clock: number) {
  telemetry.publish(1000, clock, []);
  return render(<TransportBar replay={replay} />);
}

beforeEach(() => telemetry.reset());
afterEach(cleanup);

describe("TransportBar lap indicator", () => {
  it("shows the lap the clock is inside", () => {
    renderBar(
      withLaps([
        { number: 48, startT: 0 },
        { number: 49, startT: 30 },
      ]),
      12.4,
    );
    expect(screen.getByText("LAP 48")).toBeInTheDocument();
  });

  it("advances at a lap boundary", () => {
    renderBar(
      withLaps([
        { number: 48, startT: 0 },
        { number: 49, startT: 30 },
      ]),
      30,
    );
    expect(screen.getByText("LAP 49")).toBeInTheDocument();
  });

  it("reads the HIGHEST lap across cars — the leader's, whoever that is", () => {
    renderBar(
      withLaps([{ number: 48, startT: 0 }], [{ number: 50, startT: 10 }]),
      12.4,
    );
    expect(screen.getByText("LAP 50")).toBeInTheDocument();
  });

  it("renders NO indicator at all for a replay without lap data", () => {
    // Every pre-Slice-14 file: the bar renders exactly as it always did.
    renderBar(bare, 12.4);
    expect(screen.queryByText(/^LAP /)).toBeNull();
  });
});

/** The fixture with a trackStatus interval list laid over it (Slice 17). */
function withStatus(
  intervals: { status: string; fromT: number; toT: number }[],
): Replay {
  const raw = JSON.parse(JSON.stringify(sampleLap));
  raw.trackStatus = intervals;
  return parseReplay(raw, "status.json");
}

describe("TransportBar status flag", () => {
  it("shows the flag the clock is under, full name in the accessible text", () => {
    renderBar(
      withStatus([
        { status: "green", fromT: 0, toT: 30 },
        { status: "sc", fromT: 30, toT: 58.5 },
      ]),
      40,
    );
    expect(screen.getByText("SC")).toBeInTheDocument();
    expect(screen.getByText(/Track status: Safety Car/)).toBeInTheDocument();
    expect(screen.queryByText("GREEN")).not.toBeInTheDocument();
  });

  it("shows GREEN as data, not as decoration — a green board is a statement", () => {
    renderBar(withStatus([{ status: "green", fromT: 0, toT: 58.5 }]), 10);
    expect(screen.getByText("GREEN")).toBeInTheDocument();
  });

  it("shows RED at the red-flag clock", () => {
    renderBar(
      withStatus([
        { status: "sc", fromT: 0, toT: 40 },
        { status: "red", fromT: 40, toT: 58.5 },
      ]),
      50,
    );
    expect(screen.getByText("RED")).toBeInTheDocument();
    expect(screen.getByText(/Track status: Red flag/)).toBeInTheDocument();
  });

  it("renders NO chip at all for a replay without status data", () => {
    renderBar(bare, 10);
    expect(screen.queryByText(/Track status:/)).not.toBeInTheDocument();
  });

  it("renders no chip in a coverage gap and none for unknown — absence is not green", () => {
    const replay = withStatus([
      { status: "green", fromT: 0, toT: 10 },
      { status: "unknown", fromT: 20, toT: 30 },
    ]);
    const first = renderBar(replay, 15);
    expect(screen.queryByText(/Track status:/)).not.toBeInTheDocument();
    first.unmount();
    renderBar(replay, 25);
    expect(screen.queryByText(/Track status:/)).not.toBeInTheDocument();
  });

  it("tints the scrubber over abnormal stretches and leaves a bare replay's bar alone", () => {
    const tinted = renderBar(
      withStatus([
        { status: "green", fromT: 0, toT: 40 },
        { status: "red", fromT: 40, toT: 58.5 },
      ]),
      10,
    );
    const slider = screen.getByRole("slider", { name: "Lap position" });
    expect(slider.style.background).toContain("--c-flag-red");
    tinted.unmount();

    renderBar(bare, 10);
    const bareSlider = screen.getByRole("slider", { name: "Lap position" });
    expect(bareSlider.style.background).toBe("");
  });
});

describe("TransportBar on a short phone (Slice 27)", () => {
  // jsdom applies no media query, so these pin the `compact:` classes; the boxes
  // they make (44x44 and up, unobstructed, no two overlapping) are measured in a
  // real browser in Slice 27's PLAN entry.
  it("gives every button a 44 px target with its focus ring inside", () => {
    renderBar(bare, 10);
    const buttons = screen.getAllByRole("button");
    // Play/pause, restart and the four speeds: the bar's every button.
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^(Play|Pause)$/),
      "Restart lap",
      "0.5× speed",
      "1× speed",
      "2× speed",
      "4× speed",
    ]);
    for (const button of buttons) {
      expect(button).toHaveClass(...TOUCH_TARGET.split(" "));
      expect(button).toHaveClass(...COMPACT_FOCUS_RING.split(" "));
    }
  });

  it("makes the scrubber 44 px tall and keeps its painted track 4 px", () => {
    // The tint is clipped to the content box, so the 20 px of padding above and
    // below are hit area, not paint. The clip is an important `compact:` class,
    // because the tint's inline `background` shorthand resets the clip, and the
    // inline style stays exactly what it was so no other screen's pixels move.
    renderBar(
      withStatus([
        { status: "green", fromT: 0, toT: 40 },
        { status: "red", fromT: 40, toT: 58.5 },
      ]),
      10,
    );
    const slider = screen.getByRole("slider", { name: "Lap position" });
    expect(slider).toHaveClass(
      "compact:h-11",
      "compact:py-5",
      "compact:!bg-clip-content",
      ...COMPACT_FOCUS_RING.split(" "),
    );
    expect(slider.style.backgroundClip).toBe("");
  });
});
