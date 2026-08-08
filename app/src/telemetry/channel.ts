/**
 * channel.ts — how per-frame telemetry reaches React without React running per frame.
 *
 * This is deliberately NOT the zustand store. Per-frame values in the store are exactly
 * what CLAUDE.md architecture rule 1 forbids, and a channel that is a separate module
 * makes that boundary structural instead of a thing everyone has to remember. The store
 * holds what a human changes; this holds what the clock changes.
 *
 * The shape is `useSyncExternalStore`'s: `subscribe` + `getSnapshot`. The rAF loop calls
 * `publish` every frame — a plain function call, no React, no setState — and the channel
 * decides when that is worth waking a component for:
 *
 *  - at most `HUD_HZ` times a second, and
 *  - only when something a human could actually see has changed.
 *
 * The second condition is what makes a paused replay cost nothing: reduced-motion starts
 * paused, and a paused clock republishes identical values 60 times a second forever.
 * Rate-limiting alone would still re-render the HUD 30 times a second to paint the same
 * digits.
 */
import { isDrsOpen } from "../engine/drs";
import type { CarSnapshot } from "../engine/interpolate";
import { formatGear, formatSpeed } from "../engine/format";

/** HUD refresh ceiling. PLAN.md's "≤30fps reads". */
export const HUD_HZ = 30;
const MIN_EMIT_GAP_MS = 1000 / HUD_HZ;

/** One published instant. Immutable — a new object is built per emit, never mutated. */
export interface TelemetryFrame {
  /** Playback clock in seconds, as the loop had it when this frame was published. */
  clock: number;
  /** One snapshot per car, in `replay.cars` order. Always an array (rule 2). */
  cars: readonly CarSnapshot[];
}

/**
 * What `getSnapshot` returns before anything has been published.
 *
 * A shared constant, not a fresh object: `useSyncExternalStore` compares by reference and
 * would loop forever on a new one each call. `cars` being empty means the HUD's readout
 * list is simply empty — no "not loaded yet" branch to write, because it maps an array.
 */
export const EMPTY_FRAME: TelemetryFrame = Object.freeze({
  clock: 0,
  cars: Object.freeze([]) as readonly CarSnapshot[],
});

/**
 * The values a human can actually see, as a comparable string.
 *
 * This is the trap in this module: anything the HUD renders MUST appear here, or the
 * channel will suppress the emit that would have updated it and the field will silently
 * freeze — most visibly while paused, where nothing else forces a re-render.
 *
 * Exported for `Hud.test.tsx`, which closes that trap mechanically: it perturbs every
 * field of a `CarSnapshot` in turn and asserts that whenever the perturbation changes
 * what the HUD RENDERS, it also changes this signature. A field added to the readout
 * without being added here fails that test.
 *
 * POSITION IS DELIBERATELY NOT IN HERE (Slice 9e), and the history is worth keeping.
 * Slice 9 added a rounded `x`/`y` term because the timing tower's gaps were computed FROM
 * the published positions. Slice 9d moved gaps onto the replay's precomputed progress read
 * at the CLOCK and flagged the term as no longer load-bearing; Slice 9e's scrolling trace
 * is the other thing that could have wanted it, and it does not — it is a function of the
 * clock and the focused car's static samples. So nothing the HUD draws is a function of a
 * published coordinate, and the term was removed rather than inherited.
 *
 * What makes that safe is mechanical, not careful: `Hud.test.tsx` walks EVERY snapshot
 * field and asserts `rendered change => signature change`. The day a readout prints a
 * coordinate, perturbing `x` starts changing the render and that suite fails until this
 * function moves. Emit COUNTS are unchanged either way — during playback the clock term
 * changes on every emit, and while paused nothing changes at all.
 */
export function displaySignature(
  clock: number,
  cars: readonly CarSnapshot[],
): string {
  // The clock is compared at millisecond precision because that is what
  // `formatLapTime` shows; finer changes cannot alter a single rendered pixel.
  let sig = String(Math.floor(clock * 1000));
  for (const car of cars) {
    sig += `|${formatSpeed(car.speed)},${formatGear(car.gear)},${car.brake},${Math.round(
      car.throttle,
    )},${isDrsOpen(car.drs) ? 1 : 0}`;
  }
  return sig;
}

export interface TelemetryChannel {
  publish(nowMs: number, clock: number, cars: readonly CarSnapshot[]): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): TelemetryFrame;
  /** Drop all state and listeners. Tests only — a module singleton needs a reset. */
  reset(): void;
}

export function createTelemetryChannel(): TelemetryChannel {
  const listeners = new Set<() => void>();
  let current: TelemetryFrame = EMPTY_FRAME;
  let lastEmitMs: number | null = null;
  let lastSignature = "";

  return {
    publish(nowMs, clock, cars) {
      // `null` means nothing has been emitted yet, so the FIRST publish goes straight
      // through: the HUD paints on the frame it mounts rather than sitting blank for up
      // to 33 ms. The cadence window then starts from that emit, not from zero.
      if (lastEmitMs !== null && nowMs - lastEmitMs < MIN_EMIT_GAP_MS) return;

      const signature = displaySignature(clock, cars);
      if (signature === lastSignature) return;

      lastEmitMs = nowMs;
      lastSignature = signature;
      // Built here and only here, so between emits `getSnapshot` keeps returning the
      // same reference and React skips the render.
      current = { clock, cars };
      for (const listener of listeners) listener();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot() {
      return current;
    },

    reset() {
      listeners.clear();
      current = EMPTY_FRAME;
      lastEmitMs = null;
      lastSignature = "";
    },
  };
}

/**
 * The app's channel.
 *
 * A module singleton for the same reason the transport store is one: the publisher (the
 * render loop) and the consumers (HUD, transport bar) are siblings with no common owner
 * below `App`, and threading a channel through props would put it in `App`'s render path.
 */
export const telemetry = createTelemetryChannel();
