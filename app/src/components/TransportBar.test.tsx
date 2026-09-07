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
