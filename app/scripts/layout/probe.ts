/**
 * probe.ts — the functions that run INSIDE the page.
 *
 * Each one is shipped to Chrome as its own source text (`CdpPage.evaluate`), so
 * each must be SELF-CONTAINED: DOM globals and its one JSON argument, nothing from
 * module scope — including the helpers, which is why the box conversion is
 * repeated inside each function rather than shared. In exchange they are ordinary
 * TypeScript, typechecked against the DOM lib like the app itself.
 *
 * They only READ, with two deliberate exceptions that put state back: the reach
 * probe scrolls the panel to its end and then restores `scrollTop`, and the click
 * helpers click. Every selector arrives in the argument, so the list of what the
 * check depends on in the app's markup lives in one place (`layout-check.ts`).
 */

/** A `DOMRect`, as plain JSON. CSS px, relative to the viewport. */
export interface Box {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/** Where the check finds things. Existing roles, labels and ids only. */
export interface Selectors {
  header: string;
  transport: string;
  aside: string;
  tower: string;
  canvas: string;
  panel: string;
  panelToggle: string;
  /** A substring of the speed legend's accessible name (its `<figcaption>`). */
  legendName: string;
}

export interface PanelProbe {
  /** The dialog's border box. */
  box: Box;
  /** Its scrollport: the padding box that scrolled content is revealed in. */
  scrollport: Box;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The heading row: the element holding the dialog's labelling heading. */
  headingRow: Box | null;
  /** Whether a hit test at the heading row's centre lands inside it. */
  headingHit: boolean;
  close: Box | null;
  closeHit: boolean;
  /** Scenario card titles in render order. */
  cardTitles: string[];
  /** Text of a `role=alert` inside the panel (a failed load), or `null`. */
  alert: string | null;
}

export interface LayoutProbe {
  viewport: { width: number; height: number };
  scrollWidth: number;
  header: Box | null;
  transport: Box | null;
  aside: Box | null;
  canvas: Box | null;
  canvasCount: number;
  legend: Box | null;
  towerRows: number | null;
  panel: PanelProbe | null;
}

/**
 * Wait for fonts and two animation frames, raced against a short timer.
 *
 * Two frames because the canvas is sized from a ResizeObserver callback, which
 * runs in the frame AFTER the layout that changed it. The timer is a guard, not
 * the mechanism: rAF does run in headless Chrome, but a stalled frame must cost
 * 1 s of wait, never a hang.
 */
export async function settle(): Promise<void> {
  await document.fonts.ready;
  await Promise.race([
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
}

/** Measure everything the assertions read, in one synchronous pass. */
export function probeLayout(sel: Selectors): LayoutProbe {
  const box = (el: Element | null): Box | null => {
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      left: r.left,
      bottom: r.bottom,
      right: r.right,
      width: r.width,
      height: r.height,
    };
  };
  const hits = (el: Element | null): boolean => {
    if (el === null) return false;
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return target !== null && el.contains(target);
  };

  const canvases = document.querySelectorAll(sel.canvas);
  const legend =
    Array.from(document.querySelectorAll("figure")).find((figure) =>
      (figure.querySelector("figcaption")?.textContent ?? "").includes(
        sel.legendName,
      ),
    ) ?? null;
  const tower = document.querySelector(sel.tower);

  let panel: PanelProbe | null = null;
  const dialog = document.querySelector(sel.panel);
  if (dialog !== null) {
    const r = dialog.getBoundingClientRect();
    const labelId = dialog.getAttribute("aria-labelledby");
    const heading = labelId === null ? null : document.getElementById(labelId);
    const headingRow = heading?.parentElement ?? null;
    const close = headingRow?.querySelector("button") ?? null;
    panel = {
      box: box(dialog) as Box,
      scrollport: {
        top: r.top + dialog.clientTop,
        left: r.left + dialog.clientLeft,
        bottom: r.top + dialog.clientTop + dialog.clientHeight,
        right: r.left + dialog.clientLeft + dialog.clientWidth,
        width: dialog.clientWidth,
        height: dialog.clientHeight,
      },
      scrollTop: dialog.scrollTop,
      scrollHeight: dialog.scrollHeight,
      clientHeight: dialog.clientHeight,
      headingRow: box(headingRow),
      headingHit: hits(headingRow),
      close: box(close),
      closeHit: hits(close),
      cardTitles: Array.from(dialog.querySelectorAll("ul > li > button")).map(
        (card) => card.querySelector("span")?.textContent ?? "",
      ),
      alert: dialog.querySelector('[role="alert"]')?.textContent ?? null,
    };
  }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    header: box(document.querySelector(sel.header)),
    transport: box(document.querySelector(sel.transport)),
    aside: box(document.querySelector(sel.aside)),
    canvas: box(canvases[0] ?? null),
    canvasCount: canvases.length,
    legend: box(legend),
    towerRows: tower === null ? null : tower.children.length,
    panel,
  };
}

/** Put the panel's scroll position back to the top. Returns what it was. */
export function resetPanelScroll(sel: Selectors): number | null {
  const dialog = document.querySelector(sel.panel);
  if (dialog === null) return null;
  const was = dialog.scrollTop;
  dialog.scrollTop = 0;
  return was;
}

export interface ReachProbe {
  card: Box | null;
  scrollport: Box;
  scrollTop: number;
  hit: boolean;
}

/**
 * Scroll the panel as far as it goes, measure the LAST scenario card, scroll back.
 *
 * "Can a visitor reach every scenario" is a property of the scroll range, not of
 * the first paint — so it is measured at the end of the range.
 */
export function probeLastCardReach(sel: Selectors): ReachProbe | null {
  const dialog = document.querySelector(sel.panel);
  if (dialog === null) return null;
  dialog.scrollTop = dialog.scrollHeight;
  const cards = dialog.querySelectorAll("ul > li > button");
  const last = cards[cards.length - 1] ?? null;
  const r = dialog.getBoundingClientRect();
  let card: Box | null = null;
  let hit = false;
  if (last !== null) {
    const c = last.getBoundingClientRect();
    card = {
      top: c.top,
      left: c.left,
      bottom: c.bottom,
      right: c.right,
      width: c.width,
      height: c.height,
    };
    const target = document.elementFromPoint(
      c.left + c.width / 2,
      c.top + c.height / 2,
    );
    hit = target !== null && last.contains(target);
  }
  const result: ReachProbe = {
    card,
    scrollport: {
      top: r.top + dialog.clientTop,
      left: r.left + dialog.clientLeft,
      bottom: r.top + dialog.clientTop + dialog.clientHeight,
      right: r.left + dialog.clientLeft + dialog.clientWidth,
      width: dialog.clientWidth,
      height: dialog.clientHeight,
    },
    scrollTop: dialog.scrollTop,
    hit,
  };
  dialog.scrollTop = 0;
  return result;
}

/**
 * Click the scenario card whose title is `title`. Returns the titles it saw when
 * there is no such card, so the failure can say what WAS there.
 */
export function clickScenario(arg: {
  panel: string;
  title: string;
}): { clicked: true } | { clicked: false; titles: string[] } {
  const dialog = document.querySelector(arg.panel);
  const cards = dialog
    ? Array.from(dialog.querySelectorAll<HTMLButtonElement>("ul > li > button"))
    : [];
  const titles = cards.map((c) => c.querySelector("span")?.textContent ?? "");
  const index = titles.indexOf(arg.title);
  if (index === -1) return { clicked: false, titles };
  cards[index].click();
  return { clicked: true };
}

/** Click the header toggle that opens the gallery. */
export function clickToggle(arg: { toggle: string }): boolean {
  const toggle = document.querySelector<HTMLButtonElement>(arg.toggle);
  if (toggle === null) return false;
  toggle.click();
  return true;
}
