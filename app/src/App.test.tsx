import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import sampleLap from "./engine/__fixtures__/sample-lap.json";
import { thermalGradientCss } from "./engine/color";
import { bootstrapReplay } from "./data/bootstrap";
import { FIXTURE_SOURCE, loadFixtureReplay } from "./data/fixture";
import { useTransport } from "./store/transport";
import { installCanvasEnvironment, installRafDriver } from "./test/canvas";
import App from "./App";

const replay = loadFixtureReplay();

beforeEach(() => {
  installCanvasEnvironment(800, 600);
  installRafDriver();
  useTransport.setState({
    replay: null,
    isPlaying: true,
    speedMult: 1,
    seekTarget: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders the heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /telemetry replay/i }),
    ).toBeInTheDocument();
  });

  it("shows no canvas until a replay is loaded", () => {
    const { container } = render(<App />);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("mounts the track canvas and labels the replay once one is loaded", () => {
    useTransport.setState({ replay });
    const { container } = render(<App />);

    expect(container.querySelector("canvas")).not.toBeNull();
    expect(
      screen.getByText(
        new RegExp(`${replay.meta.event}.*${replay.cars[0].driver}`),
      ),
    ).toBeInTheDocument();
  });

  it("shows the speed legend, generated from the thermal ramp", () => {
    useTransport.setState({ replay });
    const { container } = render(<App />);

    const swatch = container.querySelector<HTMLElement>('[style*="gradient"]');
    expect(swatch).not.toBeNull();
    // Generated from THERMAL, not re-typed: the ramp's own stops, as rgb(). Spaces
    // are stripped because jsdom's CSSOM re-serialises `rgb(30,80,255)` with them.
    const strip = (css: string) => css.replace(/\s+/g, "");
    expect(strip(swatch!.style.background)).toBe(strip(thermalGradientCss()));
    expect(screen.getByText(/colour scale/i)).toBeInTheDocument();
  });
});

/**
 * The bootstrap error path.
 *
 * Slice 4a's blank page is the regression these prevent, so they run a genuinely
 * mutated fixture through the real `bootstrapReplay` rather than passing in a
 * hand-written string — the wiring from schema violation to rendered text is the
 * thing under test, not the component in isolation.
 */
describe("App bootstrap error", () => {
  /** The real message a broken fixture produces. */
  function brokenBoot(): string {
    const broken = JSON.parse(JSON.stringify(sampleLap));
    broken.cars[0].samples[3].speed = "quick";
    const { error } = bootstrapReplay(broken, FIXTURE_SOURCE);
    expect(error).not.toBeNull();
    return error!;
  }

  it("renders the validation message instead of a blank canvas", () => {
    const { container } = render(<App bootstrapError={brokenBoot()} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("shows the offending path verbatim, not a summary", () => {
    const message = brokenBoot();
    render(<App bootstrapError={message} />);

    const alert = screen.getByRole("alert");
    // The whole message, character for character — the part that makes a mismatch
    // fixable is the path line, and summarising throws exactly that away.
    expect(alert).toHaveTextContent("cars[0].samples[3].speed");
    expect(alert.querySelector("pre")?.textContent).toBe(message);
  });

  it("wins over a stale replay in the store", () => {
    // Belt and braces: if bootstrap failed, nothing may render from older data.
    useTransport.setState({ replay });
    const { container } = render(<App bootstrapError={brokenBoot()} />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says nothing about the network, because there is none", () => {
    render(<App bootstrapError={brokenBoot()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/data problem/i);
  });
});
