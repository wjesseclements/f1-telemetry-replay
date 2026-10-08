import { describe, expect, it } from "vitest";
import { MAX_FRAME_DT_S, advanceClock, frameDelta, lastInstant } from "./clock";
import { wrapClock } from "./interpolate";

describe("frameDelta", () => {
  it("returns 0 on the first frame, when there is no interval to measure", () => {
    expect(frameDelta(null, 1234.5)).toBe(0);
  });

  it("converts a millisecond interval to seconds", () => {
    expect(frameDelta(1000, 1016.7)).toBeCloseTo(0.0167, 6);
  });

  it("clamps a long gap so a backgrounded tab resumes without teleporting", () => {
    // Tab hidden for 30 s: unclamped this would advance the car half a lap in
    // one frame.
    expect(frameDelta(1000, 31_000)).toBe(MAX_FRAME_DT_S);
  });

  it("passes an interval just under the clamp through untouched", () => {
    expect(frameDelta(1000, 1099)).toBeCloseTo(0.099, 6);
  });

  it("stalls rather than rewinds on a non-monotonic or degenerate timestamp", () => {
    expect(frameDelta(1000, 900)).toBe(0);
    expect(frameDelta(1000, 1000)).toBe(0);
    expect(frameDelta(1000, NaN)).toBe(0);
  });
});

describe("advanceClock", () => {
  const DURATION = 58.5;

  it("adds the scaled delta", () => {
    expect(advanceClock(10, 0.05, 1, DURATION)).toBeCloseTo(10.05, 10);
    expect(advanceClock(10, 0.05, 4, DURATION)).toBeCloseTo(10.2, 10);
    expect(advanceClock(10, 0.05, 0.5, DURATION)).toBeCloseTo(10.025, 10);
  });

  it("does not move while paused-equivalent input is supplied", () => {
    // The loop passes dt straight through when paused-and-then-resumed; a zero
    // delta must be a no-op, not a wrap.
    expect(advanceClock(10, 0, 4, DURATION)).toBe(10);
  });

  it("wraps past the end back to the start of the lap", () => {
    expect(advanceClock(58.45, 0.1, 1, DURATION)).toBeCloseTo(0.05, 10);
  });

  it("wraps a whole lap's worth of delta rather than running off the grid", () => {
    // Only reachable via a large speedMult, but it must fold, not overflow.
    expect(advanceClock(1, 30, 4, DURATION)).toBeCloseTo(121 - 58.5 * 2, 10);
  });

  it("lands on 0, not on duration, at exactly one lap", () => {
    expect(advanceClock(58.4, 0.1, 1, DURATION)).toBe(0);
  });

  it("wraps backwards past zero when the clock is driven negative", () => {
    expect(advanceClock(0.05, 0.1, -1, DURATION)).toBeCloseTo(58.45, 10);
  });

  it("changes speed without rescaling already-elapsed time", () => {
    // The property the whole module exists for. Ten frames at 1x, then ten at
    // 4x: the first ten seconds' worth of progress must survive the switch.
    const dt = 0.1;
    let clock = 0;
    for (let i = 0; i < 10; i++) clock = advanceClock(clock, dt, 1, DURATION);
    const atSwitch = clock;
    expect(atSwitch).toBeCloseTo(1, 10);

    for (let i = 0; i < 10; i++) clock = advanceClock(clock, dt, 4, DURATION);
    // 1 s already elapsed + 10 frames * 0.1 s * 4 = 5 s. An absolute-timestamp
    // clock would instead report the whole 2 s of wall time at 4x = 8 s.
    expect(clock).toBeCloseTo(5, 10);
  });

  it("rejects a non-positive duration through wrapClock", () => {
    expect(() => advanceClock(1, 0.1, 1, 0)).toThrow(RangeError);
  });
});

describe("lastInstant", () => {
  it("is one grid step short of the duration — the last sample", () => {
    // The fixture: 585 samples at 10 Hz, the last at t = 58.4.
    expect(lastInstant(58.5, 10)).toBe(58.4);
  });

  it("is a position the clock keeps, where `duration` itself wraps to the start", () => {
    // The Slice 23 defect in one line: the clock's domain is [0, duration), so a
    // seek to `duration` lands on 0 — the same place as Home.
    expect(wrapClock(58.5, 58.5)).toBe(0);
    expect(wrapClock(lastInstant(58.5, 10), 58.5)).toBe(58.4);
  });

  it("lands EXACTLY on the grid, where duration - step does not", () => {
    // 448.9 - 0.1 is 448.79999999999995. A range input snaps its max DOWN to the
    // step grid, so that value would put the scrubber's right edge at 448.7 — one
    // step short of End (measured in headless Chrome 154).
    expect(448.9 - 0.1).not.toBe(448.8);
    expect(lastInstant(448.9, 10)).toBe(448.8);
  });

  it("is the exact grid instant for every on-grid duration, at more than one rate", () => {
    // A sweep rather than a handful of picks: which durations a float subtraction
    // gets wrong is not predictable by eye, so every one up to ~17 min is checked.
    for (const rate of [10, 4]) {
      for (let n = 2; n <= 10_000; n++) {
        const duration = n / rate;
        const last = lastInstant(duration, rate);
        expect(last).toBe((n - 1) / rate);
        expect(last).toBeLessThan(duration);
      }
    }
  });

  it("stays a grid instant inside [0, duration) for a duration off the grid", () => {
    // The schema tolerates a span one sample either side of the duration, so the
    // duration need not be a whole number of steps.
    for (const duration of [58.44, 58.45, 58.46]) {
      const last = lastInstant(duration, 10);
      expect(last).toBeLessThan(duration);
      expect(wrapClock(last, duration)).toBe(last);
      expect(last * 10).toBeCloseTo(Math.round(last * 10), 9);
    }
  });

  it("is 0 for a replay one sample long — the only instant there is", () => {
    expect(lastInstant(0.1, 10)).toBe(0);
    // Shorter than a step is not schema-valid data, but the answer still may not
    // go negative: a negative seek would wrap round to the END.
    expect(lastInstant(0.04, 10)).toBe(0);
  });
});
