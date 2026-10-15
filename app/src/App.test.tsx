import { Profiler } from "react";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  COMPACT_FOCUS_RING,
  COMPACT_PEER_FOCUS_RING,
} from "./components/focus";
import { SPEED_OPTIONS } from "./components/speedOptions";
import { TOUCH_TARGET } from "./components/touchTarget";
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
import { COMPACT_QUERY } from "./components/compactLayout";
import { PHONE_QUERY } from "./components/phoneLayout";
import { TrackCanvas } from "./render/TrackCanvas";
import { parseGalleryManifest } from "./engine/gallery";
import { parseReplay } from "./engine/load";
import { resolveLore } from "./engine/lore";
import galleryManifest from "./gallery/manifest.json";
import { LORE } from "./lore";

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

  it("says how to load a lap when none is loaded, in the ruled words", () => {
    // The human's copy (ruled 2026-10-13), held verbatim so it cannot drift:
    // on a compact screen the picker is an icon, so the words say which one.
    render(<App />);
    const line = screen.getByText(/^No replay loaded\./);
    expect(line.textContent).toBe(
      "No replay loaded. Open a lap with Load replay JSON above (the folder icon on small screens): any file the pipeline built.",
    );
    expect(
      within(line).getByText("Load replay JSON", { selector: "span" }),
    ).toHaveClass("text-txt");
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

  it("keeps the replay's meta line to one line on a wide or short screen, all of it in the DOM", () => {
    // Slice 25: every driver code is in this line, so a full field wrapped the
    // header to 106–138 px and the track paid for it (22 cars: 200 px of track at
    // 375x667, 117–127 px stacked on landscape phones). `onerow:` is a screen 5:4
    // or wider, at most 700 px tall, OR an upright phone whose header is a thin
    // row (Slice 27; at any height since 2026-10-13, so 375x812 and 390x844
    // too). The ellipsis is visual only: the whole line stays in the DOM. jsdom
    // applies no media query, so this pins the classes; the layout check measures
    // the geometry, and `layoutVariants.test.ts` the compiled query.
    useTransport.setState({ replay });
    render(<App />);
    const line = screen.getByText(
      new RegExp(`${replay.meta.event}.*${replay.cars[0].driver}`),
    );
    expect(line).toHaveClass(
      "onerow:min-w-24",
      "onerow:flex-1",
      "onerow:truncate",
    );
    expect(line).toHaveTextContent(
      `${replay.meta.event} · ${replay.meta.session} · ${replay.cars
        .map((car) => car.driver)
        .join(" ")}`,
    );
  });

  it("drops the meta line's one-line floor on a compact screen, so the thin header stays one row (Slice 27)", () => {
    // Every `compact:` screen is also `onerow:`, and there the line's 6rem floor
    // would hold beside the title and the two 44 px icon boxes: at 360x640 the
    // header wrapped from 44 to 96 px and the track fell to exactly the layout
    // check's 200 px floor, passing it by 0.0 px (measured in Chrome, Slice 27's
    // review). So nothing else would catch the class going: pinned here on the
    // element, and `layoutVariants.test.ts` pins that its compiled rule comes
    // after the floor's, so it wins where both match.
    useTransport.setState({ replay });
    render(<App />);
    const line = screen.getByText(
      new RegExp(`${replay.meta.event}.*${replay.cars[0].driver}`),
    );
    expect(line).toHaveClass("onerow:min-w-24", "compact:min-w-0");
  });

  it("makes the header one 44 px row on a compact screen: no vertical padding, a smaller title (Slice 27)", () => {
    // The row is one control tall because the header drops `py-3` (12 px above
    // and below) and the title shrinks to fit beside the two icon boxes.
    // Without the padding the header measured 68 px instead of 44, and still
    // nothing failed: the canvas floor the layout check gates has room to spare
    // at most gated sizes (Slice 27's review). jsdom applies no media query, so
    // the classes are pinned; `layoutVariants.test.ts` pins what they compile to.
    useTransport.setState({ replay });
    render(<App />);
    const title = screen.getByRole("heading", { name: /telemetry replay/i });
    expect(title.closest("header")).toHaveClass("compact:py-0");
    expect(title).toHaveClass("compact:text-xs");
  });

  it("keeps the header's two controls' names, and 44 px targets, behind their compact-screen icons (Slice 27)", () => {
    // On a compact screen (`compact:`) each label is swapped for a decorative icon,
    // and the label stays in the DOM as `sr-only`: the accessible name a screen
    // reader announces and voice control matches is the text it always was. The
    // box keeps the ruled 44 px floor and draws its focus ring inside (it touches
    // the top of the screen there). jsdom applies no media query, so this pins
    // the classes and the names; the boxes are measured in a real browser
    // (Slice 27's PLAN entry).
    useTransport.setState({ replay });
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Featured replays" });
    const label =
      screen.getByLabelText<HTMLInputElement>("Load replay JSON").labels![0];
    for (const control of [toggle, label]) {
      const icon = control.querySelector("svg");
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveClass("hidden", "compact:block");
      expect(control.querySelector("span")).toHaveClass("compact:sr-only");
      expect(control).toHaveClass(...TOUCH_TARGET.split(" "));
    }
    expect(toggle).toHaveClass(...COMPACT_FOCUS_RING.split(" "));
    expect(label).toHaveClass(...COMPACT_PEER_FOCUS_RING.split(" "));
    // The thin header still wraps: Slice 26's draft stopped it wrapping and kept
    // the picker from shrinking, and a failed load's error box then pushed a
    // 375 px page to 637 px wide (measured in Chrome, Slice 27). Not gated by the
    // layout check, which never fails a load, so it is pinned here. (The
    // matchers avoid spelling the utility out, from when Tailwind scanned test
    // files and shipped a rule for whatever they named; it no longer does.)
    const header = toggle.closest("header")!;
    expect(header).toHaveClass("flex-wrap");
    const compactNoWrap = header.className
      .split(" ")
      .filter((c) => c.startsWith("compact:") && c.endsWith("nowrap"));
    expect(compactNoWrap).toEqual([]);
    const picker = label.parentElement!.parentElement!;
    expect(picker.className.split(" ")).not.toContain("compact:shrink-0");
  });

  it("repeats each icon button's label verbatim as a tooltip, only where the label is hidden (Slice 27)", () => {
    // Ruled 2026-10-12: on `compact:` screens the two header buttons are icons
    // with `sr-only` labels, so a mouse (a short desktop window) gets the label
    // as a `title`. Where the label shows, no `title`: it would only repeat it.
    // The answer comes from a `matchMedia` subscription (`useCompactLayout`),
    // which a rotation across the line flips; jsdom has no media queries, so
    // `matchMedia` is stubbed to answer the compact query.
    let compact = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return compact && query === COMPACT_QUERY;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
    useTransport.setState({ replay });
    render(<App />);
    const toggle = screen.getByRole("button", { name: "Featured replays" });
    const label =
      screen.getByLabelText<HTMLInputElement>("Load replay JSON").labels![0];
    const controls = [
      [toggle, "Featured replays"],
      [label, "Load replay JSON"],
    ] as const;
    for (const [control, text] of controls) {
      expect(control).toHaveAttribute("title", text);
      expect(control.querySelector("span")).toHaveTextContent(text);
    }
    // The names a screen reader announces are unchanged.
    expect(toggle).toHaveAccessibleName("Featured replays");
    expect(screen.getByLabelText("Load replay JSON")).toHaveAccessibleName(
      "Load replay JSON",
    );

    // Rotated out of `compact:`: the labels show, and the tooltips go.
    compact = false;
    act(() => listeners.forEach((l) => l()));
    for (const [control] of controls)
      expect(control).not.toHaveAttribute("title");
  });

  it("puts the header above the tower on the shortest landscape phones, the track the full height (Slice 27)", () => {
    // Ruled 2026-10-12: at most 320 px tall (`fulltrack:`; Safari's 724x257) the
    // page is a grid, the track cell spans its top two rows, and the header and
    // the tower share the second column. Across the top, the header left the
    // track 168 px there, under the layout check's 200 px floor; above the tower
    // it is 212. The meta line is dropped from view there (ruled; the tower lists
    // every driver), and stays in the DOM. jsdom applies no media query, so this
    // pins the classes; the layout check measures the geometry at 724x257, and
    // `layoutVariants.test.ts` what `fulltrack:` compiles to.
    //
    // The header's row may shrink below its content, and the header scrolls:
    // a failed load's error box wraps it to 264 px in the 256 px column, and
    // as a plain `auto` row that pushed the transport bar off a 257 px screen
    // (measured). No layout-check state fails a load, so this pin is its guard.
    useTransport.setState({ replay });
    const { container } = render(<App />);
    const main = container.querySelector("main")!;
    expect(main).toHaveClass(
      "fulltrack:grid",
      "fulltrack:grid-cols-[minmax(0,1fr)_16rem]",
      "fulltrack:grid-rows-[minmax(0,auto)_minmax(0,1fr)_auto]",
    );
    expect(main.querySelector(":scope > header")).toHaveClass(
      "fulltrack:col-start-2",
      "fulltrack:row-start-1",
      "fulltrack:px-1",
      "fulltrack:gap-x-1",
      "fulltrack:overflow-y-auto",
    );
    const trackCell =
      container.querySelector("canvas")!.parentElement!.parentElement!;
    expect(trackCell).toHaveClass(
      "fulltrack:col-start-1",
      "fulltrack:row-start-1",
      "fulltrack:row-span-2",
    );
    expect(trackCell.parentElement).toHaveClass("fulltrack:contents");
    expect(
      screen.getByRole("complementary", { name: "Telemetry" }),
    ).toHaveClass("fulltrack:col-start-2", "fulltrack:row-start-2");
    expect(
      screen.getByRole("region", { name: "Playback controls" }),
    ).toHaveClass("fulltrack:col-span-full", "fulltrack:row-start-3");
    const line = screen.getByText(
      new RegExp(`${replay.meta.event}.*${replay.cars[0].driver}`),
    );
    expect(line).toHaveClass("fulltrack:sr-only");
  });

  it("keeps the header across the top when no replay is laid out (Slice 27)", () => {
    // The error and the no-replay states have no tower for the header to sit
    // above. With the grid on `main` regardless, the error panel would fill the
    // first free cell, beside the header in the top row.
    for (const ui of [
      <App key="none" />,
      <App key="error" bootstrapError="x" />,
    ]) {
      const { container, unmount } = render(ui);
      const main = container.querySelector("main")!;
      const fullTrack = (el: Element) =>
        [...el.classList].filter((c) => c.startsWith("fulltrack:"));
      expect(fullTrack(main)).toEqual([]);
      expect(fullTrack(main.querySelector(":scope > header")!)).toEqual([]);
      unmount();
    }
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

  it("calls it a data problem, not a network one, in the ruled words", () => {
    // The human's copy (ruled 2026-10-13), held verbatim so it cannot drift. It
    // no longer says the app never fetches: the gallery does (Slice 17).
    render(<App bootstrapError={brokenBoot()} />);
    const explanation = within(screen.getByRole("alert")).getByText(
      /^The replay data does not match the schema\./,
    );
    expect(explanation.textContent).toBe(
      "The replay data does not match the schema. This is a data problem, not a network one. Each line above names the field that failed; rebuild the file with the pipeline, or open a different lap with Load replay JSON.",
    );
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

  it("seeks to the END at the end, through the real loop — keys and scrubber alike", () => {
    // Slice 23: the clock's domain is [0, duration) and the loop folds every seek
    // into it, so a seek to `duration` itself landed at 0. Shift+Right in the last
    // five seconds and the scrubber's right edge both asked for exactly that.
    const lastT = replay.cars[0].samples[replay.cars[0].samples.length - 1].t;
    render(<App />);
    act(() => raf.tick());
    act(() => {
      useTransport.getState().pause();
      useTransport.getState().seek(replay.meta.duration - 2);
    });
    act(() => raf.tick(40));

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    });
    act(() => raf.tick(40));
    expect(telemetry.getSnapshot().clock).toBe(lastT);

    act(() => {
      useTransport.getState().seek(10);
    });
    act(() => raf.tick(40));
    act(() => {
      fireEvent.change(screen.getByRole("slider"), {
        target: { value: String(replay.meta.duration) },
      });
    });
    act(() => raf.tick(40));
    expect(telemetry.getSnapshot().clock).toBe(lastT);
  });

  it("fires a scenario event past the end AT the end, through the real loop — End and playback alike", () => {
    // Slice 23 follow-up: ScenarioEvents clamped a late event to `duration`, which
    // the loop never holds, so the "narration survives the cut" promise could not be
    // kept by any seek or any playback. Its unit test published `clock = duration`
    // by hand; this one only lets the real loop publish.
    const lastT = replay.cars[0].samples[replay.cars[0].samples.length - 1].t;
    const lateCard = () => screen.queryByRole("dialog", { name: "LATE" });
    render(<App />);
    act(() => {
      useTransport.setState({
        isPlaying: false,
        scenario: {
          id: "late",
          title: "Late",
          hook: "h",
          file: "late.json",
          suggested: { driver: "VER", clock: 0, speedMult: 1 },
          provenance: {
            session: "S",
            laps: "1-2",
            drivers: ["VER"],
            generated: "2026-09-08",
          },
          events: [{ clock: 500, title: "LATE", body: "b" }],
        },
      });
      useTransport.getState().seek(10);
    });
    act(() => raf.tick(40)); // the first observed clock arms the detector

    // End: the last instant, and a crossing of the clamped mark.
    act(() => {
      fireEvent.keyDown(window, { key: "End" });
    });
    act(() => raf.tick(40));
    expect(telemetry.getSnapshot().clock).toBe(lastT);
    expect(lateCard()).toBeInTheDocument();
    act(() => lateCard()?.querySelector("button")?.click());
    expect(lateCard()).not.toBeInTheDocument();

    // Playback at 1x into the end at 60 Hz: back below the mark re-arms, and the
    // final grid step is ~6 frames and ~3 HUD emits wide — wide enough to be seen.
    act(() => useTransport.getState().seek(replay.meta.duration - 1));
    act(() => raf.tick(40));
    act(() => useTransport.getState().play());
    for (let i = 0; i < 120 && lateCard() === null; i++) {
      act(() => raf.tick(1000 / 60));
    }
    expect(lateCard()).toBeInTheDocument();
    expect(useTransport.getState().isPlaying).toBe(false); // it paused, at the end
    expect(telemetry.getSnapshot().clock).toBeGreaterThanOrEqual(lastT);
    expect(telemetry.getSnapshot().clock).toBeLessThan(replay.meta.duration);
  });

  it("fires it at 4x on a 30 Hz display too, where the final step is shorter than a HUD tick", () => {
    // The worst case measured for the lastInstant clamp alone: the final grid step
    // is 25 ms of real time at 4x and a 30 Hz display emits every 33 ms or more, so
    // the watcher saw 58.3 and then 0.1, and only 1 start phase in 20 fired. The
    // loop's wrap count turns that backward step into a crossing. The card is then
    // put back on the end rather than left over the window's start.
    const lastT = replay.cars[0].samples[replay.cars[0].samples.length - 1].t;
    const lateCard = () => screen.queryByRole("dialog", { name: "LATE" });
    render(<App />);
    act(() => {
      useTransport.setState({
        isPlaying: false,
        speedMult: 4,
        scenario: {
          id: "late",
          title: "Late",
          hook: "h",
          file: "late.json",
          suggested: { driver: "VER", clock: 0, speedMult: 4 },
          provenance: {
            session: "S",
            laps: "1-2",
            drivers: ["VER"],
            generated: "2026-09-08",
          },
          events: [{ clock: 500, title: "LATE", body: "b" }],
        },
      });
      useTransport.getState().seek(replay.meta.duration - 1);
    });
    act(() => raf.tick(40)); // arms
    act(() => useTransport.getState().play());
    let ticks = 0;
    for (; ticks < 60 && lateCard() === null; ticks++) {
      act(() => raf.tick(1000 / 30));
    }
    expect(lateCard()).toBeInTheDocument();
    expect(ticks).toBeLessThan(15); // on THIS pass, not a later one
    // The loop applies the card's seek. 40 ms clears the 30 Hz window, so the HUD
    // has caught up.
    act(() => raf.tick(40));
    expect(useTransport.getState().isPlaying).toBe(false);
    expect(telemetry.getSnapshot().clock).toBe(lastT);
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

  it("ends with the ruled footer: your own file, and the disclaimer", () => {
    // The human's copy (ruled 2026-10-13), held verbatim so it cannot drift:
    // on a compact screen the picker is an icon, so the words say which one.
    render(<App />);
    const footer = within(panel()!).getByText(/^Or build your own/);
    expect(footer.textContent).toBe(
      "Or build your own with the pipeline and open it with Load replay JSON (the folder icon on small screens). Unofficial project, not affiliated with Formula 1; data via FastF1 from the public timing feed.",
    );
    expect(
      within(footer).getByText("Load replay JSON", { selector: "span" }),
    ).toHaveClass("text-txt");
  });

  it("names the picker in the ruled words when a scenario cannot be reached", async () => {
    // The gallery's one network failure, as a visitor sees it: the message the
    // fetch layer returns, rendered in the panel. Its second line is the
    // human's copy (ruled 2026-10-13), pinned verbatim in
    // `loadGalleryReplay.test.ts`; here it is what reaches the screen.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<App />);

    await act(async () => {
      fireEvent.click(firstCard());
    });

    expect(screen.getByRole("alert").textContent).toBe(
      `Could not reach /gallery/${SCENARIOS[0].file}: Failed to fetch\nCheck your connection and try again, or load a file with Load replay JSON (the folder icon on small screens).`,
    );
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
    // Selected by PROPERTY, not position (Slice 17 reordered the manifest): a
    // scenario whose suggested clock is non-zero and INSIDE the 58.5 s fixture
    // served here, so this exercises the pass-through. The next test selects one
    // whose clock exercises the clamp. Between them both branches are covered
    // with real manifest data rather than a synthetic scenario.
    const scenario = SCENARIOS.find(
      (s) => s.suggested.clock > 0 && s.suggested.clock < replay.meta.duration,
    );
    if (scenario === undefined)
      throw new Error("manifest no longer carries an in-fixture clock");
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
    // Drift, degrading rather than throwing. A scenario suggesting a clock past
    // the 58.5 s fixture served here: seeking past the end would freeze the
    // visitor on the final frame — silently — so the resolver lands them at the
    // start instead. The real asset IS long enough; `galleryAssets.test.ts`
    // asserts that pairing separately, which is what keeps this from hiding a
    // genuine mismatch.
    const scenario = SCENARIOS.find(
      (s) => s.suggested.clock > replay.meta.duration,
    );
    if (scenario === undefined)
      throw new Error("manifest no longer carries a past-fixture clock");
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

  /**
   * On a phone the panel covers the whole screen, and it is MODAL there (Slice
   * 26, ruled 2026-10-12): the rest of the page is inert, so Tab and a screen
   * reader stay inside it. jsdom applies no inert behaviour and evaluates no
   * media query, so `matchMedia` is stubbed to answer the phone query and these
   * pin the attributes and their timing; what they do in a browser was measured
   * in headless Chrome (Slice 26's PLAN entry).
   */
  describe("on a phone, modal", () => {
    /** A `matchMedia` that answers the phone query, and can be rotated. */
    const stubPhone = (initial: boolean) => {
      let phone = initial;
      const listeners = new Set<() => void>();
      vi.stubGlobal("matchMedia", (query: string) => ({
        get matches() {
          return phone && query === PHONE_QUERY;
        },
        media: query,
        addEventListener: (_: string, l: () => void) => listeners.add(l),
        removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      }));
      return (next: boolean) => {
        phone = next;
        act(() => listeners.forEach((l) => l()));
      };
    };
    const background = () => [
      document.querySelector("main > header") as HTMLElement,
      screen.getByRole("complementary", { name: "Telemetry" }),
      screen.getByRole("region", { name: "Playback controls" }),
      document.querySelector("canvas") as HTMLElement,
    ];

    it("makes the page behind the panel inert, and says the panel is modal", () => {
      stubPhone(true);
      render(<App />);
      for (const el of background())
        expect(el.closest("[inert]")).not.toBeNull();
      expect(panel()!.closest("[inert]")).toBeNull();
      expect(panel()).toHaveAttribute("aria-modal", "true");
      // Focus still lands in the dialog on open.
      expect(document.activeElement).toBe(firstCard());
    });

    // Each close route, with the moment focus moves checked: the toggle must be
    // awake BEFORE it is focused, or a browser drops the focus on the body.
    const focusedAwake = () => {
      let awake: boolean | null = null;
      toggle().addEventListener(
        "focus",
        () => (awake = toggle().closest("[inert]") === null),
        { once: true },
      );
      return () => awake;
    };

    it("wakes the page, then returns focus to the toggle: Close", () => {
      stubPhone(true);
      render(<App />);
      const awake = focusedAwake();
      fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
      expect(awake()).toBe(true);
      expect(document.activeElement).toBe(toggle());
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("wakes the page, then returns focus to the toggle: Escape", () => {
      stubPhone(true);
      render(<App />);
      const awake = focusedAwake();
      fireEvent.keyDown(panel()!, { key: "Escape" });
      expect(awake()).toBe(true);
      expect(document.activeElement).toBe(toggle());
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("wakes the page, then returns focus to the toggle: a card", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(sampleLap), JSON_OK)),
      );
      stubPhone(true);
      render(<App />);
      const awake = focusedAwake();
      await act(async () => {
        fireEvent.click(firstCard());
      });
      expect(panel()).not.toBeInTheDocument();
      expect(awake()).toBe(true);
      expect(document.activeElement).toBe(toggle());
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });

    it("keeps the replay animating behind the modal panel, uninterrupted", () => {
      // The memoisation pin, on a phone: making the page inert is attributes on
      // DOM nodes, not a render of the canvas.
      stubPhone(true);
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

      expect(document.querySelector("canvas")).toBe(canvasBefore);
      expect(markerOf(lastFrame())).not.toEqual(before);
    });

    it("is not modal on a desktop: nothing inert, the page beside it usable", () => {
      stubPhone(false);
      render(<App />);
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(panel()).toHaveAttribute("aria-modal", "false");
    });

    it("follows a rotation across the line while the panel is open", () => {
      const rotate = stubPhone(true);
      render(<App />);
      expect(panel()).toHaveAttribute("aria-modal", "true");

      rotate(false);
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
      expect(panel()).toHaveAttribute("aria-modal", "false");

      rotate(true);
      for (const el of background())
        expect(el.closest("[inert]")).not.toBeNull();
    });
  });
});

/** Escape a manifest string for use inside a RegExp. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("the featured panel's data-artifact note (Slice 19: the restart discloses)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders NO artifact note — Slice 9m repaired the last disclosed defect", () => {
    // The disclosure history, closed: Slice 17 disclosed LEC's fabricated half-lap;
    // 9l froze the car and retired that note. Slice 19's second re-watch found the
    // next feed failure — per-car stuck-channel dropouts in the 2026 windows, COL's
    // phantom P1 at 1:52 — and the RESTART entry disclosed it until a screen could
    // ship. Slice 9m IS that screen: the dropouts are detected and their placement
    // bridged, so the note is retired and no scenario carries one. The rendering
    // branch stays covered in FeaturedPanel.note.test.tsx.
    const noted = SCENARIOS.filter((s) => s.provenance.note !== undefined);
    expect(noted.map((s) => s.id)).toEqual([]);
    useTransport.setState({ replay });
    render(<App />);
    expect(screen.queryByText(/telemetry feed drops/)).not.toBeInTheDocument();
  });
});

/**
 * Corner stories (Slice 18): the badges over the canvas open a card, and App owns
 * everything around it — which replay has stories, the pause, where focus goes,
 * and which dialog wins.
 *
 * The replay is the fixture wearing Monza's corner record (the lore file's own),
 * so it matches Monza's stories while every frame stays the fixture's: this
 * pins App's wiring, not the matching (`engine/lore.test.ts`,
 * `data/loreAssets.test.ts`). jsdom evaluates no `:has()`, so the badges stay
 * clickable under a dialog here; the layout check is what proves they are
 * hidden.
 */
describe("corner stories (Slice 18)", () => {
  const monza = LORE.find((circuit) => circuit.id === "monza");
  if (monza === undefined) throw new Error("no Monza lore");
  const loreReplay = parseReplay(
    {
      ...sampleLap,
      track: { ...sampleLap.track, corners: monza.layouts[0].corners },
    },
    "monza-cornered.json",
  );
  const STORIES = resolveLore(loreReplay.track.corners, LORE)?.stories ?? [];
  let raf: ReturnType<typeof installRafDriver>;

  beforeEach(() => {
    telemetry.reset();
    raf = installRafDriver();
    useTransport.setState({
      replay: loreReplay,
      isPlaying: true,
      speedMult: 1,
      seekTarget: null,
      focusedCarIndex: 0,
      scenario: null,
    });
  });

  const badge = (name: string) => screen.getByRole("button", { name });
  const card = () => document.getElementById("corner-card");
  const ALBORETO = "Turn 11: Curva Alboreto (Parabolica)";
  /** First paint opens the gallery; close it to reach the track. */
  const renderOnTrack = () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
  };
  const open = (name: string) => {
    act(() => {
      fireEvent.click(badge(name));
    });
    expect(card()).not.toBeNull();
  };

  it("finds the stories by the replay's corners: one named badge each, in lap order", () => {
    expect(STORIES).toHaveLength(7);
    renderOnTrack();
    const badges = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[id^="corner-story-"]'),
    );
    expect(badges.map((b) => b.id)).toEqual(
      STORIES.map((s) => `corner-story-${s.id}`),
    );
    expect(badges[0]).toHaveAccessibleName("Turns 1–2: Prima Variante");
    expect(badges[badges.length - 1]).toHaveAccessibleName(ALBORETO);
  });

  it("mounts the badges and every overlay dialog inside the one track cell they hide by", () => {
    // The badges hide by `:has([role=dialog])` on the track cell (`group/track`),
    // and `openStory` ignores a press while that cell holds a dialog, so a
    // dialog mounted anywhere else would leave them tabbable and pressable
    // under it.
    render(<App />);
    const cell = document.querySelector("canvas")?.closest(".group\\/track");
    expect(cell).not.toBeNull();
    expect(cell).toContainElement(screen.getByRole("dialog"));
    expect(cell).toContainElement(badge(ALBORETO));
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    open(ALBORETO);
    expect(cell).toContainElement(card());
  });

  it("gives a replay with no lore no badges at all: the page it always was", () => {
    useTransport.setState({ replay });
    render(<App />);
    expect(document.querySelectorAll('[id^="corner-story-"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Turn/ })).toBeNull();
  });

  it("opens the card from a badge: paused, named in the ruled format, Close focused", () => {
    renderOnTrack();
    expect(useTransport.getState().isPlaying).toBe(true);
    open(ALBORETO);
    expect(screen.getByRole("dialog", { name: ALBORETO })).toBe(card());
    expect(useTransport.getState().isPlaying).toBe(false);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("shows the card's heading, then Previous and Next, then the story (ruled 2026-10-15)", () => {
    renderOnTrack();
    open(ALBORETO);
    const dialog = screen.getByRole("dialog", { name: ALBORETO });
    // Tab order inside the card: Close, then the steps.
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Close", "Previous", "Next"]);
    const alboreto = STORIES[STORIES.length - 1];
    const story = within(dialog).getByText(alboreto.story);
    const inOrder = [
      within(dialog).getByRole("heading", { level: 2 }),
      within(dialog).getByRole("button", { name: "Previous" }),
      within(dialog).getByRole("button", { name: "Next" }),
      story,
    ];
    for (let i = 1; i < inOrder.length; i++) {
      expect(
        inOrder[i - 1].compareDocumentPosition(inOrder[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("closes from Close back to the badge it came from, still paused", () => {
    renderOnTrack();
    open(ALBORETO);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(card()).toBeNull();
    expect(badge(ALBORETO)).toHaveFocus();
    expect(useTransport.getState().isPlaying).toBe(false);
  });

  it("closes from Escape back to the badge", () => {
    renderOnTrack();
    open(ALBORETO);
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), {
      key: "Escape",
    });
    expect(card()).toBeNull();
    expect(badge(ALBORETO)).toHaveFocus();
  });

  it("hands focus to the badge of the story SHOWN, after Previous or Next", () => {
    renderOnTrack();
    open(ALBORETO);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(card()).toHaveAccessibleName("Turns 1–2: Prima Variante");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(badge("Turns 1–2: Prima Variante")).toHaveFocus();
  });

  it("closes when the gallery opens: one dialog at a time", () => {
    renderOnTrack();
    open(ALBORETO);
    fireEvent.click(screen.getByRole("button", { name: /featured replays/i }));
    expect(card()).toBeNull();
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "id",
      "featured-replays",
    );
  });

  it("closes when an event card fires: narration outranks lore", () => {
    renderOnTrack();
    act(() => {
      useTransport.setState({
        scenario: {
          id: "with-event",
          title: "With event",
          hook: "h",
          file: "with-event.json",
          suggested: { driver: "VER", clock: 0, speedMult: 1 },
          provenance: {
            session: "S",
            laps: "1-2",
            drivers: ["VER"],
            generated: "2026-09-08",
          },
          events: [{ clock: 30, title: "RED FLAG", body: "Narrated." }],
        },
      });
    });
    act(() => raf.tick(40)); // the first observed clock arms the detector
    open(ALBORETO);
    // The card paused playback; a seek past the mark (the transport bar works
    // beside a desktop card) is a crossing all the same.
    act(() => useTransport.getState().seek(35));
    act(() => raf.tick(40));
    expect(
      screen.getByRole("dialog", { name: "RED FLAG" }),
    ).toBeInTheDocument();
    expect(card()).toBeNull();
  });

  /**
   * jsdom evaluates no `:has()`, so here the badges stay pressable under a
   * dialog, which is exactly a browser without `:has()`: the JS guard alone
   * must keep it to one dialog.
   */
  describe("one dialog at a time, without `:has()` too", () => {
    const dialogIds = () =>
      screen.getAllByRole("dialog").map((dialog) => dialog.id);

    it("opens no card from a badge under the gallery, and leaves the replay playing", () => {
      render(<App />); // the gallery is open on first paint
      act(() => {
        fireEvent.click(badge(ALBORETO));
      });
      expect(card()).toBeNull();
      expect(dialogIds()).toEqual(["featured-replays"]);
      expect(useTransport.getState().isPlaying).toBe(true);
    });

    it("opens no second story from a badge under the corner card", () => {
      renderOnTrack();
      open(ALBORETO);
      act(() => {
        fireEvent.click(badge("Turns 1–2: Prima Variante"));
      });
      expect(dialogIds()).toEqual(["corner-card"]);
      expect(card()).toHaveAccessibleName(ALBORETO);
    });

    it("opens no card from a badge under an event card", () => {
      renderOnTrack();
      act(() => {
        useTransport.setState({
          scenario: {
            id: "with-event",
            title: "With event",
            hook: "h",
            file: "with-event.json",
            suggested: { driver: "VER", clock: 0, speedMult: 1 },
            provenance: {
              session: "S",
              laps: "1-2",
              drivers: ["VER"],
              generated: "2026-09-08",
            },
            events: [{ clock: 30, title: "RED FLAG", body: "Narrated." }],
          },
        });
      });
      act(() => raf.tick(40)); // the first observed clock arms the detector
      act(() => useTransport.getState().seek(35));
      act(() => raf.tick(40));
      expect(screen.getByRole("dialog", { name: "RED FLAG" })).toBeVisible();
      act(() => {
        fireEvent.click(badge(ALBORETO));
      });
      expect(card()).toBeNull();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
    });
  });

  it("drops the card when the replay changes under it", () => {
    renderOnTrack();
    open(ALBORETO);
    act(() => useTransport.setState({ replay }));
    expect(card()).toBeNull();
    // And it stays dropped when the stories come back.
    act(() => useTransport.setState({ replay: loreReplay }));
    expect(card()).toBeNull();
  });

  it("keeps the canvas mounted and its clock running across the card", () => {
    renderOnTrack();
    const canvasBefore = document.querySelector("canvas");
    act(() => {
      for (let i = 0; i < 20; i++) raf.tick(16);
    });
    const before = telemetry.getSnapshot().clock;
    open(ALBORETO);
    act(() => {
      for (let i = 0; i < 20; i++) raf.tick(16);
    });
    // Paused under the card: the clock holds where the badge was pressed.
    const held = telemetry.getSnapshot().clock;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeGreaterThanOrEqual(before);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    act(() => useTransport.getState().play());
    act(() => {
      for (let i = 0; i < 40; i++) raf.tick(16);
    });
    // Resumed from there, not from the line: no remount reset the clock.
    expect(document.querySelector("canvas")).toBe(canvasBefore);
    expect(telemetry.getSnapshot().clock).toBeGreaterThan(held);
  });

  describe("on a phone, modal", () => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query === PHONE_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    });

    it("holds the page inert under the card, then wakes it before focusing the badge", () => {
      renderOnTrack();
      open(ALBORETO);
      expect(card()).toHaveAttribute("aria-modal", "true");
      expect(
        document.querySelector("canvas")?.closest("[inert]"),
      ).not.toBeNull();
      expect(
        screen
          .getByRole("region", { name: "Playback controls" })
          .closest("[inert]"),
      ).not.toBeNull();

      const target = badge(ALBORETO);
      let awake: boolean | null = null;
      target.addEventListener(
        "focus",
        () => (awake = target.closest("[inert]") === null),
        { once: true },
      );
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(awake).toBe(true);
      expect(target).toHaveFocus();
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    });
  });
});
