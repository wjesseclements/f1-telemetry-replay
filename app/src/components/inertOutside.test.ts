/**
 * inertOutside — the page behind a full-screen overlay goes inert, and comes back
 * (Slice 26, ruled 2026-10-12). jsdom applies no inert behaviour, so these pin
 * the attribute: which elements carry it, and when it comes off. What it does in
 * a browser (Tab cycling inside, the accessibility tree outside hidden) was
 * measured in headless Chrome (Slice 26's PLAN entry).
 */
import { afterEach, describe, expect, it } from "vitest";
import { inertOutside } from "./inertOutside";

/**
 * The app's shape, in miniature: a header, the track cell holding the canvas,
 * the legend and the two dialogs, the tower beside it, the transport under it.
 */
function page() {
  document.body.innerHTML = `
    <div id="root">
      <main id="main">
        <header id="header"><button id="toggle">Featured</button></header>
        <div id="row">
          <div id="cell">
            <canvas id="canvas"></canvas>
            <figure id="legend"></figure>
            <div id="event" role="dialog"><button>Close</button></div>
            <div id="gallery" role="dialog"><button id="card">Card</button></div>
          </div>
          <aside id="tower"><button>VER</button></aside>
        </div>
        <section id="transport"><button>Play</button></section>
      </main>
    </div>`;
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  return el;
}

const inert = () =>
  Array.from(document.querySelectorAll("[inert]")).map((e) => e.id);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("inertOutside", () => {
  it("makes every element off the dialog's path inert, and nothing on it", () => {
    const el = page();
    inertOutside(el("gallery"));
    expect(inert().sort()).toEqual(
      ["canvas", "header", "legend", "tower", "transport"].sort(),
    );
    // The dialog, its ancestors and its own subtree stay live.
    for (const id of ["gallery", "card", "cell", "row", "main", "root"]) {
      expect(el(id).closest("[inert]"), id).toBeNull();
    }
  });

  it("never makes another dialog inert", () => {
    const el = page();
    inertOutside(el("gallery"));
    expect(el("event").hasAttribute("inert")).toBe(false);
  });

  it("undoes exactly what it did", () => {
    const el = page();
    const undo = inertOutside(el("gallery"));
    undo();
    expect(inert()).toEqual([]);
  });

  it("keeps the page inert until the LAST of two holds is released", () => {
    // The event card firing while the gallery is open: closing the gallery must
    // not wake the page under the card.
    const el = page();
    const releaseGallery = inertOutside(el("gallery"));
    const releaseEvent = inertOutside(el("event"));
    releaseGallery();
    expect(inert().sort()).toEqual(
      ["canvas", "header", "legend", "tower", "transport"].sort(),
    );
    releaseEvent();
    expect(inert()).toEqual([]);
  });

  it("leaves an element that was already inert alone, and inert", () => {
    const el = page();
    el("tower").setAttribute("inert", "");
    const undo = inertOutside(el("gallery"));
    undo();
    expect(inert()).toEqual(["tower"]);
  });

  it("stops at <body>: nothing outside the document's content is touched", () => {
    const el = page();
    inertOutside(el("gallery"));
    expect(document.body.hasAttribute("inert")).toBe(false);
    expect(document.documentElement.hasAttribute("inert")).toBe(false);
    expect(document.head.hasAttribute("inert")).toBe(false);
  });
});
