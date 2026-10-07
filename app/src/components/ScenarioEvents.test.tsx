/**
 * ScenarioEvents tests — the crossing detector and its ruled semantics.
 *
 * The card itself (focus, continue, degrade) is `EventCard.test.tsx`'s job; this
 * file pins WHEN the card exists at all: an upward crossing fires once and pauses,
 * landing is not crossing, dismissal re-arms only below the mark, and a plain
 * load silences everything.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { lastInstant } from "../engine/clock";
import { parseReplay } from "../engine/load";
import type { GalleryScenario } from "../engine/gallery";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";
import { ScenarioEvents } from "./ScenarioEvents";

const replay = parseReplay(sampleLap, "sample-lap.json");

const scenario: GalleryScenario = {
  id: "with-event",
  title: "With event",
  hook: "h",
  file: "with-event.json",
  suggested: { driver: "VER", clock: 0, speedMult: 1 },
  provenance: {
    session: "S",
    laps: "1-2",
    drivers: ["VER"],
    generated: "2026-09-08",
  },
  events: [{ clock: 30, title: "RED FLAG", body: "The stoppage, narrated." }],
};

/**
 * Publish a clock tick, wrapped for the state updates it causes.
 *
 * Timestamps advance past the channel's emit gap or the publish is throttled
 * away; the cars array must MATCH the replay's length or the stale-frame guard
 * (correctly) drops the frame whole. `wraps` is the loop's playback-wrap count:
 * a backward step with the same count is a seek, and with a higher one it is a wrap.
 */
let nowMs = 0;
function tick(clock: number, carCount = replay.cars.length, wraps = 0) {
  nowMs += 1000;
  const snapshot = {
    index: 0,
    t: clock,
    x: 0,
    y: 0,
    heading: 0,
    speed: 0,
    throttle: 0,
    brake: 0 as const,
    gear: 0,
  };
  act(() =>
    telemetry.publish(nowMs, clock, Array(carCount).fill(snapshot), wraps),
  );
}

beforeEach(() => {
  telemetry.reset();
  useTransport.setState({
    replay,
    isPlaying: true,
    speedMult: 1,
    seekTarget: null,
    focusedCarIndex: 0,
    comparisonCarIndex: null,
    scenario,
  });
});
afterEach(cleanup);

