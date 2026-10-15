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
 * helpers click. (State D's clicks and its Escape are TRUSTED input, sent over
 * CDP from Node, `input.ts`; nothing in-page fakes them.) Every selector arrives in the argument, so the list of what the
 * check depends on in the app's markup lives in one place (`SELECTORS`, in
 * `states.ts`). The one lookup that is not a selector is the panel's heading,
 * found the way assistive tech finds it: through the dialog's `aria-labelledby`.
 *
 * If the toolchain ever compiles a module-scope reference into one of these, the
 * page cannot run it. `preflight.ts` runs each one on a blank page before the
 * first measurement, so that surfaces as one named failure rather than as every
 * row failing.
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

/**
 * Where the check finds things. Existing roles, labels, ids and ARIA attributes
 * only.
 */
export interface Selectors {
  header: string;
  transport: string;
  /**
   * The transport's play/pause toggle and its restart button, whose accessible
   * names and descriptions one row reads over CDP (`accessibility.ts`) rather
   * than in the page.
   */
  playToggle: string;
  restart: string;
  aside: string;
  tower: string;
  canvas: string;
  panel: string;
  panelToggle: string;
  /** A scenario card, inside the panel. */
  card: string;
  /** A card's title, inside the card (the first match). */
  cardTitle: string;
  /** The Close button, inside the heading row. */
  close: string;
  /** A failed load's message, inside the panel. */
  alert: string;
  /** The speed legend's element, and its caption (its accessible name)… */
  legend: string;
  legendCaption: string;
  /** …and a substring of that name, which is how the legend is told apart. */
  legendName: string;
  /**
   * The corner card (Slice 18), state D's dialog: measured by `probeLayout`
   * with `panel` swapped for this, so its heading and Close are found exactly
   * as the gallery's are.
   */
  cornerCard: string;
}

export interface PanelProbe {
  /** The dialog's own box (its border box). */
  box: Box;
  /** The dialog's scrollport: the padding box scrolled content is revealed in. */
  scrollport: Box;
  /** The heading row: the element holding the dialog's labelling heading. */
  headingRow: Box | null;
  /** Whether a hit test at the heading row's centre lands inside it. */
  headingHit: boolean;
  close: Box | null;
  closeHit: boolean;
  /** Text of the alert inside the panel (a failed load), or `null`. */
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
    Array.from(document.querySelectorAll(sel.legend)).find((figure) =>
      (figure.querySelector(sel.legendCaption)?.textContent ?? "").includes(
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
    const close = headingRow?.querySelector(sel.close) ?? null;
    panel = {
      box: {
        top: r.top,
        left: r.left,
        bottom: r.bottom,
        right: r.right,
        width: r.width,
        height: r.height,
      },
      scrollport: {
        top: r.top + dialog.clientTop,
        left: r.left + dialog.clientLeft,
        bottom: r.top + dialog.clientTop + dialog.clientHeight,
        right: r.left + dialog.clientLeft + dialog.clientWidth,
        width: dialog.clientWidth,
        height: dialog.clientHeight,
      },
      headingRow: box(headingRow),
      headingHit: hits(headingRow),
      close: box(close),
      closeHit: hits(close),
      alert: dialog.querySelector(sel.alert)?.textContent ?? null,
    };
  }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    // `documentElement` is null for a moment after `Page.navigate`, while the new
    // document has no root yet — the first CI run (cold ubuntu-latest) polled into
    // exactly that window and threw. 0 here, with every element null, reads as
    // "not ready" and `waitFor` keeps polling.
    scrollWidth: document.documentElement?.scrollWidth ?? 0,
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
  const cards = dialog.querySelectorAll(sel.card);
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
  sel: Selectors;
  title: string;
}): { clicked: true } | { clicked: false; titles: string[] } {
  const { sel, title } = arg;
  const dialog = document.querySelector(sel.panel);
  const cards = dialog
    ? Array.from(dialog.querySelectorAll<HTMLButtonElement>(sel.card))
    : [];
  const titles = cards.map(
    (c) => c.querySelector(sel.cardTitle)?.textContent ?? "",
  );
  const index = titles.indexOf(title);
  if (index === -1) return { clicked: false, titles };
  cards[index].click();
  return { clicked: true };
}

