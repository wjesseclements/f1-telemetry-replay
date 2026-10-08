import { afterEach, describe, expect, it } from "vitest";
import { probeLayout } from "./probe";
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
