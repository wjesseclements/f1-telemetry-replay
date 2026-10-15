/**
 * App.memo.test.tsx — the canvas stays memoised with corner stories (Slice 18).
 *
 * Since Slice 18 `App` hands the canvas two more props: the replay's corner
 * `stories` (memoised on the replay) and `onOpenStory` (a stable callback). If
 * either changed identity on App's own renders, every gallery toggle and every
 * Previous/Next would re-render the canvas, which `TrackCanvas.test.tsx` cannot
 * see: it renders the canvas alone. The badge layer renders exactly when the
 * canvas does (it is its child, not memoised), so its render count IS the
 * canvas's, read through a pass-through wrapper. Its own file, so the module
 * mock touches nothing else.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sampleLap from "./engine/__fixtures__/sample-lap.json";
import { parseReplay } from "./engine/load";
import { LORE } from "./lore";
import { useTransport } from "./store/transport";
import { telemetry } from "./telemetry/channel";
import { installCanvasEnvironment, installRafDriver } from "./test/canvas";
import App from "./App";

const layerRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("./render/CornerStoryTargets", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("./render/CornerStoryTargets")>();
  const { createElement, forwardRef } = await import("react");
  return {
    CornerStoryTargets: forwardRef<
      HTMLDivElement,
      Parameters<typeof real.CornerStoryTargets>[0]
    >(function Counted(props, ref) {
      layerRenders.count++;
      return createElement(real.CornerStoryTargets, { ...props, ref });
    }),
  };
});

const monza = LORE.find((circuit) => circuit.id === "monza");
if (monza === undefined) throw new Error("no Monza lore");
const loreReplay = parseReplay(
  {
    ...sampleLap,
    track: { ...sampleLap.track, corners: monza.layouts[0].corners },
  },
  "monza-cornered.json",
);

let raf: ReturnType<typeof installRafDriver>;

beforeEach(() => {
  installCanvasEnvironment(800, 600);
  raf = installRafDriver();
  telemetry.reset();
  layerRenders.count = 0;
  useTransport.setState({
    replay: loreReplay,
    isPlaying: true,
    speedMult: 1,
    seekTarget: null,
    focusedCarIndex: 0,
    scenario: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the canvas with corner stories", () => {
  it("renders once per replay, whatever App's own state does", () => {
    render(<App />);
    expect(layerRenders.count).toBe(1);

    act(() => {
      for (let i = 0; i < 30; i++) raf.tick(16);
    });
    // The gallery closes and reopens; a corner card opens, steps and closes.
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Turn 11: Curva Alboreto (Parabolica)",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /featured replays/i }));
    act(() => {
      for (let i = 0; i < 30; i++) raf.tick(16);
    });
    expect(layerRenders.count).toBe(1);

    // A new replay is the one thing that renders it again.
    act(() =>
      useTransport.setState({
        replay: parseReplay(
          {
            ...sampleLap,
            track: { ...sampleLap.track, corners: monza.layouts[0].corners },
          },
          "again.json",
        ),
      }),
    );
    expect(layerRenders.count).toBe(2);
  });
});
