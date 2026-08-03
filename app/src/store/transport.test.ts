import { beforeEach, describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import { useTransport } from "./transport";

const replay = parseReplay(sampleLap, "sample-lap.json");
const initial = useTransport.getState();

beforeEach(() => {
  useTransport.setState({
    replay: null,
    isPlaying: true,
    speedMult: 1,
    seekTarget: null,
    focusedCarIndex: 0,
  });
});

describe("useTransport", () => {
  it("starts with no replay, playing, at 1x, with nothing to seek", () => {
    expect(initial.replay).toBeNull();
    expect(initial.isPlaying).toBe(true);
    expect(initial.speedMult).toBe(1);
    expect(initial.seekTarget).toBeNull();
  });

  it("holds no clock — the loop's ref owns it (architecture rule 1)", () => {
    // A guard, not a formality: a `clock`/`time`/`elapsed` field appearing here is
    // exactly the regression rule 1 forbids, and it would pass every other test.
    expect(
      Object.keys(initial).filter((k) => /clock|time|elapsed/i.test(k)),
    ).toEqual([]);
  });

  it("stores a validated replay", () => {
    useTransport.getState().setReplay(replay);
    expect(useTransport.getState().replay).toBe(replay);
  });

  it("plays, pauses and toggles", () => {
    const { pause, play, togglePlay } = useTransport.getState();

    pause();
    expect(useTransport.getState().isPlaying).toBe(false);
    play();
    expect(useTransport.getState().isPlaying).toBe(true);
    togglePlay();
    expect(useTransport.getState().isPlaying).toBe(false);
    togglePlay();
    expect(useTransport.getState().isPlaying).toBe(true);
  });

  it("pausing twice stays paused", () => {
    useTransport.getState().pause();
    useTransport.getState().pause();
    expect(useTransport.getState().isPlaying).toBe(false);
  });

  it("sets the speed multiplier", () => {
    useTransport.getState().setSpeedMult(4);
    expect(useTransport.getState().speedMult).toBe(4);
    useTransport.getState().setSpeedMult(0.5);
    expect(useTransport.getState().speedMult).toBe(0.5);
  });

  it("round-trips a seek request: set, then consumed", () => {
    useTransport.getState().seek(12.5);
    expect(useTransport.getState().seekTarget).toBe(12.5);

    useTransport.getState().consumeSeek();
    expect(useTransport.getState().seekTarget).toBeNull();
  });

  it("keeps the latest seek when two arrive before a frame consumes either", () => {
    useTransport.getState().seek(5);
    useTransport.getState().seek(30);
    expect(useTransport.getState().seekTarget).toBe(30);
  });

  it("seeks to 0 without the request reading as absent", () => {
    // The reason seekTarget is `number | null` and not a falsy-checked number:
    // "restart" is a seek to 0, and it must survive the loop's `!== null` test.
    useTransport.getState().seek(0);
    expect(useTransport.getState().seekTarget).toBe(0);
    expect(useTransport.getState().seekTarget).not.toBeNull();
  });

  it("does not change play state when seeking", () => {
    useTransport.getState().pause();
    useTransport.getState().seek(20);
    expect(useTransport.getState().isPlaying).toBe(false);
  });
});

describe("useTransport focus", () => {
  it("starts on the first car", () => {
    expect(initial.focusedCarIndex).toBe(0);
  });

  it("follows a chosen car", () => {
    useTransport.getState().setFocusedCarIndex(2);
    expect(useTransport.getState().focusedCarIndex).toBe(2);
  });

  it("returns to the first car when a replay is loaded", () => {
    // Otherwise a three-car window followed by a one-car lap leaves the focus
    // pointing past the end of `cars`, and every consumer needs its own guard.
    useTransport.getState().setFocusedCarIndex(2);
    useTransport.getState().setReplay(replay);
    expect(useTransport.getState().focusedCarIndex).toBe(0);
  });

  it("does not disturb playback", () => {
    // Changing who you are watching is not a transport action.
    useTransport.getState().seek(12);
    useTransport.getState().setFocusedCarIndex(1);
    expect(useTransport.getState().isPlaying).toBe(true);
    expect(useTransport.getState().seekTarget).toBe(12);
  });
});
