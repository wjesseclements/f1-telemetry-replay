import { afterEach, describe, expect, it, vi } from "vitest";
import { installPaintRecorder, probeLayout, readPaint } from "./probe";
import { SELECTORS } from "./states";

describe("probeLayout", () => {
  const original = document.documentElement;
  afterEach(() => {
    if (document.documentElement === null) document.appendChild(original);
  });

  it("reports 'not ready' rather than throwing while the new document has no root yet", () => {
    // The first CI run (ubuntu-latest, cold machine) polled the first viewport
    // straight after Page.navigate and caught the document between loads:
    // `document.documentElement` was null, the probe threw on `.scrollWidth`, and
    // state A failed as "not reached" although the app was fine. A poll must be
    // able to say "nothing there yet" so `waitFor` keeps polling.
    document.removeChild(original);
    expect(document.documentElement).toBeNull();
    const probe = probeLayout(SELECTORS);
    expect(probe.panel).toBeNull();
    expect(probe.transport).toBeNull();
    expect(probe.scrollWidth).toBe(0);
  });
});

describe("installPaintRecorder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as { __layoutCheckPaint?: unknown })
      .__layoutCheckPaint;
  });

  it("keeps the last whole frame's badge discs and S/F point, passing every call through", () => {
    const drawn: string[] = [];
    class FakeContext {
      clearRect() {
        drawn.push("clearRect");
      }
      arc(x: number, y: number, r: number) {
        drawn.push(`arc ${x} ${y} ${r}`);
      }
      fillText(text: string) {
        drawn.push(`fillText ${text}`);
      }
    }
    vi.stubGlobal("CanvasRenderingContext2D", FakeContext);
    installPaintRecorder(9);
    const ctx = new FakeContext() as unknown as CanvasRenderingContext2D;

    expect(readPaint()).toBeNull(); // no frame finished yet
    ctx.clearRect(0, 0, 1, 1);
    ctx.arc(10, 20, 9, 0, 1); // a badge
    ctx.arc(30, 40, 6.5, 0, 1); // a car marker: not a badge
    ctx.fillText("S/F", 5, 6);
    ctx.fillText("11", 10, 20);
    expect(readPaint()).toEqual({ arcs: [], startFinish: null }); // still drawing
    ctx.clearRect(0, 0, 1, 1); // the next frame starts: this one is whole
    expect(readPaint()).toEqual({ arcs: [[10, 20]], startFinish: [5, 6] });
    // Recorded, never swallowed.
    expect(drawn).toEqual([
      "clearRect",
      "arc 10 20 9",
      "arc 30 40 6.5",
      "fillText S/F",
      "fillText 11",
      "clearRect",
    ]);
  });
});
