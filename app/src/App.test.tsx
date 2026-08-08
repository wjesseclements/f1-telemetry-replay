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
import { TrackCanvas } from "./render/TrackCanvas";
import { parseGalleryManifest } from "./engine/gallery";
import galleryManifest from "./gallery/manifest.json";

const SCENARIOS = parseGalleryManifest(galleryManifest).scenarios;

/**
 * How a real gallery asset is served.
 *
 * The content-type is load-bearing, not decoration: `loadGalleryReplay` rejects a
 * non-JSON 200 as a missing asset, because that is what an SPA host returns for a
 * path that is not there. A bare `new Response(string)` defaults to text/plain and
 * would be treated as missing — correctly.
 */
const JSON_OK = { headers: { "content-type": "application/json" } };

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
      const button = screen.getByRole("button", { name: `${rate}× speed` });
      expect(button).toBeInTheDocument();
      // WCAG 2.5.3 Label in Name: the accessible name must CONTAIN the visible text,
      // so voice control can act on what a user can read. The visible `×` is a
      // multiplication sign, and a name spelt with the letter `x` fails that even
      // though it reads identically. Asserted against the DOM's own text rather than
      // a second literal, so the two cannot drift apart again (Slice 7).
      expect(button.getAttribute("aria-label")).toContain(button.textContent);
    }
  });

  it("marks the active speed with aria-pressed", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "1× speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "4× speed" }));
    });
    expect(useTransport.getState().speedMult).toBe(4);
    expect(screen.getByRole("button", { name: "4× speed" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "1× speed" })).toHaveAttribute(
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

describe("the featured-replay gallery", () => {
  let raf: ReturnType<typeof installRafDriver>;

  beforeEach(() => {
    telemetry.reset();
    raf = installRafDriver();
    useTransport.setState({
      replay,
      isPlaying: true,
      speedMult: 1,
      seekTarget: null,
      focusedCarIndex: 0,
    });
  });

  const toggle = () =>
    screen.getByRole("button", { name: /featured replays/i });
  const panel = () => screen.queryByRole("dialog");
  const cardFor = (title: string) =>
    screen.getByRole("button", { name: new RegExp(escapeRe(title)) });
  const firstCard = () => cardFor(SCENARIOS[0].title);

  /** Draw calls of the most recently painted frame. */
  const lastFrame = (): DrawCall[] => {
    const frames: DrawCall[][] = [];
    for (const call of recording.calls) {
      if (call.method === "clearRect") frames.push([]);
      if (frames.length > 0) frames[frames.length - 1].push(call);
    }
    return frames[frames.length - 1] ?? [];
  };

  const markerOf = (frame: DrawCall[]) => {
    const arc = frame.find(
      (c) =>
        c.method === "arc" &&
        c.fillStyle.toLowerCase() === replay.cars[0].color.toLowerCase(),
    );
    if (!arc) throw new Error("no car marker drawn");
    return { x: arc.args[0], y: arc.args[1] };
  };

  it("opens on first paint, because the boot fixture sells nothing", () => {
    render(<App />);
    expect(panel()).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("renders every manifest scenario as a real button", () => {
    render(<App />);
    // Real <button>s, not clickable divs: native activation and tab order for free.
    for (const scenario of SCENARIOS) {
      const card = cardFor(scenario.title);
      expect(card.tagName).toBe("BUTTON");
      expect(card).toHaveAccessibleName(
        new RegExp(escapeRe(scenario.hook.slice(0, 24))),
      );
      // Provenance is on the card, not buried in a tooltip.
      expect(card).toHaveAccessibleName(
        new RegExp(escapeRe(scenario.provenance.session)),
      );
    }
  });

  it("moves focus to the recommended scenario on open", () => {
    render(<App />);
    // One Enter away: the first card is the recommended action.
    expect(document.activeElement).toBe(firstCard());
  });

  it("labels the panel so a screen reader announces what opened", () => {
    render(<App />);
    expect(panel()).toHaveAccessibleName(/start here/i);
    expect(toggle()).toHaveAttribute("aria-controls", panel()!.id);
  });

  // The three close routes, each asserted on document.activeElement. This is the
  // behaviour that silently rots, and the one a keyboard reviewer notices first.
  it("returns focus to the toggle when closed by the close button", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

    expect(panel()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("returns focus to the toggle when closed by Escape", () => {
    render(<App />);
    fireEvent.keyDown(panel()!, { key: "Escape" });

    expect(panel()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());
  });

  it("returns focus to the toggle when a scenario is chosen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sampleLap), JSON_OK)),
    );
    render(<App />);

    await act(async () => {
      fireEvent.click(firstCard());
    });

    expect(panel()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(toggle());
  });

  it("reopens from the same control it closed from", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(panel()).not.toBeInTheDocument();

    fireEvent.click(toggle());

    expect(panel()).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("applies the scenario's suggested focus, clock and speed", async () => {
    // Scenario 1 (the finale) is used deliberately: its suggested clock is 20 s,
    // which is INSIDE the 58.5 s fixture served here, so this exercises the
    // pass-through. Scenario 0's real clock is 237 s and exercises the clamp — see
    // the next test. Between them both branches are covered with real manifest data
    // rather than a synthetic scenario.
    const scenario = SCENARIOS[1];
    // A two-car payload, so a resolved non-zero focus is distinguishable from the
    // reset to 0 that `setReplay` performs.
    const twoCar = structuredClone(sampleLap) as typeof sampleLap;
    const second = structuredClone(twoCar.cars[0]);
    second.driver = scenario.suggested.driver;
    (twoCar.cars as unknown[]).push(second);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(twoCar), JSON_OK)),
    );
    render(<App />);

    await act(async () => {
      fireEvent.click(cardFor(scenario.title));
    });

    const state = useTransport.getState();
    expect(state.replay?.cars).toHaveLength(2);
    // Resolved from the driver CODE and applied AFTER setReplay's reset to 0.
    expect(state.focusedCarIndex).toBe(1);
    expect(state.speedMult).toBe(scenario.suggested.speedMult);
    expect(state.seekTarget).toBe(scenario.suggested.clock);
    expect(scenario.suggested.clock).toBeGreaterThan(0);
  });

  it("clamps a suggested clock the payload is too short for", async () => {
    // Drift, degrading rather than throwing. Scenario 0 suggests 237 s; the fixture
    // served here is 58.5 s. Seeking past the end would freeze the visitor on the
    // final frame — silently — so the resolver lands them at the start instead.
    // The real asset IS long enough; `galleryAssets.test.ts` asserts that pairing
    // separately, which is what keeps this from hiding a genuine mismatch.
    const scenario = SCENARIOS[0];
    expect(scenario.suggested.clock).toBeGreaterThan(replay.meta.duration);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(sampleLap), JSON_OK)),
    );
    render(<App />);

    await act(async () => {
      fireEvent.click(cardFor(scenario.title));
    });

    expect(useTransport.getState().seekTarget).toBe(0);
  });

  it("keeps the current replay and the picker when a scenario fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("nope", { status: 500, statusText: "Boom" }),
      ),
    );
    render(<App />);
    const before = useTransport.getState().replay;

    await act(async () => {
      fireEvent.click(firstCard());
    });

    // Degrade, never blank: the lap on screen survives, the message is shown, the
    // panel stays open to try another, and the other way in still works.
    expect(useTransport.getState().replay).toBe(before);
    expect(screen.getByRole("alert").textContent).toMatch(/500/);
    expect(panel()).toBeInTheDocument();
    // The CONTROL, not merely the words — the panel's footer mentions it too.
    const picker = screen.getByLabelText("Load replay JSON");
    expect(picker).toBeEnabled();
  });

  it("keeps the replay animating behind the panel, uninterrupted", () => {
    // The refinement that made this an overlay rather than a replacement: motion
    // behind the scrim says "this is alive". A toggle must not remount the canvas
    // or reset its clock, which is what `memo(TrackCanvas)` buys.
    render(<App />);
    const canvasBefore = document.querySelector("canvas");

    act(() => raf.tick());
    act(() => {
      for (let i = 0; i < 20; i++) raf.tick(16);
    });
    const before = markerOf(lastFrame());

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    act(() => {
      for (let i = 0; i < 20; i++) raf.tick(16);
    });
    const after = markerOf(lastFrame());

    // The same DOM node: no remount, so the rAF loop and the clock ref survived.
    expect(document.querySelector("canvas")).toBe(canvasBefore);
    // And it kept moving across the toggle rather than restarting at the line.
    expect(after).not.toEqual(before);
  });

  it("exports the canvas memoised, which is what makes the bailout possible", () => {
    // Structural, and paired with the behavioural test above rather than standing
    // in for it: without `memo`, App's panel state re-renders the canvas on every
    // open and close.
    expect((TrackCanvas as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });
});

/** Escape a manifest string for use inside a RegExp. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