/** Click the header toggle that opens the gallery. */
export function clickToggle(sel: Selectors): boolean {
  const toggle = document.querySelector<HTMLButtonElement>(sel.panelToggle);
  if (toggle === null) return false;
  toggle.click();
  return true;
}

/** One corner story's button, as state D reads it (Slice 18). */
export interface StoryTargetReading {
  id: string;
  /** Whether an element with this id exists at all. */
  found: boolean;
  /** Its computed `visibility` is `visible`: not hidden under a dialog. */
  visible: boolean;
  /** Its tap squares: the button's own first, then its member squares'. */
  squares: Box[];
  /** Per square: a hit test at its centre lands inside the story's button. */
  hits: boolean[];
}

export interface StoryTargetsProbe {
  canvas: Box | null;
  targets: StoryTargetReading[];
}

/**
 * Measure every corner story's button by id (`ids`, in lap order): whether it
 * is visible, its squares (a story over several corner numbers has one button
 * and `aria-hidden` member squares inside it), and whether a hit test at each
 * square's centre reaches that button. The canvas box is the clip they must
 * stay inside.
 */
export function probeStoryTargets(arg: {
  ids: string[];
  canvas: string;
}): StoryTargetsProbe {
  const box = (el: Element): Box => {
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
  const canvas = document.querySelector(arg.canvas);
  const targets = arg.ids.map((id) => {
    const button = document.getElementById(id);
    if (button === null) {
      return { id, found: false, visible: false, squares: [], hits: [] };
    }
    const squares = [
      button,
      ...Array.from(button.querySelectorAll(":scope > [aria-hidden]")),
    ].map(box);
    const hits = squares.map((s) => {
      const target = document.elementFromPoint(
        s.left + s.width / 2,
        s.top + s.height / 2,
      );
      return target !== null && button.contains(target);
    });
    return {
      id,
      found: true,
      visible: getComputedStyle(button).visibility === "visible",
      squares,
      hits,
    };
  });
  return { canvas: canvas === null ? null : box(canvas), targets };
}

/** The id of the focused element, or "" (the body, or nothing, has none). */
export function focusedId(): string {
  return document.activeElement?.id ?? "";
}

/**
 * What the canvas painted in its last whole frame (Slice 18): the centre of
 * every corner badge's disc, in the order `drawCorners` paints them (the
 * replay's corner order), and the point the `S/F` label is drawn at. Canvas
 * CSS px.
 */
export interface BadgePaint {
  arcs: [number, number][];
  startFinish: [number, number] | null;
}

/**
 * Record the badges the canvas paints, for state D's "badges centred on the
 * painted discs". Installed on every new document BEFORE the app's script runs
 * (`Page.addScriptToEvaluateOnNewDocument`, `layout-check.ts`): it wraps the 2D
 * context's `arc`, `fillText` and `clearRect`, keeps each frame's discs of
 * radius `radius` (the badges' radius; no car marker uses it) and its `S/F`
 * point, and publishes a frame when the next one starts clearing. It records
 * and passes every call through unchanged, so what is drawn is what was drawn.
 */
export function installPaintRecorder(radius: number): void {
  const proto = CanvasRenderingContext2D.prototype;
  const { arc, fillText, clearRect } = proto;
  const page = window as unknown as { __layoutCheckPaint?: BadgePaint };
  let frame: BadgePaint = { arcs: [], startFinish: null };
  proto.clearRect = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D["clearRect"]>
  ) {
    page.__layoutCheckPaint = frame;
    frame = { arcs: [], startFinish: null };
    return clearRect.apply(this, args);
  };
  proto.arc = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D["arc"]>
  ) {
    if (args[2] === radius) frame.arcs.push([args[0], args[1]]);
    return arc.apply(this, args);
  };
  proto.fillText = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<CanvasRenderingContext2D["fillText"]>
  ) {
    if (args[0] === "S/F") frame.startFinish = [args[1], args[2]];
    return fillText.apply(this, args);
  };
}

/** The last whole frame `installPaintRecorder` kept, or `null`. */
export function readPaint(): BadgePaint | null {
  return (
    (window as unknown as { __layoutCheckPaint?: BadgePaint })
      .__layoutCheckPaint ?? null
  );
}
