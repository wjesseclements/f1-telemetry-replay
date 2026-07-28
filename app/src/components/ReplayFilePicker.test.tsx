/**
 * Picker tests — the two behaviours that make a bad file survivable.
 *
 * A failed load must not take the current replay down with it, and the validation
 * message must arrive intact rather than summarised. Both are easy to regress into
 * "show a toast saying something went wrong", which would throw away the only thing
 * that makes a pipeline/schema mismatch fixable.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixtureReplay } from "../data/fixture";
import { useTransport } from "../store/transport";
import { ReplayFilePicker } from "./ReplayFilePicker";

const fixture = loadFixtureReplay();

const fileOf = (contents: string, name: string) =>
  new File([contents], name, { type: "application/json" });

/** Pick a file, the way a `change` from the file dialog arrives. */
const upload = (file: File) =>
  fireEvent.change(screen.getByLabelText("Load replay JSON"), {
    target: { files: [file] },
  });

beforeEach(() => {
  useTransport.setState({ replay: fixture, seekTarget: null, isPlaying: true });
});

afterEach(cleanup);

describe("ReplayFilePicker", () => {
  it("loads a conforming replay into the store and restarts the lap", async () => {
    const other = structuredClone(fixture);
    other.meta.event = "Another GP";
    render(<ReplayFilePicker />);

    upload(fileOf(JSON.stringify(other), "another.json"));

    await waitFor(() => {
      expect(useTransport.getState().replay?.meta.event).toBe("Another GP");
    });
    // Start at the line, without touching playback — the same contract the
    // scrubber has.
    expect(useTransport.getState().seekTarget).toBe(0);
    expect(useTransport.getState().isPlaying).toBe(true);
    expect(await screen.findByText(/loaded another\.json/)).toBeInTheDocument();
  });

  it("keeps the current replay when the picked file is invalid", async () => {
    const broken = structuredClone(fixture) as unknown as {
      cars: { samples: { throttle: number }[] }[];
    };
    broken.cars[0].samples[3].throttle = 105;
    render(<ReplayFilePicker />);

    upload(fileOf(JSON.stringify(broken), "over-throttle.json"));

    const alert = await screen.findByRole("alert");
    // Verbatim: the path line is what tells a human which sample to look at.
    expect(alert).toHaveTextContent("over-throttle.json");
    expect(alert).toHaveTextContent("→ at cars[0].samples[3].throttle");
    // The lap on screen is untouched.
    expect(useTransport.getState().replay).toBe(fixture);
  });

  it("keeps the input focusable so it can be reached by keyboard", () => {
    render(<ReplayFilePicker />);
    const input = screen.getByLabelText("Load replay JSON");
    // `sr-only`, never `hidden`/`display:none` — the latter drops it out of the tab
    // order and makes the control mouse-only.
    expect(input).toHaveClass("sr-only");
    input.focus();
    expect(input).toHaveFocus();
  });
});
