/**
 * StatusBanner tests — shown ONLY under an abnormal flag, silent everywhere
 * else. The silence cases matter as much as the loud ones: green, unknown, a
 * coverage gap and a statusless (pre-Slice-17) replay must all render nothing,
 * which is what keeps every existing scenario's canvas exactly as it was.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { parseReplay } from "../engine/load";
import type { Replay } from "../engine/schema";
import { telemetry } from "../telemetry/channel";
import { StatusBanner } from "./StatusBanner";

const bare = parseReplay(sampleLap, "sample-lap.json");

function withStatus(
  intervals: { status: string; fromT: number; toT: number }[],
): Replay {
  const raw = JSON.parse(JSON.stringify(sampleLap));
  raw.trackStatus = intervals;
  return parseReplay(raw, "status.json");
}

const ARC = withStatus([
  { status: "green", fromT: 0, toT: 10 },
  { status: "yellow", fromT: 10, toT: 20 },
  { status: "sc", fromT: 20, toT: 30 },
  { status: "vsc", fromT: 30, toT: 40 },
  { status: "red", fromT: 40, toT: 50 },
  { status: "unknown", fromT: 55, toT: 58.5 },
]);

function renderAt(replay: Replay, clock: number) {
  telemetry.publish(1000, clock, []);
  return render(<StatusBanner replay={replay} />);
}

beforeEach(() => telemetry.reset());
afterEach(cleanup);

describe("StatusBanner", () => {
  it("shows each abnormal flag's label at its clock", () => {
    for (const [clock, label] of [
      [15, "YELLOW FLAG"],
      [25, "SAFETY CAR"],
      [35, "VIRTUAL SAFETY CAR"],
      [45, "RED FLAG"],
    ] as const) {
      const view = renderAt(ARC, clock);
      expect(screen.getByText(label)).toBeInTheDocument();
      view.unmount();
      telemetry.reset();
    }
  });

  it("renders NOTHING under green — the ordinary state of racing is not signage", () => {
    const { container } = renderAt(ARC, 5);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for unknown, a coverage gap, or a statusless replay", () => {
    const unknown = renderAt(ARC, 56);
    expect(unknown.container).toBeEmptyDOMElement();
    unknown.unmount();
    telemetry.reset();

    const gap = renderAt(ARC, 52); // between red's end and unknown's start
    expect(gap.container).toBeEmptyDOMElement();
    gap.unmount();
    telemetry.reset();

    const statusless = renderAt(bare, 15);
    expect(statusless.container).toBeEmptyDOMElement();
  });

  it("is presentation only: hidden from the accessibility tree and inert to the pointer", () => {
    // The StatusFlag chip in the transport bar is the accessible carrier of the
    // same fact; announcing it twice would be noise.
    const { container } = renderAt(ARC, 45);
    const overlay = container.firstElementChild;
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay?.className).toContain("pointer-events-none");
  });
});
