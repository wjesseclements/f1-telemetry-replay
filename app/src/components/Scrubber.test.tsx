/**
 * Scrubber tests — step granularity and the drag race.
 *
 * A note on what jsdom can and cannot show here: it does NOT implement native range
 * keyboard stepping, so firing `keyDown` on the input does not move its value. A test
 * that pressed an arrow and asserted the value changed would assert nothing at all.
 * What IS observable is the contract around that native behaviour — the `step` and
 * `max` the browser will use, and that a change at one step commits exactly one seek of
 * exactly that size. Real native stepping is confirmed in the browser pass.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFixtureReplay } from "../data/fixture";
import { Scrubber } from "./Scrubber";
import { segmentGradient } from "./flagTint";

const replay = loadFixtureReplay();
const { duration, sampleRateHz } = replay.meta;
const STEP = 1 / sampleRateHz; // 0.1 s on the fixture

const setup = (clock = 0) => {
  const onSeek = vi.fn();
  render(
    <Scrubber
      clock={clock}
      duration={duration}
      sampleRateHz={sampleRateHz}
      onSeek={onSeek}
    />,
  );
  return { onSeek, input: screen.getByRole("slider") as HTMLInputElement };
};

afterEach(cleanup);

describe("Scrubber range attributes", () => {
  it("steps by exactly one grid step, not the default of 1 second", () => {
    const { input } = setup();
    // The default would be "1" — a full second per arrow press, ten times coarser than
    // every other seek path in the app.
    expect(input.step).toBe(String(STEP));
    expect(Number(input.step)).toBeCloseTo(0.1, 12);
  });

  it("spans the whole lap on meta.duration", () => {
    const { input } = setup();
    expect(input.min).toBe("0");
    expect(input.max).toBe(String(duration));
  });

  it("is a labelled slider that announces the lap clock, not a bare number", () => {
    const { input } = setup(12.4);
    expect(input).toHaveAccessibleName("Lap position");
    expect(input).toHaveAttribute("aria-valuetext", "0:12.400");
  });
});

describe("Scrubber seeking", () => {
  it("commits exactly one seek of exactly one step", () => {
    const { onSeek, input } = setup(0);
    fireEvent.change(input, { target: { value: String(STEP) } });

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek.mock.calls[0][0]).toBeCloseTo(STEP, 12);
  });

  it("follows the clock when no drag is in progress", () => {
    const { input } = setup(20);
    expect(input.value).toBe("20");
  });

  it("commits every change during a drag, so the canvas previews live", () => {
    const { onSeek, input } = setup(0);
    fireEvent.pointerDown(input);
    for (const v of [5, 10, 15]) {
      fireEvent.change(input, { target: { value: String(v) } });
    }
    expect(onSeek.mock.calls.map((c) => c[0])).toEqual([5, 10, 15]);
  });
});

describe("Scrubber drag race", () => {
  it("holds the dragged value against an advancing clock", () => {
    // The bug this prevents: during playback the clock keeps arriving at 30 Hz, and a
    // purely snapshot-driven value yanks the thumb backwards under the finger.
    const onSeek = vi.fn();
    const view = render(
      <Scrubber
        clock={0}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={onSeek}
      />,
    );
    const input = screen.getByRole("slider") as HTMLInputElement;

    fireEvent.pointerDown(input);
    fireEvent.change(input, { target: { value: "40" } });
    expect(input.value).toBe("40");

    // Playback publishes a clock from before the drag landed.
    view.rerender(
      <Scrubber
        clock={0.5}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={onSeek}
      />,
    );
    expect(input.value).toBe("40");
  });

  it("returns to the clock on release — from the released position, not the old one", () => {
    const onSeek = vi.fn();
    const view = render(
      <Scrubber
        clock={0}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={onSeek}
      />,
    );
    const input = screen.getByRole("slider") as HTMLInputElement;

    fireEvent.pointerDown(input);
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.pointerUp(window);

    // The loop applied the seek and playback continued from there.
    view.rerender(
      <Scrubber
        clock={40.2}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={onSeek}
      />,
    );
    // No snap-back to 0: the scrubber tracks the clock again, and the clock is at the
    // released position.
    expect(input.value).toBe("40.2");
  });

  it("ends the drag even when the pointer is released off the control", () => {
    const onSeek = vi.fn();
    const view = render(
      <Scrubber
        clock={0}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={onSeek}
      />,
    );
    const input = screen.getByRole("slider") as HTMLInputElement;

    fireEvent.pointerDown(input);
    fireEvent.change(input, { target: { value: "30" } });
    // Released outside the window entirely — the input never sees this event.
    fireEvent.pointerUp(document.body);

    view.rerender(
      <Scrubber
        clock={31}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={onSeek}
      />,
    );
    expect(input.value).toBe("31");
  });
});

// "Scrubbing never pauses playback" is asserted in `App.test.tsx`, where `isPlaying` is
// actually observable. Here it would be vacuous: `Scrubber` is handed no play/pause
// capability at all, so there is nothing for a test at this level to catch.

describe("segmentGradient", () => {
  it("returns null when nothing needs tinting — the bg-line class alone paints the bar", () => {
    expect(segmentGradient([])).toBeNull();
    expect(segmentGradient([{ status: "green", from: 0, to: 1 }])).toBeNull();
    expect(segmentGradient([{ status: "unknown", from: 0, to: 1 }])).toBeNull();
  });

  it("paints an abnormal stretch with its token and fills around it with the base", () => {
    const gradient = segmentGradient([
      { status: "green", from: 0, to: 0.4 },
      { status: "red", from: 0.4, to: 0.6 },
      { status: "green", from: 0.6, to: 1 },
    ]);
    expect(gradient).toBe(
      "linear-gradient(to right, var(--c-line) 0.00% 40.00%, var(--c-flag-red) 40.00% 60.00%, var(--c-line) 60.00% 100%)",
    );
  });

  it("keeps each flag family's own token — sc, vsc and yellow are distinguishable", () => {
    const gradient = segmentGradient([
      { status: "yellow", from: 0, to: 0.2 },
      { status: "sc", from: 0.2, to: 0.5 },
      { status: "vsc", from: 0.5, to: 0.7 },
    ]);
    expect(gradient).toContain("var(--c-flag-yellow) 0.00% 20.00%");
    expect(gradient).toContain("var(--c-flag-sc) 20.00% 50.00%");
    expect(gradient).toContain("var(--c-flag-vsc) 50.00% 70.00%");
    // The uncovered tail is base-coloured, not left to the previous stop.
    expect(gradient).toContain("var(--c-line) 70.00% 100%");
  });

  it("bridges a coverage gap with the base colour", () => {
    const gradient = segmentGradient([
      { status: "red", from: 0.1, to: 0.2 },
      { status: "yellow", from: 0.8, to: 1 },
    ]);
    expect(gradient).toContain("var(--c-line) 0.00% 10.00%");
    expect(gradient).toContain("var(--c-line) 20.00% 80.00%");
  });
});
