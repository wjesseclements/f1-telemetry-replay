/**
 * TrackCanvas tests — the architecture rules, made mechanical.
 *
 * These assert on what the loop actually painted (via a recording 2D context) and
 * on how many times React committed, because that is where rule 1 either holds or
 * quietly stops holding. A test that only checked "a canvas element exists" would
 * pass with the clock in `useState`.
 */
import { Profiler } from "react";
import { render, cleanup, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FRAME_DT_S } from "../engine/clock";
import { SPEED_BUCKETS, bucketColor, bucketOf } from "../engine/color";
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
  type PathSegment,
  type RafDriver,
  type RecordingContext,
} from "../test/canvas";
import { TRAIL_WIDTH } from "./trail";
import { CORNER_BADGE_RADIUS, TRACK_EDGE_WIDTH, buildScene } from "./scene";
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

/**
 * The heading tick: a `moveTo` → `lineTo` → `stroke` run in the CAR's colour.
 *
 * The colour is what identifies it. Start/finish, the corner leader lines and the
 * trail's head segment are all single-segment strokes too, and several of them are
 * drawn before the car — matching on shape alone finds the wrong one.
 */
function headingTick(frame: DrawCall[]): { from: Point; to: Point } {
  for (let i = 0; i < frame.length - 2; i++) {
    if (
      frame[i].method === "moveTo" &&
      frame[i + 1].method === "lineTo" &&
      frame[i + 2].method === "stroke" &&
      frame[i + 2].strokeStyle.toLowerCase() === car.color.toLowerCase()
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

/** One grid step either side of the asserted clock — the "off by a frame" case. */
const NEIGHBOUR_S = 0.1;

/**
 * Assert the last frame put the car exactly where `clock` says, and NOT where a
 * neighbouring clock would.
 *
 * The clock is unreachable from outside the loop by design, so the drawn marker is
 * the only observation of it. The negative half is what makes this an exactness
 * check rather than a tolerance check: a clock a frame past its target lands a
 * measurable distance away, so it fails instead of passing at 6 decimal places by
 * luck.
 */
function expectMarkerAt(clock: number): void {
  const at = markers(lastFrame(recording))[0];
  const want = expectedMarker(clock);
  expect(at.x).toBeCloseTo(want.x, 6);
  expect(at.y).toBeCloseTo(want.y, 6);

  for (const delta of [-NEIGHBOUR_S, NEIGHBOUR_S]) {
    const other = expectedMarker(clock + delta);
    expect(
      Math.hypot(at.x - other.x, at.y - other.y),
      `clock ${clock} must be distinguishable from ${clock + delta}`,
    ).toBeGreaterThan(1);
  }
}

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
    // The ribbon is a RETAINED Path2D now, not per-frame context calls, so the same
    // guarantee is asserted against the path that was stroked: the full lap, one
    // lineTo per sample after the opening moveTo, and closed.
    const ribbon = frame.find(
      (c) => c.method === "stroke" && c.lineWidth === TRACK_EDGE_WIDTH,
    )?.path;
    expect(ribbon).toBeDefined();
    expect(ribbon?.ops.filter((op) => op.method === "lineTo")).toHaveLength(
      car.samples.length - 1,
    );
    expect(ribbon?.ops.some((op) => op.method === "closePath")).toBe(true);

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
    raf.tick(100); // lands exactly on 58.45 — a seek frame does not advance
    expectMarkerAt(replay.meta.duration - 0.05);

    raf.tick(100); // now 0.05 s past the end of the lap
    expectMarkerAt(0.05);
  });

  it("lands a seek exactly on its target, not one frame past it", () => {
    // The clock is deliberately unreachable from outside the loop, so exactness
    // is asserted through the only thing it can be observed by: where the car was
    // painted. `expectMarkerAt` also rejects the neighbouring clocks, so "one
    // frame late" fails rather than passing inside a tolerance.
    render(<TrackCanvas replay={replay} />);
    raf.tick();

    useTransport.getState().setSpeedMult(4);
    useTransport.getState().seek(29.25);
    raf.tick(100); // at 4x this frame would otherwise carry 0.4 s past the target

    expect(useTransport.getState().seekTarget).toBeNull();
    expectMarkerAt(29.25);

    // The frame AFTER the seek resumes at full speed from the target.
    raf.tick(100);
    expectMarkerAt(29.25 + 0.4);
  });

  it("applies a pending seek and clears it, even while paused", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    useTransport.getState().pause();

    useTransport.getState().seek(29.25);
    raf.tick(16);

    expect(useTransport.getState().seekTarget).toBeNull();
    expectMarkerAt(29.25);
  });

  it("wraps a seek past the end of the lap, exactly", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    useTransport.getState().pause();

    useTransport.getState().seek(replay.meta.duration + 0.25);
    raf.tick(16);
    expectMarkerAt(0.25);

    // ...and a negative seek folds back from the end.
    useTransport.getState().seek(-0.25);
    raf.tick(16);
    expectMarkerAt(replay.meta.duration - 0.25);
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

    // Frames and store writes both run inside `act`, so any render they schedule
    // is flushed and counted before the assertion. Without it this test passes
    // even when the canvas subscribes to the store — the re-render just lands
    // too late to be seen.
    act(() => {
      for (let i = 0; i < 60; i++) raf.tick();
    });
    // Transport changes are read by the loop, not subscribed to, so they must not
    // re-render the canvas either.
    act(() => {
      useTransport.getState().pause();
      useTransport.getState().setSpeedMult(2);
      useTransport.getState().seek(10);
      useTransport.getState().play();
    });
    act(() => {
      for (let i = 0; i < 60; i++) raf.tick();
    });

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

/**
 * Trail tests — the signature, and the first thing here with real per-frame cost.
 *
 * Two halves, and both are needed. The BEHAVIOURAL half asserts the trail covers the
 * portion of the lap actually driven, in the right colours. The ALLOCATION half
 * asserts it costs nothing to keep doing so, and it is deliberately event-scoped: a
 * "never allocates" assertion would false-fail on every legitimate rebuild, and one
 * that only looked at the totals after a run would miss churn inside it.
 */
describe("TrackCanvas trail", () => {
  /** Cost of one `buildScenePaths`: the ribbon, plus a bucket path per car. */
  const PATHS_PER_BUILD = 1 + replay.cars.length * SPEED_BUCKETS;
  /** Cost of one trail reset: bucket paths only, no ribbon. */
  const PATHS_PER_RESET = replay.cars.length * SPEED_BUCKETS;

  /** Advance `count` grid steps (0.1 s each) from a freshly-mounted loop. */
  function advance(count: number): void {
    raf.tick(); // first frame measures no elapsed time
    for (let i = 0; i < count; i++) raf.tick(100);
  }

  /** Screen position of sample `k` — where a trail vertex belongs. */
  function samplePoint(k: number): Point {
    const [p] = rotateWorld(
      [{ x: car.samples[k].x, y: car.samples[k].y }],
      replay.meta.rotation,
    );
    return applyTransform(p, fit);
  }

  /** The batched trail strokes of a frame, by the colour each was painted in. */
  function trailByColor(frame: DrawCall[]): Map<string, PathSegment[]> {
    const out = new Map<string, PathSegment[]>();
    for (const call of frame) {
      if (call.method !== "stroke" || call.lineWidth !== TRAIL_WIDTH) continue;
      if (!call.path) continue;
      const segments = call.path.segments();
      if (segments.length > 0) out.set(call.strokeStyle, segments);
    }
    return out;
  }

  const trailSegmentCount = (frame: DrawCall[]): number =>
    [...trailByColor(frame).values()].reduce((n, s) => n + s.length, 0);

  it("paints the covered portion of the lap, bucketed by speed", () => {
    render(<TrackCanvas replay={replay} />);
    advance(30); // clock 3.0 s at 10 Hz — samples 0..30 covered

    const frame = lastFrame(recording);
    expect(trailSegmentCount(frame)).toBe(30);

    // Every segment sits in the path for ITS OWN sample's speed bucket, at its own
    // screen coordinates — so a mis-bucketed or mis-projected segment fails here.
    const byColor = trailByColor(frame);
    for (let k = 0; k < 30; k++) {
      const color = bucketColor(bucketOf(car.samples[k].speed));
      const from = samplePoint(k);
      const to = samplePoint(k + 1);
      const match = byColor
        .get(color)
        ?.find(
          (s) =>
            Math.hypot(s.from.x - from.x, s.from.y - from.y) < 1e-6 &&
            Math.hypot(s.to.x - to.x, s.to.y - to.y) < 1e-6,
        );
      expect(match, `segment ${k} in ${color}`).toBeDefined();
    }
  });

  it("closes the gap between the last sample and the car with a head segment", () => {
    render(<TrackCanvas replay={replay} />);
    advance(30);
    raf.tick(50); // half a grid step past sample 30: the car is mid-segment

    const frame = lastFrame(recording);
    const marker = markers(frame)[0];
    // The head is a context-path stroke (it changes every frame, so it is never
    // appended to the retained paths) at the trail's width.
    const head = frame.findIndex(
      (c, i) =>
        c.method === "stroke" &&
        c.lineWidth === TRAIL_WIDTH &&
        !c.path &&
        frame[i - 1]?.method === "lineTo",
    );
    expect(head).toBeGreaterThan(-1);

    const from = frame[head - 2];
    const to = frame[head - 1];
    expect(from.args[0]).toBeCloseTo(samplePoint(30).x, 6);
    expect(from.args[1]).toBeCloseTo(samplePoint(30).y, 6);
    expect(to.args[0]).toBeCloseTo(marker.x, 9);
    expect(to.args[1]).toBeCloseTo(marker.y, 9);
  });

  it("allocates no paths per frame — 120 frames, zero rebuilds", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    const built = recording.pathsBuilt();

    // 120 frames crossing ~19 samples: appending is not allocating.
    for (let i = 0; i < 120; i++) raf.tick(16);

    expect(recording.pathsBuilt()).toBe(built);
    expect(trailSegmentCount(lastFrame(recording))).toBeGreaterThan(0);
  });

  it("rebuilds once on resize, then goes quiet again", () => {
    render(<TrackCanvas replay={replay} />);
    advance(30);
    const built = recording.pathsBuilt();

    recording.resize(1000, 700);
    raf.tick(16);
    expect(recording.pathsBuilt()).toBe(built + PATHS_PER_BUILD);

    const afterResize = recording.pathsBuilt();
    for (let i = 0; i < 60; i++) raf.tick(16);
    expect(recording.pathsBuilt()).toBe(afterResize);
  });

  it("redraws the trail to exactly the covered portion after a mid-lap resize", () => {
    render(<TrackCanvas replay={replay} />);
    advance(30);
    const before = trailByColor(lastFrame(recording));
    const countBefore = trailSegmentCount(lastFrame(recording));

    recording.resize(1000, 700);
    raf.tick(16); // still inside sample 30's step, so the index has not moved

    const after = trailByColor(lastFrame(recording));
    // Same segments, same buckets — the trail did not lose or duplicate history.
    expect(trailSegmentCount(lastFrame(recording))).toBe(countBefore);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [color, segments] of after) {
      expect(segments.length, color).toBe(before.get(color)!.length);
    }

    // ...but at the NEW scale: a rebuild that reused the old projection would leave
    // the trail sitting where the smaller viewport put it.
    const newFit = fitTransform(scene.bounds, 1000, 700, PAD_PX);
    const [rotated] = rotateWorld(
      [{ x: car.samples[0].x, y: car.samples[0].y }],
      replay.meta.rotation,
    );
    const want = applyTransform(rotated, newFit);
    const first = after.get(bucketColor(bucketOf(car.samples[0].speed)))![0];
    expect(first.from.x).toBeCloseTo(want.x, 6);
    expect(first.from.y).toBeCloseTo(want.y, 6);
    expect(first.from.x).not.toBeCloseTo(samplePoint(0).x, 3);
  });

  it("resets once when the lap wraps, not once per frame", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();
    useTransport.getState().seek(replay.meta.duration - 0.05);
    raf.tick(16);
    const built = recording.pathsBuilt();
    expect(trailSegmentCount(lastFrame(recording))).toBe(
      car.samples.length - 1,
    );

    raf.tick(100); // past the end of the lap: wraps to 0.05
    expect(recording.pathsBuilt()).toBe(built + PATHS_PER_RESET);
    expect(trailSegmentCount(lastFrame(recording))).toBe(0);

    const afterWrap = recording.pathsBuilt();
    for (let i = 0; i < 60; i++) raf.tick(16);
    expect(recording.pathsBuilt()).toBe(afterWrap);
  });

  it("appends through a forward seek but rebuilds on a backwards one", () => {
    render(<TrackCanvas replay={replay} />);
    raf.tick();

    // Forward: 292 segments arrive at once, with no allocation at all.
    const built = recording.pathsBuilt();
    useTransport.getState().seek(29.25);
    raf.tick(16);
    expect(recording.pathsBuilt()).toBe(built);
    expect(trailSegmentCount(lastFrame(recording))).toBe(292);

    // Backwards: a Path2D cannot be un-drawn, so this one has to rebuild.
    useTransport.getState().seek(10);
    raf.tick(16);
    expect(recording.pathsBuilt()).toBe(built + PATHS_PER_RESET);
    expect(trailSegmentCount(lastFrame(recording))).toBe(100);
  });

  it("draws every trail stroke, head included, before any corner badge", () => {
    // Layering, pinned. The batched trail passes UNDER the corner badges, so the
    // head segment must too — drawn later it would paint over the chrome the rest
    // of the trail respects, and with twenty cars each car's head would paint over
    // its neighbours' badges. The car markers still go on top of everything.
    render(<TrackCanvas replay={replay} />);
    advance(30);
    raf.tick(50); // mid-segment, so there IS a head segment to place

    const frame = lastFrame(recording);
    const isTrail = (c: DrawCall) =>
      c.method === "stroke" && c.lineWidth === TRAIL_WIDTH;
    const isBadge = (c: DrawCall) =>
      c.method === "arc" && c.args[2] === CORNER_BADGE_RADIUS;
    const isMarker = (c: DrawCall) =>
      c.method === "arc" &&
      c.fillStyle.toLowerCase() === car.color.toLowerCase();

    const lastIndexOf = (pred: (c: DrawCall) => boolean): number => {
      for (let i = frame.length - 1; i >= 0; i--) if (pred(frame[i])) return i;
      return -1;
    };

    const lastTrail = lastIndexOf(isTrail);
    const firstBadge = frame.findIndex(isBadge);
    const firstMarker = frame.findIndex(isMarker);

    // All three actually happened — otherwise the ordering below is vacuous.
    expect(lastTrail).toBeGreaterThan(-1);
    expect(firstBadge).toBeGreaterThan(-1);
    expect(firstMarker).toBeGreaterThan(-1);
    expect(frame.filter(isBadge)).toHaveLength(replay.track.corners.length);

    // The head segment is the LAST trail stroke of the frame, so this covers it.
    expect(frame[lastTrail].path).toBeUndefined();
    expect(lastTrail).toBeLessThan(firstBadge);
    expect(firstBadge).toBeLessThan(firstMarker);
  });

  it("still never re-renders, across frames AND a resize", () => {
    let commits = 0;
    render(
      <Profiler id="track" onRender={() => commits++}>
        <TrackCanvas replay={replay} />
      </Profiler>,
    );
    expect(commits).toBe(1);

    act(() => {
      for (let i = 0; i < 60; i++) raf.tick(16);
    });
    // Resizing re-measures and re-projects the whole scene. None of that may go
    // through React — `measure()` writes to a closure variable, not to state.
    act(() => {
      recording.resize(1000, 700);
      for (let i = 0; i < 60; i++) raf.tick(16);
    });

    expect(commits).toBe(1);
  });
});
