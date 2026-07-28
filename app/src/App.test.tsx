import { Profiler } from "react";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SPEED_OPTIONS } from "./components/speedOptions";
import { HUD_HZ, telemetry } from "./telemetry/channel";
import sampleLap from "./engine/__fixtures__/sample-lap.json";
import { thermalGradientCss } from "./engine/color";
import { bootstrapReplay } from "./data/bootstrap";
import { FIXTURE_SOURCE, loadFixtureReplay } from "./data/fixture";
import { useTransport } from "./store/transport";
import {
  installCanvasEnvironment,
  installRafDriver,
  type DrawCall,
  type RecordingContext,
} from "./test/canvas";
import App from "./App";

const replay = loadFixtureReplay();

let recording: RecordingContext;

beforeEach(() => {
  recording = installCanvasEnvironment(800, 600);
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

/**
 * Integration guards — the claims that only hold once the whole tree is mounted.
 *
 * Each of these is about a relationship BETWEEN the pieces (the HUD's cadence versus
 * the canvas's render count, the scrubber versus playback state), which is exactly what
 * a component-level test cannot see.
 */
describe("App transport integration", () => {
  let raf: ReturnType<typeof installRafDriver>;

  beforeEach(() => {
    telemetry.reset();
    raf = installRafDriver();
    useTransport.setState({
      replay,
      isPlaying: true,
      speedMult: 1,
      seekTarget: null,
    });
  });

  const speedText = () =>
    screen.getByLabelText("Telemetry").querySelector("dd")?.textContent ?? "";

  /** Draw calls of the most recently painted frame (each frame opens a clearRect). */
  const lastFrame = (): DrawCall[] => {
    const frames: DrawCall[][] = [];
    for (const call of recording.calls) {
      if (call.method === "clearRect") frames.push([]);
      if (frames.length > 0) frames[frames.length - 1].push(call);
    }
    return frames[frames.length - 1] ?? [];
  };

  /** The car marker, identified by the car's own colour. */
  const markerOf = (frame: DrawCall[]) => {
    const arc = frame.find(
      (c) =>
        c.method === "arc" &&
        c.fillStyle.toLowerCase() === replay.cars[0].color.toLowerCase(),
    );
    if (!arc) throw new Error("no car marker drawn");
    return { x: arc.args[0], y: arc.args[1] };
  };

  it("renders at the HUD's cadence, not at frame rate", () => {
    // A Profiler here wraps the WHOLE App subtree, so it counts the HUD's own
    // re-renders too — it cannot isolate the canvas. TrackCanvas's `commits === 1` is
    // pinned where it can be measured properly, in TrackCanvas.test.tsx. What this adds
    // is the complementary claim only visible from here: across 120 frames React
    // commits on the order of the 30 Hz cadence, never once per frame.
    let commits = 0;
    render(
      <Profiler id="app" onRender={() => commits++}>
        <App />
      </Profiler>,
    );

    act(() => raf.tick());
    const first = speedText();
    const commitsAfterMount = commits;

    const FRAMES = 120;
    const FRAME_MS = 16;
    act(() => {
      for (let i = 0; i < FRAMES; i++) raf.tick(FRAME_MS);
    });

    // The HUD did move — without this, a HUD wired to nothing would also pass below.
    expect(speedText()).not.toBe(first);
    expect(speedText()).not.toBe("");

    const rendered = commits - commitsAfterMount;
    const ceiling = Math.ceil((FRAMES * FRAME_MS) / (1000 / HUD_HZ)) + 2;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThanOrEqual(ceiling);
    // The number that matters: nowhere near one commit per frame.
    expect(rendered).toBeLessThan(FRAMES);
  });

  it("keeps the HUD at or below the 30fps ceiling, not at frame rate", () => {
    render(<App />);
    let emits = 0;
    telemetry.subscribe(() => emits++);

    act(() => {
      for (let i = 0; i < 120; i++) raf.tick(16); // ~1.92 s of frames
    });

    expect(emits).toBeGreaterThan(0);
    expect(emits).toBeLessThanOrEqual(
      Math.ceil((120 * 16) / (1000 / HUD_HZ)) + 1,
    );
    expect(emits).toBeLessThan(120);
  });

  it("repaints the canvas when scrubbed while paused", () => {
    // Free, because the loop draws every frame — but pinned so the free behaviour
    // cannot silently break.
    render(<App />);
    act(() => raf.tick());
    // Inside `act`: pausing is a store write, and TransportBar subscribes to it, so an
    // unwrapped call re-renders outside React's batching and warns.
    act(() => {
      useTransport.getState().pause();
    });

    const slider = screen.getByRole("slider");
    act(() => {
      fireEvent.change(slider, { target: { value: "30" } });
    });
    const before = markerOf(lastFrame());
    act(() => raf.tick(16));

    // The loop consumed the seek and DREW at the new position, still paused. The
    // evidence is the canvas, not the HUD: the HUD is rate-limited and may still be
    // showing the previous value one frame later, which is by design.
    expect(useTransport.getState().seekTarget).toBeNull();
    expect(useTransport.getState().isPlaying).toBe(false);
    const after = markerOf(lastFrame());
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(
      1,
    );

    // And it stays there — paused means paused.
    act(() => raf.tick(16));
    const settled = markerOf(lastFrame());
    expect(settled.x).toBeCloseTo(after.x, 9);
  });

  it("resumes from the released position after a scrub during playback", () => {
    // Requirement: no snap-back, no pause-on-scrub-end.
    render(<App />);
    act(() => raf.tick());

    const slider = screen.getByRole("slider");
    act(() => {
      fireEvent.pointerDown(slider);
      fireEvent.change(slider, { target: { value: "40" } });
      fireEvent.pointerUp(window);
    });
    // 40 ms, not 16: the channel is rate-limited to 30 Hz, so a 16 ms frame lands
    // inside the window and the HUD legitimately has not caught up yet.
    act(() => raf.tick(40)); // loop applies the seek exactly
    expect(telemetry.getSnapshot().clock).toBeCloseTo(40, 6);

    // Still playing — scrubbing never touched playback state.
    expect(useTransport.getState().isPlaying).toBe(true);

    act(() => raf.tick(100));
    // Carried on FROM 40, rather than snapping back to where it was before the drag.
    expect(telemetry.getSnapshot().clock).toBeGreaterThan(40);
    expect(telemetry.getSnapshot().clock).toBeCloseTo(40.1, 6);
  });

  it("drives playback from the keyboard", () => {
    render(<App />);
    act(() => raf.tick());

    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    expect(useTransport.getState().isPlaying).toBe(false);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    act(() => raf.tick(40)); // clears the 30 Hz window so the HUD reflects the seek
    expect(telemetry.getSnapshot().clock).toBeCloseTo(1, 6);
  });

  it("gives every control an accessible name", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restart lap" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("slider", { name: "Lap position" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Playback speed" }),
    ).toBeInTheDocument();
    for (const rate of SPEED_OPTIONS) {
      expect(
        screen.getByRole("button", { name: `${rate}x speed` }),
      ).toBeInTheDocument();
    }
  });

  it("marks the active speed with aria-pressed", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "1x speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "4x speed" }));
    });
    expect(useTransport.getState().speedMult).toBe(4);
    expect(screen.getByRole("button", { name: "4x speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "1x speed" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("App reduced motion", () => {
  it("starts paused but fully operable", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.resetModules();

    const { useTransport: freshTransport } = await import("./store/transport");
    expect(freshTransport.getState().isPlaying).toBe(false);

    // ...and the controls still work: reduced motion disables the autoplay, not the
    // feature.
    freshTransport.getState().play();
    expect(freshTransport.getState().isPlaying).toBe(true);
    freshTransport.getState().seek(12);
    expect(freshTransport.getState().seekTarget).toBe(12);
  });
});
