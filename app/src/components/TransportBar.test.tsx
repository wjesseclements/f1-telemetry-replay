/**
 * TransportBar tests — the lap indicator (Slice 14).
 *
 * The transport controls themselves are exercised through `App.test.tsx` and
 * `Scrubber.test.tsx`; this file pins the one thing new here: the leader-lap
 * readout, which must exist exactly when the data carries laps (the rule-8
 * shape) and must read the HIGHEST lap across cars, not any particular car's.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
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

describe("TransportBar on a compact screen (Slice 27)", () => {
  // jsdom applies no media query, so these pin the `compact:` classes; the boxes
  // they make (44x44 and up, unobstructed, no two overlapping) are measured in a
  // real browser in Slice 27's PLAN entry.
  it("gives every button a 44 px target with its focus ring inside", () => {
    renderBar(bare, 10);
    const buttons = screen.getAllByRole("button");
    // Play/pause, restart and the four speeds: the bar's every button.
    const names = [
      /^(Play|Pause)$/,
      "Restart lap",
      "0.5× speed",
      "1× speed",
      "2× speed",
      "4× speed",
    ];
    expect(buttons).toHaveLength(names.length);
    buttons.forEach((button, i) =>
      expect(button).toHaveAccessibleName(names[i]),
    );
    for (const button of buttons) {
      expect(button).toHaveClass(...TOUCH_TARGET.split(" "));
      expect(button).toHaveClass(...COMPACT_FOCUS_RING.split(" "));
    }
  });

  it("is as thin as its controls: no vertical padding, no gap between its rows", () => {
    // What makes the bar one 45 px row in landscape and three 44 px rows
    // upright is that it drops `py-2` (8 px above and below) and `gap-y-2` (8 px
    // between the rows it wraps to upright). Either one gone, the bar fattens
    // and nothing fails: the canvas floor the layout check gates has room to
    // spare at most gated sizes (Slice 27's review: each survived the suite and
    // check:layout).
    renderBar(bare, 10);
    const bar = screen.getByRole("region", { name: "Playback controls" });
    expect(bar).toHaveClass("compact:py-0", "compact:gap-y-0");
  });

  it("makes the scrubber 44 px tall and keeps its painted track 4 px", () => {
    // The tint is clipped to the content box, so the 20 px of padding above and
    // below are hit area, not paint. The clip is an important `compact:` class,
    // because the tint's inline `background` shorthand resets the clip, and the
    // inline style stays exactly what it was so no other screen's pixels move.
    // `block`, or the inline input's line box adds 6 px under its row.
    renderBar(
      withStatus([
        { status: "green", fromT: 0, toT: 40 },
        { status: "red", fromT: 40, toT: 58.5 },
      ]),
      10,
    );
    const slider = screen.getByRole("slider", { name: "Lap position" });
    expect(slider).toHaveClass(
      "compact:block",
      "compact:h-11",
      "compact:py-5",
      "compact:!bg-clip-content",
      ...COMPACT_FOCUS_RING.split(" "),
    );
    expect(slider.style.backgroundClip).toBe("");
  });
});

describe("TransportBar tooltips (Slice 27)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("repeats play/pause's and restart's names as tooltips, verbatim, at every size", () => {
    // Ruled 2026-10-13. Both are icons on every screen (▶/❚❚ and ↺), so no
    // media query decides their tooltips, unlike the header's two buttons
    // (`useCompactLayout`): the same with `compact:` matching and not.
    for (const compact of [true, false]) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: compact,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      act(() => useTransport.setState({ isPlaying: true }));
      const view = renderBar(bare, 10);
      const toggle = screen.getByRole("button", { name: "Pause" });
      expect(toggle).toHaveAttribute("title", "Pause");
      expect(
        screen.getByRole("button", { name: "Restart lap" }),
      ).toHaveAttribute("title", "Restart lap");

      // The toggle's tooltip follows its name: what a press will do.
      act(() => useTransport.setState({ isPlaying: false }));
      expect(toggle).toHaveAccessibleName("Play");
      expect(toggle).toHaveAttribute("title", "Play");
      view.unmount();
    }
  });

  it("names both by sr-only text, never aria-label, so the tooltip is not a second reading", () => {
    // Ruled 2026-10-13. With `aria-label` plus an equal `title`, Chrome exposed
    // the title as a description repeating the name; named from their content,
    // as the header's buttons are, they expose none (measured in Chrome — jsdom
    // always reports a title as the description, so this pins the structure
    // that Chrome's measurement rests on).
    for (const isPlaying of [true, false]) {
      act(() => useTransport.setState({ isPlaying }));
      const view = renderBar(bare, 10);
      const label = isPlaying ? "Pause" : "Play";
      for (const [name, glyph] of [
        [label, isPlaying ? "❚❚" : "▶"],
        ["Restart lap", "↺"],
      ]) {
        const button = screen.getByRole("button", { name });
        expect(button).not.toHaveAttribute("aria-label");
        expect(button).not.toHaveAttribute("aria-labelledby");
        expect(button).toHaveAttribute("title", name);
        const hidden = button.querySelector(".sr-only");
        expect(hidden).toHaveTextContent(new RegExp(`^${name}$`));
        // The glyph is seen, not read: it would otherwise join the name.
        const shown = button.querySelector('[aria-hidden="true"]');
        expect(shown).toHaveTextContent(glyph);
        expect(button.childElementCount).toBe(2);
      }
      view.unmount();
    }
  });
});