describe("ScenarioEvents", () => {
  it("fires when the clock crosses the mark, shows the copy verbatim, and pauses", () => {
    render(<ScenarioEvents />);
    tick(10); // arms
    tick(29);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    tick(31);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("RED FLAG")).toBeInTheDocument();
    expect(screen.getByText("The stoppage, narrated.")).toBeInTheDocument();
    expect(useTransport.getState().isPlaying).toBe(false);
  });

  it("treats the first observed clock as arming, not crossing — landing past the mark is quiet", () => {
    render(<ScenarioEvents />);
    tick(50); // a scenario whose suggested clock lands beyond the event
    tick(51);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a seek jumping the mark counts as a crossing — scrubbing past the red flag earns the narration", () => {
    render(<ScenarioEvents />);
    tick(5);
    tick(45); // one tick, 40 seconds — a seek
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not re-fire after dismissal until the clock has gone back below the mark", () => {
    render(<ScenarioEvents />);
    tick(10);
    tick(31);
    act(() => screen.getByRole("button", { name: "Close" }).click());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    tick(32); // still past the mark: no nag
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    tick(10); // back below: re-armed
    tick(35); // cross again: the moment replays, so does the card
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("dismissal leaves the transport paused — closing hands control back, it does not resume", () => {
    render(<ScenarioEvents />);
    tick(10);
    tick(31);
    act(() => screen.getByRole("button", { name: "Close" }).click());
    expect(useTransport.getState().isPlaying).toBe(false);
  });

  it("renders nothing for a plain load — no scenario, no events, no card", () => {
    useTransport.setState({ scenario: null });
    render(<ScenarioEvents />);
    tick(10);
    tick(45);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a new load mid-card removes the card — a card never survives the replay it narrates", () => {
    render(<ScenarioEvents />);
    tick(10);
    tick(31);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => useTransport.getState().setReplay(replay));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a frame describing another replay's cars neither arms nor fires — the Hud stale-frame guard", () => {
    render(<ScenarioEvents />);
    tick(10, 3); // wrong car count: dropped whole, so NOT an arming observation
    tick(45, 3); // wrong car count past the mark: no crossing either
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    tick(50); // the first matching frame arms — past the mark, still quiet
    tick(51);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Slice 23 follow-up: the clamp was `duration`, a value the clock never holds — its
  // domain is [0, duration) and a seek to the end lands on `lastInstant` — so a late
  // event could never fire. The test it replaces published `clock = duration` by
  // hand, the one clock no real loop produces, and so passed. Three late marks: far
  // past the window, exactly AT `duration` (the >= boundary), and inside the final
  // grid step, past every instant a seek can reach.
  const end = lastInstant(replay.meta.duration, replay.meta.sampleRateHz);
  it.each([
    ["far past the window", 500],
    ["exactly at the duration", replay.meta.duration],
    ["inside the final grid step", (end + replay.meta.duration) / 2],
  ])(
    "clamps an event %s to the LAST INSTANT — the narration survives the cut",
    (_, lateClock) => {
      useTransport.setState({
        scenario: {
          ...scenario,
          events: [{ clock: lateClock, title: "LATE", body: "b" }],
        },
      });
      render(<ScenarioEvents />);
      tick(10);
      tick(end); // 58.4 — where End, the scrubber's right edge and a clamped seek land
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
  );

  // Fast playback can spend the whole final grid step between two ≤30 Hz ticks, so
  // the watcher sees 58.3 and then 0.1. The loop's wrap count says that step went
  // round through the end. Before this, 4x on a 30 Hz display fired a late card on
  // 1 pass in 20.
  const lateScenario = {
    ...scenario,
    events: [{ clock: 500, title: "LATE", body: "b" }],
  };
  const WRAPPED = 1;

  it("a wrap crosses a late mark it stepped over between ticks — and puts the frame back on it", () => {
    useTransport.setState({ scenario: lateScenario });
    render(<ScenarioEvents />);
    tick(10);
    tick(58.3);
    tick(0.1, replay.cars.length, WRAPPED);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useTransport.getState().isPlaying).toBe(false);
    // The wrapped clock is at the window's START; the card narrates the END.
    expect(useTransport.getState().seekTarget).toBe(end);
  });

  it("a backward SEEK from the same spot is not a wrap — Home at 58.3 is quiet", () => {
    useTransport.setState({ scenario: lateScenario });
    render(<ScenarioEvents />);
    tick(10);
    tick(58.3);
    tick(0); // same wrap count: a seek moved it, so nothing was passed
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useTransport.getState().seekTarget).toBeNull();
  });

  it("a wrap credits only marks PAST the previous clock — a dismissed card stays dismissed, then replays", () => {
    useTransport.setState({ scenario: lateScenario });
    render(<ScenarioEvents />);
    tick(10);
    tick(end); // crossed in plain sight: no wrap, so no seek either
    expect(useTransport.getState().seekTarget).toBeNull();
    act(() => screen.getByRole("button", { name: "Close" }).click());

    tick(end + 0.05);
    tick(0.1, replay.cars.length, WRAPPED); // already past the mark: no nag
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    tick(30, replay.cars.length, WRAPPED); // a second pass is a second crossing
    tick(0.1, replay.cars.length, WRAPPED + 1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("reads a wrap count that went DOWN as a fresh loop, not a wrap", () => {
    useTransport.setState({ scenario: lateScenario });
    render(<ScenarioEvents />);
    tick(10, replay.cars.length, 3);
    tick(58.3, replay.cars.length, 3);
    tick(0, replay.cars.length, 0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
