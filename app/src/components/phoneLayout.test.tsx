/**
 * usePhoneLayout — the `phone:` query as React state (Slice 26). What the query
 * compiles to is pinned in `layoutVariants.test.ts`; this pins how it is read:
 * the exact query, a subscription that re-renders only when the answer changes,
 * and "not a phone" where there is no `matchMedia`.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_QUERY, usePhoneLayout } from "./phoneLayout";

/** A `matchMedia` whose answer to PHONE_QUERY the test flips at will. */
function stubMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<() => void>();
  const asked: string[] = [];
  vi.stubGlobal("matchMedia", (query: string) => {
    asked.push(query);
    return {
      get matches() {
        return query === PHONE_QUERY && matches;
      },
      media: query,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    };
  });
  return {
    asked,
    listeners,
    flip(next: boolean) {
      matches = next;
      act(() => listeners.forEach((l) => l()));
    },
  };
}

let renders = 0;
function Probe() {
  renders++;
  return <p>{usePhoneLayout() ? "phone" : "desktop"}</p>;
}

afterEach(() => {
  cleanup();
  renders = 0;
});

describe("usePhoneLayout", () => {
  it("asks exactly the `phone:` query", () => {
    const media = stubMedia(true);
    render(<Probe />);
    expect(screen.getByText("phone")).toBeInTheDocument();
    expect(new Set(media.asked)).toEqual(new Set([PHONE_QUERY]));
  });

  it("follows a resize or rotation across the line, and only that", () => {
    const media = stubMedia(false);
    render(<Probe />);
    expect(screen.getByText("desktop")).toBeInTheDocument();
    const before = renders;

    media.flip(true);
    expect(screen.getByText("phone")).toBeInTheDocument();
    expect(renders).toBe(before + 1);

    // A change event whose answer did not change re-renders nothing.
    media.flip(true);
    expect(renders).toBe(before + 1);

    media.flip(false);
    expect(screen.getByText("desktop")).toBeInTheDocument();
  });

  it("unsubscribes on unmount", () => {
    const media = stubMedia(false);
    const view = render(<Probe />);
    expect(media.listeners.size).toBe(1);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("is not a phone where there is no matchMedia (jsdom, a server render)", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);
    expect(screen.getByText("desktop")).toBeInTheDocument();
  });
});
