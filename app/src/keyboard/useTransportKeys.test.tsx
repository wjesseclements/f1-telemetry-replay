/**
 * Keyboard tests — every binding, and the native-first rule that keeps them from
 * firing twice.
 *
 * The native-first half is the one worth the most: the controls are real buttons and a
 * real range input that already handle Space and the arrows. jsdom does not implement
 * that native behaviour, so what these assert is that THIS handler stands down — which
 * is precisely the half that would double-apply in a browser.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixtureReplay } from "../data/fixture";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";
import {
  LARGE_STEP_S,
  SMALL_STEP_S,
  useTransportKeys,
} from "./useTransportKeys";

const replay = loadFixtureReplay();
const { duration, sampleRateHz } = replay.meta;

function Harness() {
  useTransportKeys(replay);
  return (
    <>
      <button type="button">a button</button>
      <input type="range" aria-label="slider" />
    </>
  );
}

/**
 * Put the clock somewhere known, the way the render loop would.
 *
 * The timestamp MUST advance monotonically and by more than the cadence window, or the
 * channel suppresses the publish and the clock silently does not move — which reads as a
 * seek bug in whatever is under test rather than as a broken fixture.
 */
let publishAtMs = 0;
const publishClock = (clock: number) => {
  publishAtMs += 1000;
  telemetry.publish(publishAtMs, clock, []);
};

const seekTarget = () => useTransport.getState().seekTarget;

beforeEach(() => {
  telemetry.reset();
  useTransport.setState({
    replay,
    isPlaying: true,
    speedMult: 1,
    seekTarget: null,
  });
});

afterEach(cleanup);

describe("play/pause", () => {
  it("toggles on Space", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(useTransport.getState().isPlaying).toBe(false);

    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(useTransport.getState().isPlaying).toBe(true);
  });

  it("prevents default so Space does not scroll the page", () => {
    render(<Harness />);
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("stands down when a BUTTON has focus — native activation owns Space", () => {
    const { getByText } = render(<Harness />);
    const button = getByText("a button");
    fireEvent.keyDown(button, { key: " ", code: "Space" });
    // Untouched: the browser will click the button instead.
    expect(useTransport.getState().isPlaying).toBe(true);
  });
});

describe("seeking", () => {
  // Forward and back are separate mounts on purpose: the hook deliberately remembers
  // the target it last issued (see "does not compound staleness"), so pressing both in
  // one mount would be testing the compounding path, not the basic step.
  it("ArrowRight seeks forward one small step", () => {
    render(<Harness />);
    publishClock(20);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(seekTarget()).toBeCloseTo(20 + SMALL_STEP_S, 9);
  });

  it("ArrowLeft seeks back one small step", () => {
    render(<Harness />);
    publishClock(20);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(seekTarget()).toBeCloseTo(20 - SMALL_STEP_S, 9);
  });

  it("shift+arrow seeks by the large step", () => {
    render(<Harness />);
    publishClock(20);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(seekTarget()).toBeCloseTo(20 + LARGE_STEP_S, 9);
  });

  it("Home restarts the lap", () => {
    render(<Harness />);
    publishClock(30);
    fireEvent.keyDown(window, { key: "Home" });
    expect(seekTarget()).toBe(0);
  });

  it("End goes to the last instant, NOT to a position that wraps to zero", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "End" });
    // `duration` itself wraps to 0, which would make End indistinguishable from Home.
    expect(seekTarget()).toBeCloseTo(duration - 1 / sampleRateHz, 9);
    expect(seekTarget()).not.toBe(0);
  });

  it("clamps at both ends instead of seeking outside the lap", () => {
    render(<Harness />);
    publishClock(0.2);
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    expect(seekTarget()).toBe(0);

    useTransport.getState().consumeSeek();
    publishClock(duration - 0.2);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(seekTarget()).toBe(duration);
  });

  it("does not compound staleness under key repeat", () => {
    // The clock is published at most every 33 ms; ten fast presses would otherwise each
    // build on the same stale value and land 1 s on instead of 10 s on.
    render(<Harness />);
    publishClock(10);

    for (let i = 0; i < 10; i++)
      fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(seekTarget()).toBeCloseTo(10 + 10 * SMALL_STEP_S, 9);
  });

  it("picks up a newly published clock after the loop catches up", () => {
    render(<Harness />);
    publishClock(10);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(seekTarget()).toBeCloseTo(11, 9);

    // The loop applied it and playback moved on.
    publishClock(13);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(seekTarget()).toBeCloseTo(14, 9);
  });
});

describe("native-first rule", () => {
  it("stands down for arrows when the range input has focus", () => {
    const { getByLabelText } = render(<Harness />);
    publishClock(20);
    const slider = getByLabelText("slider");

    fireEvent.keyDown(slider, { key: "ArrowRight" });

    // Zero seeks from this handler — the input steps itself, and handling it here too
    // would move the clock twice per press.
    expect(seekTarget()).toBeNull();
  });

  it("stands down for Home/End inside the range input too", () => {
    const { getByLabelText } = render(<Harness />);
    const slider = getByLabelText("slider");
    fireEvent.keyDown(slider, { key: "Home" });
    fireEvent.keyDown(slider, { key: "End" });
    expect(seekTarget()).toBeNull();
  });

  it("ignores an event something else already handled", () => {
    render(<Harness />);
    publishClock(20);
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      cancelable: true,
      bubbles: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(seekTarget()).toBeNull();
  });

  it("ignores keys it does not bind", () => {
    render(<Harness />);
    publishClock(20);
    for (const key of ["a", "Enter", "Escape", "Tab", "ArrowUp", "ArrowDown"]) {
      fireEvent.keyDown(window, { key });
    }
    expect(seekTarget()).toBeNull();
    expect(useTransport.getState().isPlaying).toBe(true);
  });
});

describe("lifecycle", () => {
  it("stops listening once unmounted", () => {
    const view = render(<Harness />);
    view.unmount();
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(useTransport.getState().isPlaying).toBe(true);
  });

  it("does nothing at all before a replay is loaded", () => {
    function NoReplay() {
      useTransportKeys(null);
      return null;
    }
    render(<NoReplay />);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(useTransport.getState().isPlaying).toBe(true);
  });
});
