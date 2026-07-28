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
  /** For `stroke(path)` / `fill(path)`: the path that was painted. */
  path?: RecordingPath2D;
  /** For `fillText`: the string drawn. `args` holds its `[x, y]`. */
  text?: string;
}

/** One `moveTo`→`lineTo` pair appended to a path. */
export interface PathSegment {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

/**
 * A `Path2D` stand-in that remembers what was put into it.
 *
 * jsdom ships no `Path2D` at all, so without this the trail's batched paths cannot
 * even be constructed under test. Recording the segments is what lets a test assert
 * WHICH segments went into WHICH speed bucket, and the shared construction counter
 * is what lets it assert the draw path is not allocating a fresh path per frame.
 */
export class RecordingPath2D {
  /** Every `Path2D` constructed since `installCanvasEnvironment`. */
  static constructed = 0;

  readonly ops: { method: string; args: number[] }[] = [];

  constructor() {
    RecordingPath2D.constructed++;
  }

  moveTo(x: number, y: number): void {
    this.ops.push({ method: "moveTo", args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.ops.push({ method: "lineTo", args: [x, y] });
  }
  closePath(): void {
    this.ops.push({ method: "closePath", args: [] });
  }

  /** The `moveTo`→`lineTo` pairs in this path, in order. */
  segments(): PathSegment[] {
    const out: PathSegment[] = [];
    for (let i = 0; i < this.ops.length - 1; i++) {
      if (
        this.ops[i].method === "moveTo" &&
        this.ops[i + 1].method === "lineTo"
      ) {
        out.push({
          from: { x: this.ops[i].args[0], y: this.ops[i].args[1] },
          to: { x: this.ops[i + 1].args[0], y: this.ops[i + 1].args[1] },
        });
      }
    }
    return out;
  }
}

export interface RecordingContext {
  calls: DrawCall[];
  ctx: CanvasRenderingContext2D;
  /** `Path2D` constructions so far — the per-frame allocation guard reads this. */
  pathsBuilt: () => number;
  /** Resize the viewport and fire the observers, as a real resize would. */
  resize: (width: number, height: number) => void;
}

/**
 * A 2D context that records instead of rasterising.
 *
 * `stroke`/`fill` are special-cased because they take an optional `Path2D`: the
 * batched trail paints with `stroke(path)` and never touches the context's own
 * current path, so a recorder that only kept numeric args would see the trail as a
 * handful of style-less `stroke` calls with nothing in them.
 */
function createContext(calls: DrawCall[]): CanvasRenderingContext2D {
  const state = { strokeStyle: "", fillStyle: "", lineWidth: 0 };

  const record =
    (method: string) =>
    (...args: number[]) => {
      calls.push({ method, args, ...state });
    };

  const recordPath = (method: string) => (path?: RecordingPath2D) => {
    calls.push({ method, args: [], ...state, path });
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
    fillText: (text: string, x: number, y: number) => {
      calls.push({ method: "fillText", args: [x, y], ...state, text });
    },
    fill: recordPath("fill"),
    stroke: recordPath("stroke"),
  };

  // The recorder implements only what `scene.ts` calls; the cast is the seam
  // between that subset and the full DOM interface.
  return ctx as unknown as CanvasRenderingContext2D;
}

/**
 * Give jsdom a 2D context, a layout size, a `ResizeObserver`, a `Path2D` and a
 * device pixel ratio. Undone by `vi.restoreAllMocks()` / `vi.unstubAllGlobals()`.
 */
export function installCanvasEnvironment(
  width: number,
  height: number,
): RecordingContext {
  const calls: DrawCall[] = [];
  const ctx = createContext(calls);

  // Reset per install: the counter is static, so it would otherwise carry over
  // between tests and make every allocation assertion depend on test order.
  RecordingPath2D.constructed = 0;

  let w = width;
  let h = height;
  const observers = new Set<() => void>();

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as RenderingContext,
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => w,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => h,
  );
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("Path2D", RecordingPath2D);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: () => void) {}
      observe() {
        observers.add(this.cb);
      }
      unobserve() {
        observers.delete(this.cb);
      }
      disconnect() {
        observers.delete(this.cb);
      }
    },
  );

  return {
    calls,
    ctx,
    pathsBuilt: () => RecordingPath2D.constructed,
    resize(nextWidth: number, nextHeight: number) {
      w = nextWidth;
      h = nextHeight;
      for (const cb of observers) cb();
    },
  };
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
