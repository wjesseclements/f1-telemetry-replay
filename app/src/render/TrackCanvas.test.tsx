/**
 * TrackCanvas tests — the architecture rules, made mechanical.
 *
 * These assert on what the loop actually painted (via a recording 2D context) and
 * on how many times React committed, because that is where rule 1 either holds or
 * quietly stops holding. A test that only checked "a canvas element exists" would
 * pass with the clock in `useState`.
 */
import { Profiler } from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME_DT_S } from "../engine/clock";
import {
  applyTransform,
  fitTransform,
  rotateWorld,
  type Point,
} from "../engine/geometry";
import { sampleAt } from "../engine/interpolate";
import { loadFixtureReplay } from "../data/fixture";
import { useTransport } from "../store/transport";
import {
  installCanvasEnvironment,
  installRafDriver,
  type DrawCall,
  type RafDriver,
  type RecordingContext,
} from "../test/canvas";
import { buildScene } from "./scene";
import { PAD_PX, TrackCanvas } from "./TrackCanvas";

const WIDTH = 800;
const HEIGHT = 600;
const replay = loadFixtureReplay();
const car = replay.cars[0];
const scene = buildScene(replay);
const fit = fitTransform(scene.bounds, WIDTH, HEIGHT, PAD_PX);

/** Where the marker for `car` belongs on screen at a given clock. */
function expectedMarker(clock: number): Point {
  const snapshots = sampleAt(replay, clock);
  const [rotated] = rotateWorld(snapshots, replay.meta.rotation);
  return applyTransform(rotated, fit);
}

/** Split a recording into frames — each frame begins with a `clearRect`. */
function frames(calls: readonly DrawCall[]): DrawCall[][] {
  const out: DrawCall[][] = [];
  for (const call of calls) {
    if (call.method === "clearRect") out.push([]);
    if (out.length > 0) out[out.length - 1].push(call);
  }
  return out;
}

const lastFrame = (recording: RecordingContext): DrawCall[] => {
  const all = frames(recording.calls);
  return all[all.length - 1];
};

/**
 * Car marker positions in one frame, identified by the car's own colour — the
 * glowing dot is the only thing filled in it.
 */
function markers(frame: DrawCall[]): Point[] {
  return frame
    .filter(
      (c) =>
        c.method === "arc" &&
        c.fillStyle.toLowerCase() === car.color.toLowerCase(),
    )
    .map((c) => ({ x: c.args[0], y: c.args[1] }));
}

/** The heading tick: a `moveTo` → `lineTo` → `stroke` run of exactly one segment. */
function headingTick(frame: DrawCall[]): { from: Point; to: Point } {
  for (let i = 0; i < frame.length - 2; i++) {
    if (
      frame[i].method === "moveTo" &&
      frame[i + 1].method === "lineTo" &&
      frame[i + 2].method === "stroke"
    ) {
      return {
        from: { x: frame[i].args[0], y: frame[i].args[1] },
        to: { x: frame[i + 1].args[0], y: frame[i + 1].args[1] },
      };
    }
  }
  throw new Error("no heading tick drawn");
}

const angleOf = (from: Point, to: Point): number =>
  Math.atan2(to.y - from.y, to.x - from.x);

let recording: RecordingContext;
let raf: RafDriver;

