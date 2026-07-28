/**
 * canvas.ts — test doubles for the bits of the browser the render loop needs.
 *
 * jsdom has no 2D context, no `ResizeObserver`, no layout (so every element is
 * 0x0) and a `requestAnimationFrame` that cannot be stepped. Rather than skip the
 * loop in tests, we record what it draws: the recording context keeps every canvas
 * call with the style state it was made under, so a test can assert where a car
 * marker was painted and which way its heading tick pointed.
 */
import { vi } from "vitest";

export interface DrawCall {
  method: string;
  args: number[];
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

export interface RecordingContext {
  calls: DrawCall[];
  ctx: CanvasRenderingContext2D;
}

/** A 2D context that records instead of rasterising. */
export function createRecordingContext(): RecordingContext {
  const calls: DrawCall[] = [];
  const state = { strokeStyle: "", fillStyle: "", lineWidth: 0 };

  const record =
    (method: string) =>
    (...args: number[]) => {
      calls.push({ method, args, ...state });
    };

  const ctx = {
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    lineJoin: "round",
    lineCap: "round",
    shadowColor: "",
    shadowBlur: 0,
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    fill: record("fill"),
    stroke: record("stroke"),
  };

  // The recorder implements only what `scene.ts` calls; the cast is the seam
  // between that subset and the full DOM interface.
  return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
}

/**
 * Give jsdom a 2D context, a layout size, a `ResizeObserver` and a device pixel
 * ratio. Undone by `vi.restoreAllMocks()` / `vi.unstubAllGlobals()`.
 */
export function installCanvasEnvironment(
  width: number,
  height: number,
): RecordingContext {
  const recording = createRecordingContext();

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    recording.ctx as unknown as RenderingContext,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    height,
  );
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  return recording;
}

export interface RafDriver {
  /** Run every pending frame callback, `deltaMs` later. */
  tick: (deltaMs?: number) => void;
  /** Callbacks currently queued — 1 while a healthy loop is running. */
  pending: () => number;
}

/** A `requestAnimationFrame` the test steps by hand. */
export function installRafDriver(startMs = 1000): RafDriver {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let now = startMs;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });

  return {
    tick(deltaMs = 16) {
      now += deltaMs;
      // Snapshot first: each callback re-requests the next frame, and those
      // belong to the NEXT tick, not this one.
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const cb of due) cb(now);
    },
    pending: () => callbacks.size,
  };
}
