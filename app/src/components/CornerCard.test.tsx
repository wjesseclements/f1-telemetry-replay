/**
 * CornerCard tests — the corner card's own contract (Slice 18): the ruled copy,
 * verbatim, in the ruled formats; Close focused on open; Escape that stays in
 * the card; Previous/Next round the lap; the live announcement; modal on a phone.
 * Opening, pausing and where focus goes on close are `App`'s, pinned in
 * `App.test.tsx`; where it sits is `overlay.test.tsx`'s, which lists it among
 * the overlay dialogs.
 *
 * The stories are the real Monza ones, resolved from the lore file's own corner
 * record, so "verbatim" is checked against the committed copy rather than a
 * string typed here twice.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLore } from "../engine/lore";
import { LORE } from "../lore";
import { CORNER_CARD_ID, CornerCard } from "./CornerCard";
import { PHONE_QUERY } from "./phoneLayout";

const monza = LORE.find((circuit) => circuit.id === "monza");
if (monza === undefined) throw new Error("no Monza lore");
const resolved = resolveLore(monza.layouts[0].corners, LORE);
if (resolved === null) throw new Error("Monza's record does not match itself");
const STORIES = resolved.stories;
const byId = (id: string): number => STORIES.findIndex((s) => s.id === id);

/** The card with its index held the way App holds it. */
function Harness({
  start,
  onClose = () => {},
}: {
  start: number;
  onClose?: () => void;
}) {
  const [index, setIndex] = useState(start);
  return (
    <CornerCard
      stories={STORIES}
      index={index}
      onStep={setIndex}
      onClose={onClose}
    />
  );
}

const dialog = () => screen.getByRole("dialog");
const press = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));

afterEach(cleanup);

describe("CornerCard", () => {
  it("shows the eyebrow, the name, the second name and the story, verbatim", () => {
    const alboreto = STORIES[byId("curva-alboreto")];
    render(<Harness start={byId("curva-alboreto")} />);
    // The ruled strings (2026-10-15), as the lore file holds them.
    expect(screen.getByText("Turn 11")).toBeInTheDocument();
    expect(screen.getByText("Curva Alboreto")).toBeInTheDocument();
    expect(screen.getByText("Parabolica")).toBeInTheDocument();
    expect(screen.getByText(alboreto.story)).toBeInTheDocument();
  });

  it("keeps the copy's en dashes and curly apostrophes, byte for byte", () => {
    render(<Harness start={byId("seconda-curva-di-lesmo")} />);
    const story = STORIES[byId("seconda-curva-di-lesmo")].story;
    expect(story).toContain("1994\u201395");
    expect(story).toContain("park\u2019s");
    expect(screen.getByText(story).textContent).toBe(story);
  });

  it("names the dialog and its heading in the ruled format, from one string", () => {
    render(<Harness start={byId("curva-alboreto")} />);
    const name = "Turn 11: Curva Alboreto (Parabolica)";
    expect(dialog()).toHaveAccessibleName(name);
    expect(screen.getByRole("heading", { level: 2 })).toHaveAccessibleName(
      name,
    );
    // The visible lines are hidden from assistive tech: the name is one
    // `sr-only` string, so Chrome cannot space it into "Turn 11 : Curva …".
    const heading = screen.getByRole("heading", { level: 2 });
    const spoken = heading.querySelectorAll(":scope > :not([aria-hidden])");
    expect(Array.from(spoken).map((el) => el.textContent)).toEqual([name]);
    expect(spoken[0]).toHaveClass("sr-only");
    expect(dialog()).not.toHaveAttribute("aria-label");
    expect(dialog()).toHaveAttribute("id", CORNER_CARD_ID);
  });

  it("has no second-name line for a story without one, and a range eyebrow for a run", () => {
    render(<Harness start={byId("variante-ascari")} />);
    expect(dialog()).toHaveAccessibleName("Turns 8–10: Variante Ascari");
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.querySelectorAll("[aria-hidden]")).toHaveLength(2);
  });

  it("moves focus to Close on open", () => {
    render(<Harness start={0} />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("closes from Close", () => {
    const onClose = vi.fn();
    render(<Harness start={0} onClose={onClose} />);
    press("Close");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape closes, and the press does not leak to the transport keys", () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    render(<Harness start={0} onClose={onClose} />);
    screen
      .getByRole("button", { name: "Close" })
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    expect(onClose).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outer);
  });

  it("ignores every other key", () => {
    const onClose = vi.fn();
    render(<Harness start={0} onClose={onClose} />);
    fireEvent.keyDown(dialog(), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("steps round the lap with Previous and Next, wrapping at both ends", () => {
    render(<Harness start={0} />);
    expect(dialog()).toHaveAccessibleName(STORIES[0].accessibleName);
    press("Previous");
    expect(dialog()).toHaveAccessibleName(
      STORIES[STORIES.length - 1].accessibleName,
    );
    press("Next");
    expect(dialog()).toHaveAccessibleName(STORIES[0].accessibleName);
    // Every story in lap order, and back to the first.
    for (let i = 1; i <= STORIES.length; i++) {
      press("Next");
      expect(dialog()).toHaveAccessibleName(
        STORIES[i % STORIES.length].accessibleName,
      );
    }
    // The steps are buttons the event card's mould keeps 44 px on a phone.
    for (const name of ["Previous", "Next"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "phone:min-h-11",
        "phone:min-w-11",
      );
    }
  });

  it("announces the new story's name after a step, and nothing on open", () => {
    render(<Harness start={byId("curva-alboreto")} />);
    const live = dialog().querySelector("[aria-live]");
    expect(live).toHaveAttribute("aria-live", "polite");
    // On open the dialog's own name is what a screen reader announces.
    expect(live).toHaveTextContent(/^$/);
    press("Next");
    expect(live).toHaveTextContent(/^Turns 1–2: Prima Variante$/);
    press("Previous");
    expect(live).toHaveTextContent(/^Turn 11: Curva Alboreto \(Parabolica\)$/);
  });

  it("renders no copy of its own beyond the ruled controls", () => {
    // Copy is human-owned: the only strings that are not the lore file's are
    // the three ruled controls.
    render(<Harness start={byId("curva-alboreto")} />);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Close", "Previous", "Next"]);
  });
});

describe("CornerCard on a phone", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  function page(card: boolean) {
    return (
      <>
        <button type="button">Elsewhere</button>
        {card && <Harness start={0} />}
      </>
    );
  }

  it("makes the page behind it inert, says it is modal, and focuses Close", () => {
    const view = render(page(false));
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    view.rerender(page(true));
    expect(elsewhere).toHaveAttribute("inert");
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(dialog().closest("[inert]")).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    view.rerender(page(false));
    expect(elsewhere).not.toHaveAttribute("inert");
  });

  it("is not modal off a phone", () => {
    vi.unstubAllGlobals();
    render(page(true));
    expect(dialog()).toHaveAttribute("aria-modal", "false");
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });
});
