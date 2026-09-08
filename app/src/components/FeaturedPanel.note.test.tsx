/**
 * FeaturedPanel's data-artifact note rendering, kept alive under a MOCKED
 * manifest: the committed manifest carries no notes since Slice 9l froze LEC at
 * the wall and retired the disclosure, but the capability stays — the next
 * feed that fails in a way the pipeline cannot yet repair will need it. Its own
 * file because `vi.mock` is module-wide: the real manifest must keep serving
 * every other panel and App test.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeaturedPanel } from "./FeaturedPanel";

vi.mock("../gallery/manifest.json", () => ({
  default: {
    schemaVersion: 1,
    scenarios: [
      {
        id: "noted",
        title: "Noted scenario",
        hook: "Has a disclosure.",
        file: "noted.json",
        suggested: { driver: "VER", clock: 0, speedMult: 1 },
        provenance: {
          session: "S",
          laps: "1-2",
          drivers: ["VER"],
          generated: "2026-09-08",
          note: "Known data artifact: the feed lies here.",
        },
      },
      {
        id: "plain",
        title: "Plain scenario",
        hook: "Nothing to disclose.",
        file: "plain.json",
        suggested: { driver: "VER", clock: 0, speedMult: 1 },
        provenance: {
          session: "S",
          laps: "3-4",
          drivers: ["VER"],
          generated: "2026-09-08",
        },
      },
    ],
  },
}));

afterEach(cleanup);

describe("FeaturedPanel provenance note", () => {
  it("renders a note verbatim on the scenario that carries one, and nothing on the others", () => {
    render(<FeaturedPanel id="panel" onClose={() => {}} />);
    expect(
      screen.getByText("Known data artifact: the feed lies here."),
    ).toBeInTheDocument();
    // Exactly one note in the mocked manifest, exactly one in the DOM.
    expect(screen.getAllByText(/Known data artifact/)).toHaveLength(1);
  });
});
