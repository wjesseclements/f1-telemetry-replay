/**
 * Channel tests — the cadence contract, which is the whole reason this module exists.
 *
 * Time is passed in rather than read from a clock, so these assert exact emit counts at
 * exact timestamps instead of sleeping and hoping.
 */
import { describe, expect, it, vi } from "vitest";
import type { CarSnapshot } from "../engine/interpolate";
import {
  createTelemetryChannel,
  EMPTY_FRAME,
  HUD_HZ,
  type TelemetryChannel,
} from "./channel";

function snapshot(over: Partial<CarSnapshot> = {}): CarSnapshot {
  return {
    index: 0,
    t: 0,
    x: 0,
    y: 0,
    heading: 0,
    speed: 200,
    throttle: 50,
    brake: 0,
    gear: 5,
    drs: 8,
    ...over,
  };
}

/** A channel with a listener attached, and the spy that counts emits. */
function withListener(): {
  channel: TelemetryChannel;
  emits: ReturnType<typeof vi.fn>;
} {
  const channel = createTelemetryChannel();
  const emits = vi.fn();
  channel.subscribe(emits);
  return { channel, emits };
}

describe("telemetry channel", () => {
  it("starts on the shared empty frame", () => {
    const channel = createTelemetryChannel();
    expect(channel.getSnapshot()).toBe(EMPTY_FRAME);
    expect(channel.getSnapshot().cars).toEqual([]);
    // Same reference every call — `useSyncExternalStore` compares by identity and a
    // fresh object per call would loop forever.
    expect(channel.getSnapshot()).toBe(channel.getSnapshot());
  });

  it("emits the FIRST publish immediately, with no cadence wait", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 0, [snapshot()]);
    expect(emits).toHaveBeenCalledTimes(1);
    expect(channel.getSnapshot().clock).toBe(0);
  });

  it("starts the cadence window at the first emit, not at zero", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 0, [snapshot()]);
    expect(emits).toHaveBeenCalledTimes(1);

    // 10 ms after the first emit: inside the window, so silent even though the values
    // changed.
    channel.publish(1010, 0.5, [snapshot({ speed: 210 })]);
    expect(emits).toHaveBeenCalledTimes(1);

    // 34 ms after the FIRST EMIT (not after t=0) clears the window.
    channel.publish(1034, 1, [snapshot({ speed: 220 })]);
    expect(emits).toHaveBeenCalledTimes(2);
  });

  it("holds the reference steady between emits", () => {
    const { channel } = withListener();
    channel.publish(1000, 0, [snapshot()]);
    const first = channel.getSnapshot();

    channel.publish(1010, 0.5, [snapshot({ speed: 210 })]); // suppressed
    expect(channel.getSnapshot()).toBe(first);

    channel.publish(1100, 1, [snapshot({ speed: 220 })]); // emitted
    expect(channel.getSnapshot()).not.toBe(first);
  });

  it("caps at HUD_HZ across a run of frames", () => {
    const { channel, emits } = withListener();
    // 120 frames at 60fps = 2 s of simulated time, with the speed changing every frame
    // so nothing is suppressed for being identical.
    for (let i = 0; i < 120; i++) {
      channel.publish(1000 + i * (1000 / 60), i * 0.016, [
        snapshot({ speed: 100 + i }),
      ]);
    }
    // 2 s at 30 Hz is 60 emits, plus the immediate first. Never per-frame.
    expect(emits.mock.calls.length).toBeLessThanOrEqual(HUD_HZ * 2 + 1);
    expect(emits.mock.calls.length).toBeGreaterThan(HUD_HZ);
    expect(emits.mock.calls.length).toBeLessThan(120);
  });

  it("emits NOTHING while paused on an unchanging clock", () => {
    // The reduced-motion case: a paused replay republishes identical values forever.
    // Rate-limiting alone would still repaint the same digits 30 times a second.
    const { channel, emits } = withListener();
    const frozen = [snapshot()];
    channel.publish(1000, 12.5, frozen);
    expect(emits).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 120; i++) channel.publish(1000 + i * 16, 12.5, frozen);
    expect(emits).toHaveBeenCalledTimes(1);
  });

  it("wakes as soon as a visible value changes after an idle spell", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 12.5, [snapshot()]);
    for (let i = 1; i <= 60; i++)
      channel.publish(1000 + i * 16, 12.5, [snapshot()]);
    expect(emits).toHaveBeenCalledTimes(1);

    channel.publish(2000, 12.5, [snapshot({ gear: 6 })]);
    expect(emits).toHaveBeenCalledTimes(2);
  });

  it("ignores changes too small to see", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 1, [snapshot({ speed: 200 })]);
    // Sub-km/h speed and sub-millisecond clock: identical once rounded for display.
    channel.publish(2000, 1.0000001, [snapshot({ speed: 200.4 })]);
    expect(emits).toHaveBeenCalledTimes(1);

    // A whole km/h is visible.
    channel.publish(3000, 1, [snapshot({ speed: 201 })]);
    expect(emits).toHaveBeenCalledTimes(2);
  });

  it("notices a DRS change even when nothing else moves", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 1, [snapshot({ drs: 8 })]); // closed
    channel.publish(2000, 1, [snapshot({ drs: 12 })]); // open
    expect(emits).toHaveBeenCalledTimes(2);
  });

  it("does NOT emit for a moved car at an unchanged clock (Slice 9e)", () => {
    /**
     * The `x`/`y` term's removal, pinned as behaviour rather than left in a comment.
     *
     * Slice 9 put rounded positions in the signature because the tower's gaps came from
     * them; 9d moved gaps onto the replay's progress read at the CLOCK, and 9e's trace is
     * a function of the clock and the car's static samples. Nothing the HUD draws is a
     * function of a published coordinate any more, so a coordinate must not buy an emit.
     *
     * This pair CANNOT occur in production — the loop publishes `sampleAt(clock)`, so a
     * moved car means a moved clock — which is exactly why the term cost nothing to
     * remove and why removing it changes no real emit count.
     */
    const { channel, emits } = withListener();
    channel.publish(1000, 1, [snapshot({ x: 0, y: 0 })]);
    channel.publish(2000, 1, [snapshot({ x: 5000, y: -9000 })]);
    expect(emits).toHaveBeenCalledTimes(1);

    // The clock still moves everything, which is what the tower and the trace ride on.
    channel.publish(3000, 1.5, [snapshot({ x: 5000, y: -9000 })]);
    expect(emits).toHaveBeenCalledTimes(2);
  });

  it("tracks every car, not just the first", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 1, [snapshot(), snapshot({ speed: 100 })]);
    // Only the SECOND car changes — a signature built from cars[0] would miss it.
    channel.publish(2000, 1, [snapshot(), snapshot({ speed: 150 })]);
    expect(emits).toHaveBeenCalledTimes(2);
    expect(channel.getSnapshot().cars).toHaveLength(2);
  });

  it("stops calling a listener once unsubscribed", () => {
    const channel = createTelemetryChannel();
    const emits = vi.fn();
    const unsubscribe = channel.subscribe(emits);

    channel.publish(1000, 0, [snapshot()]);
    expect(emits).toHaveBeenCalledTimes(1);

    unsubscribe();
    channel.publish(2000, 1, [snapshot({ speed: 300 })]);
    expect(emits).toHaveBeenCalledTimes(1);
  });

  it("reset drops the frame and the listeners", () => {
    const { channel, emits } = withListener();
    channel.publish(1000, 5, [snapshot()]);
    channel.reset();

    expect(channel.getSnapshot()).toBe(EMPTY_FRAME);
    channel.publish(1005, 6, [snapshot({ speed: 250 })]);
    expect(emits).toHaveBeenCalledTimes(1);
  });

  it("reset clears the cadence window, not just the frame", () => {
    const { channel } = withListener();
    channel.publish(1000, 5, [snapshot()]);
    channel.reset();

    // Subscribe BEFORE publishing: this is the first publish of the channel's new life,
    // so it must emit immediately even though it lands 5 ms after the pre-reset one. A
    // reset that cleared only `current` would leave the old window in force and swallow
    // it — which is exactly what a HUD remounting mid-lap would hit.
    const after = vi.fn();
    channel.subscribe(after);
    channel.publish(1005, 6, [snapshot({ speed: 250 })]);
    expect(after).toHaveBeenCalledTimes(1);
  });
});