beforeEach(() => {
  recording = installCanvasEnvironment(WIDTH, HEIGHT);
  raf = installRafDriver();
  useTransport.setState({
    replay,
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

describe("TrackCanvas", () => {
  it("draws the track ribbon and one marker per car on the first frame", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();

    const frame = lastFrame(recording);
    // The ribbon is the full lap: one lineTo per sample after the opening moveTo.
    const ribbonSegments = frame.filter(
      (c) => c.method === "lineTo" && c.lineWidth !== 2,
    );
    expect(ribbonSegments).toHaveLength(car.samples.length - 1);
    expect(frame.some((c) => c.method === "closePath")).toBe(true);

    // One marker per car, at the start/finish line at clock 0 — no count
    // special-casing, the loop just iterates the array.
    const drawn = markers(frame);
    expect(drawn).toHaveLength(replay.cars.length);
    const start = expectedMarker(0);
    expect(drawn[0].x).toBeCloseTo(start.x, 6);
    expect(drawn[0].y).toBeCloseTo(start.y, 6);
  });

  it("advances the clock by dt * speedMult while playing", () => {
    render(<TrackCanvas replay={replay} />);

    raf.tick(); // first frame: no previous timestamp, so no elapsed time
    expect(markers(lastFrame(recording))[0].x).toBeCloseTo(
      expectedMarker(0).x,
      6,
    );

    raf.tick(100);
    raf.tick(100);
    const at = markers(lastFrame(recording))[0];
    const want = expectedMarker(0.2);
    expect(at.x).toBeCloseTo(want.x, 6);
    expect(at.y).toBeCloseTo(want.y, 6);
    // And it has actually moved — a frozen clock would also match `expectedMarker`
    // if the expectation were wrong.
    expect(at.x).not.toBeCloseTo(expectedMarker(0).x, 3);
  });

  it("scales with speedMult without rescaling time already elapsed", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    raf.tick(100); // 0.1 s at 1x

    useTransport.getState().setSpeedMult(4);
    raf.tick(100); // + 0.4 s

    const at = markers(lastFrame(recording))[0];
    const want = expectedMarker(0.5);
    expect(at.x).toBeCloseTo(want.x, 6);
    expect(at.y).toBeCloseTo(want.y, 6);
  });

  it("does not advance while paused, and resumes without a jump", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    raf.tick(100);

    useTransport.getState().pause();
    const beforePause = markers(lastFrame(recording))[0];
    raf.tick(5000);
    raf.tick(5000);
    const whilePaused = markers(lastFrame(recording))[0];
    expect(whilePaused.x).toBeCloseTo(beforePause.x, 9);
    expect(whilePaused.y).toBeCloseTo(beforePause.y, 9);

    // Ten seconds of pause must not be banked and spent on the first frame back.
    useTransport.getState().play();
    raf.tick(100);
    const resumed = markers(lastFrame(recording))[0];
    const want = expectedMarker(0.2);
    expect(resumed.x).toBeCloseTo(want.x, 6);
    expect(resumed.y).toBeCloseTo(want.y, 6);
  });

  it("clamps a long frame gap so a backgrounded tab does not teleport", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();

    raf.tick(30_000); // tab hidden for 30 s of a 58.5 s lap
    const at = markers(lastFrame(recording))[0];
    const want = expectedMarker(MAX_FRAME_DT_S);
    expect(at.x).toBeCloseTo(want.x, 6);
    expect(at.y).toBeCloseTo(want.y, 6);
  });

  it("wraps at the end of the lap instead of running off the grid", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();

    useTransport.getState().seek(replay.meta.duration - 0.05);
    // The seek lands at 58.45 and the same frame advances 0.1 s on top of it,
    // carrying the clock 0.05 s past the end of the lap.
    raf.tick(100);

    const at = markers(lastFrame(recording))[0];
    const want = expectedMarker(0.05);
    expect(at.x).toBeCloseTo(want.x, 6);
    expect(at.y).toBeCloseTo(want.y, 6);
  });

  it("applies a pending seek and clears it, even while paused", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    useTransport.getState().pause();

    useTransport.getState().seek(29.25);
    raf.tick(16);

    expect(useTransport.getState().seekTarget).toBeNull();
    const at = markers(lastFrame(recording))[0];
    const want = expectedMarker(29.25);
    expect(at.x).toBeCloseTo(want.x, 6);
    expect(at.y).toBeCloseTo(want.y, 6);
  });

  it("points the heading tick along the direction of travel ON SCREEN", () => {
    // The world-vs-screen heading pin. At the fixture's -14 deg rotation an
    // unadjusted world heading is off by a constant 14 deg — invisible to any
    // assertion about where the marker is, so this measures the tick against the
    // marker's own screen-space displacement.
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    raf.tick(16);
    const first = markers(lastFrame(recording))[0];

    raf.tick(16); // still inside the same 0.1 s sample segment
    const frame = lastFrame(recording);
    const second = markers(frame)[0];

    const travelled = angleOf(first, second);
    const tick = headingTick(frame);
    expect(angleOf(tick.from, tick.to)).toBeCloseTo(travelled, 6);
    // The tick starts at the car, not somewhere else.
    expect(tick.from.x).toBeCloseTo(second.x, 9);
    expect(tick.from.y).toBeCloseTo(second.y, 9);
  });

  it("never re-renders: no per-frame setState, no transport subscription", () => {
    let commits = 0;
    render(
      <Profiler id="track" onRender={() => commits++}>
        <TrackCanvas replay={replay} />
      </Profiler>,
    );
    expect(commits).toBe(1);

    for (let i = 0; i < 60; i++) raf.tick();
    // Transport changes are read by the loop, not subscribed to, so they must not
    // re-render the canvas either.
    useTransport.getState().pause();
    useTransport.getState().setSpeedMult(2);
    useTransport.getState().seek(10);
    useTransport.getState().play();
    for (let i = 0; i < 60; i++) raf.tick();

    expect(commits).toBe(1);
    // 120 frames painted, one React commit total.
    expect(frames(recording.calls).length).toBe(120);
  });

  it("keeps exactly one frame in flight and cancels it on unmount", () => {
    const view = render(<TrackCanvas replay={replay} />);
    expect(raf.pending()).toBe(1);
    raf.tick();
    raf.tick();
    expect(raf.pending()).toBe(1);

    view.unmount();
    expect(raf.pending()).toBe(0);
  });

  it("draws while paused, so a seek or resize repaints without resuming", () => {
    render(<TrackCanvas replay={replay} />);
    useTransport.getState().pause();
    raf.tick();
    const before = frames(recording.calls).length;
    raf.tick();
    expect(frames(recording.calls).length).toBe(before + 1);
  });
});
