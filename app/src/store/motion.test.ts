/**
 * Reduced-motion tests.
 *
 * The store reads the preference once, while it is being constructed at import time,
 * so a plain `vi.stubGlobal` after the fact would test nothing — the value is already
 * baked in. Hence `vi.resetModules()` and a dynamic import per case: each one builds
 * a genuinely fresh store against a genuinely different `matchMedia`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion } from "./motion";

/** A `matchMedia` that answers `reduce` however the test asks it to. */
function stubMatchMedia(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** A transport store built fresh against the current `matchMedia`. */
async function freshTransport() {
  vi.resetModules();
  return (await import("./transport")).useTransport;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("prefersReducedMotion", () => {
  it("is true when the media query matches", () => {
    stubMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("is false when it does not", () => {
    stubMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("is false when matchMedia does not exist", () => {
    // jsdom ships no `matchMedia`. Without the guard the transport store throws
    // while being constructed at import time and takes the whole app down.
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("transport autoplay default", () => {
  it("autoplays when reduced motion is not requested", async () => {
    stubMatchMedia(false);
    const useTransport = await freshTransport();
    expect(useTransport.getState().isPlaying).toBe(true);
  });

  it("starts paused when reduced motion is requested", async () => {
    stubMatchMedia(true);
    const useTransport = await freshTransport();
    expect(useTransport.getState().isPlaying).toBe(false);
  });

  it("disables the autoplay, not the transport", async () => {
    // The accessible experience is a paused replay you can drive, not a dead one.
    stubMatchMedia(true);
    const useTransport = await freshTransport();

    useTransport.getState().play();
    expect(useTransport.getState().isPlaying).toBe(true);

    useTransport.getState().seek(12.5);
    expect(useTransport.getState().seekTarget).toBe(12.5);

    useTransport.getState().setSpeedMult(2);
    expect(useTransport.getState().speedMult).toBe(2);

    useTransport.getState().togglePlay();
    expect(useTransport.getState().isPlaying).toBe(false);
  });
});
