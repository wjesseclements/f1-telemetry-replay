/**
 * EventCard tests — the overlay's own contract: focus in, focus back out, Escape,
 * the continue action's success and degrade paths. WHEN the card exists is
 * `ScenarioEvents.test.tsx`'s job.
 *
 * `applyScenario` is mocked: the card's contract is "call it, then play and close
 * on success / show the message and stay on failure", not the fetch behind it —
 * which the offline trap would (correctly) refuse anyway.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryScenario, ScenarioEvent } from "../engine/gallery";
import { useTransport } from "../store/transport";
import { EventCard } from "./EventCard";
import { PLAY_TOGGLE_ID } from "./TransportBar";

vi.mock("../data/applyScenario", () => ({
  applyScenario: vi.fn(),
}));
import { applyScenario } from "../data/applyScenario";
const applyScenarioMock = vi.mocked(applyScenario);

const event: ScenarioEvent = {
  clock: 252.1,
  title: "RED FLAG",
  body: "The stoppage, narrated.",
};

const next: GalleryScenario = {
  id: "restart",
  title: "Monza 2026 · the restart",
  hook: "h",
  file: "restart.json",
  suggested: { driver: "ANT", clock: 150, speedMult: 1 },
  provenance: {
    session: "S",
    laps: "6-9",
    drivers: ["ANT"],
    generated: "2026-09-08",
  },
  events: [],
};

beforeEach(() => {
  applyScenarioMock.mockReset();
  useTransport.setState({ isPlaying: false });
});
afterEach(cleanup);

describe("EventCard", () => {
  it("moves focus to the continue action on mount — Enter is the whole interaction", () => {
    render(<EventCard event={event} next={next} onClose={() => {}} />);
    expect(
      screen.getByRole("button", { name: /Continue: Monza 2026/ }),
    ).toHaveFocus();
  });

  it("falls back to the close button when there is no chain to offer", () => {
    render(<EventCard event={event} next={null} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: /Continue/ }),
    ).not.toBeInTheDocument();
  });

  it("Escape closes, and the press does not leak to the transport keys", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<EventCard event={event} next={next} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("returns focus to the play toggle on unmount when nothing better held it", () => {
    const toggle = document.createElement("button");
    toggle.id = PLAY_TOGGLE_ID;
    document.body.appendChild(toggle);

    const view = render(
      <EventCard event={event} next={next} onClose={() => {}} />,
    );
    view.unmount();
    expect(toggle).toHaveFocus();
    toggle.remove();
  });

  it("continue applies the next scenario, resumes playback and closes", async () => {
    applyScenarioMock.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<EventCard event={event} next={next} onClose={onClose} />);

    screen.getByRole("button", { name: /Continue/ }).click();

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(applyScenarioMock).toHaveBeenCalledWith(next);
    expect(useTransport.getState().isPlaying).toBe(true);
  });

  it("a failed continue degrades in place: message shown, card open, playback untouched", async () => {
    applyScenarioMock.mockResolvedValue("Could not load restart.json");
    const onClose = vi.fn();
    render(<EventCard event={event} next={next} onClose={onClose} />);

    screen.getByRole("button", { name: /Continue/ }).click();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load restart.json",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(useTransport.getState().isPlaying).toBe(false);
    // Still actionable: the button is enabled again for a retry.
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });
});
