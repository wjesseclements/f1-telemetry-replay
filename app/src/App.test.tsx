import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { loadFixtureReplay } from "./data/fixture";
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
});
