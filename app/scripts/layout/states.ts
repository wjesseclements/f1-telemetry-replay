/**
 * states.ts — the three states the layout check visits, and what it asserts in
 * each.
 *
 *   A  first load — the gallery panel open over the committed fixture;
 *   B  the largest gallery scenario (most cars) loaded by clicking its card;
 *   C  the gallery reopened over that replay.
 *
 * Every threshold is named and justified where it is declared. Every selector is
 * an existing role, label or id in the app — no test ids were added.
 */
import type { CdpPage } from "./cdp";
import {
  contains,
  intersect,
  overlaps,
  size,
  viewportBox,
  ySpan,
} from "./geometry";
import {
  clickScenario,
  clickToggle,
  probeLastCardReach,
  probeLayout,
  resetPanelScroll,
  settle,
  type Box,
  type LayoutProbe,
  type Selectors,
} from "./probe";
import type { Report, StateKey } from "./report";

/**
 * Where the check finds things. The legend is found by its accessible name,
 * which for a `<figure>` is its `<figcaption>`.
 */
export const SELECTORS: Selectors = {
  header: "main > header",
  transport: 'section[aria-label="Playback controls"]',
  aside: 'aside[aria-label="Telemetry"]',
  tower: 'ul[aria-label="Running order"]',
  canvas: "main canvas",
  panel: '#featured-replays[role="dialog"]',
  panelToggle: 'button[aria-controls="featured-replays"]',
  legendName: "colour scale",
};

// ── budgets for the waits inside a state ─────────────────────────────────────
const FIRST_LOAD_MS = 15_000;
/** Fetch + parse + schema-validate a ~5 MB gallery asset, in a headless tab. */
const SCENARIO_LOAD_MS = 30_000;
const PANEL_OPEN_MS = 5_000;
const POLL_MS = 50;

// ── thresholds (CSS px / fractions of the viewport) ──────────────────────────
// None of these was tuned to a result, and none needs to be precise: each sits
// far from both the defects this check was built to catch (a canvas measured at
// 0 px, a reopened panel 32 px tall) and what the working desktop layouts measure
// (623-803 px of canvas, a 623-803 px panel). A threshold that separated the two
// by a few px would be measuring noise.
/**
 * The track canvas's minimum height. The track is fitted with `PAD_PX` = 46 px of
 * margin on every side (`src/render/TrackCanvas.tsx`), so a 200 px canvas leaves
 * 108 px for the circuit itself — a thumbnail. That is the floor, not a target.
 */
const CANVAS_MIN_HEIGHT_PX = 200;
/**
 * …and at least this share of the viewport's height (244 px on a 812 px phone).
 * The fixed floor alone would let a tall screen pass with the HUD owning most of
 * it; the track is the product, so it keeps at least ~a third of the height.
 */
const CANVAS_MIN_HEIGHT_FRAC = 0.3;
/**
 * The canvas's minimum share of the viewport's width. The side-by-side layout
 * gives the HUD a fixed `md:w-56` (224 px) column, which never takes half of any
 * viewport at or above the 768 px breakpoint; stacked, the canvas is full-width.
 * Under half means a sidebar has grown into the track.
 */
const CANVAS_MIN_WIDTH_FRAC = 0.5;
/**
 * The gallery panel's minimum VISIBLE height when reopened over a loaded replay.
 * Measured with the panel at its top: the heading row ends ~57 px below the
 * scrollport's top edge (16 px scrim padding + 16 px card padding + a 24.5 px
 * row) and the first scenario card starts at ~70 px, 148.6 px tall at 1440 wide
 * and 166.5 px at 375. So 200 px shows the heading, its Close button and at least
 * 130 px of a card — what the panel is, and something to click in it. Less, and
 * reopening the gallery shows a sliver nobody can use.
 */
const PANEL_MIN_VISIBLE_PX = 200;
/**
 * Horizontal overflow slack. `scrollWidth` and `innerWidth` are both integers;
 * 1 px absorbs a sub-pixel box rounding up, and is nothing a person could scroll.
 */
const H_OVERFLOW_SLACK_PX = 1;

/** What a state needs: the page, where to record, and how to name its waits. */
export interface StateContext {
  page: CdpPage;
  /** `375x812` — the row label. */
  viewport: string;
  report: Report;
  /** Names the step in progress, which is what the hard cap reports on a hang. */
  step: (name: string) => void;
}

export interface Scenario {
  title: string;
  cars: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `probe` until `done`, or throw naming what never happened. */
async function waitFor<T>(
  ctx: StateContext,
  name: string,
  ms: number,
  probe: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  ctx.step(`waiting for ${name}`);
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms} ms waiting for ${name}`);
    }
    await sleep(POLL_MS);
  }
}

function record(
  ctx: StateContext,
  state: StateKey,
  assertion: string,
  pass: boolean,
  measured: string,
): void {
  ctx.report.record(ctx.viewport, state, assertion, pass, measured);
}

/**
 * "Visible" means all three: entirely inside the viewport, entirely inside the
 * clip (the panel's scrollport, where there is one), and actually on top — a hit
 * test at its centre lands on it. The last clause is what catches an element that
 * is geometrically in place but scrolled out of its container or painted over.
 */
function recordVisible(
  ctx: StateContext,
  state: StateKey,
  what: string,
  el: Box | null,
  clip: Box,
  hit: boolean,
): void {
  if (el === null) {
    record(ctx, state, `${what} visible`, false, "not found");
    return;
  }
  record(
    ctx,
    state,
    `${what} visible`,
    contains(clip, el) && hit,
    `${ySpan(el)} in ${ySpan(clip)}${hit ? "" : " · hit-test misses"}`,
  );
}

function recordTransportInView(
  ctx: StateContext,
  state: StateKey,
  probe: LayoutProbe,
): void {
  const view = viewportBox(probe.viewport.width, probe.viewport.height);
  record(
    ctx,
    state,
    "transport bar in viewport",
    probe.transport !== null && contains(view, probe.transport),
    probe.transport === null
      ? "not found"
      : `${ySpan(probe.transport)} in ${ySpan(view)}`,
  );
}

function recordPanelHeader(
  ctx: StateContext,
  state: StateKey,
  probe: LayoutProbe,
): void {
  const panel = probe.panel;
  if (panel === null) {
    record(ctx, state, "panel present", false, "dialog not found");
    return;
  }
  const clip = intersect(
    viewportBox(probe.viewport.width, probe.viewport.height),
    panel.scrollport,
  );
  recordVisible(
    ctx,
    state,
    "panel heading row",
    panel.headingRow,
    clip,
    panel.headingHit,
  );
  recordVisible(
    ctx,
    state,
    "panel Close button",
    panel.close,
    clip,
    panel.closeHit,
  );
}

/** A — the gallery panel over the committed fixture, as a visitor first sees it. */
export async function stateA(ctx: StateContext): Promise<void> {
  const { page } = ctx;
  await waitFor(
    ctx,
    "the gallery panel to open on first load",
    FIRST_LOAD_MS,
    () => page.evaluate(probeLayout, SELECTORS),
    (p) => p.panel !== null && p.transport !== null,
  );
  ctx.step("measuring state A");
  await page.evaluate(settle, undefined);
  // Opening focuses the first card, which may scroll the panel; the assertion is
  // about scrollTop 0, so that is where it is measured.
  const initialScrollTop = await page.evaluate(resetPanelScroll, SELECTORS);
  if (initialScrollTop !== null && initialScrollTop !== 0) {
    ctx.report.note(
      `${ctx.viewport} A: panel opened scrolled to ${initialScrollTop}; measured at 0`,
    );
  }
  const probe = await page.evaluate(probeLayout, SELECTORS);
  recordPanelHeader(ctx, "A", probe);

  const reach = await page.evaluate(probeLastCardReach, SELECTORS);
  if (reach === null || reach.card === null) {
    record(ctx, "A", "last card reachable", false, "no scenario cards");
  } else {
    const clip = intersect(
      viewportBox(probe.viewport.width, probe.viewport.height),
      reach.scrollport,
    );
    record(
      ctx,
      "A",
      "last card reachable",
      contains(clip, reach.card) && reach.hit,
      `at scrollTop ${reach.scrollTop}: ${ySpan(reach.card)} in ${ySpan(clip)}` +
        (reach.hit ? "" : " · hit-test misses"),
    );
  }
  recordTransportInView(ctx, "A", probe);
}

/** B — the largest scenario, loaded the way a visitor loads it: its card. */
export async function stateB(
  ctx: StateContext,
  scenario: Scenario,
): Promise<void> {
  const { page } = ctx;
  ctx.step("clicking the scenario card");
  const click = await page.evaluate(clickScenario, {
    panel: SELECTORS.panel,
    title: scenario.title,
  });
  if (!click.clicked) {
    throw new Error(
      `no card titled "${scenario.title}" (saw: ${click.titles.join(" | ")})`,
    );
  }
  await waitFor(
    ctx,
    `the ${scenario.cars}-car replay to load (tower rows)`,
    SCENARIO_LOAD_MS,
    async () => {
      const p = await page.evaluate(probeLayout, SELECTORS);
      // A failed load keeps the panel open with the reason in an alert: say it
      // now rather than wait out the budget.
      if (p.panel?.alert != null) {
        throw new Error(`the gallery reported: ${p.panel.alert}`);
      }
      return p;
    },
    (p) => p.panel === null && p.towerRows === scenario.cars,
  );
  ctx.step("measuring state B");
  await page.evaluate(settle, undefined);
  const probe = await page.evaluate(probeLayout, SELECTORS);
  const view = viewportBox(probe.viewport.width, probe.viewport.height);
  record(
    ctx,
    "B",
    "loaded",
    probe.towerRows === scenario.cars,
    `${String(probe.towerRows)}/${scenario.cars} tower rows`,
  );

  const minHeight = Math.max(
    CANVAS_MIN_HEIGHT_PX,
    CANVAS_MIN_HEIGHT_FRAC * view.height,
  );
  const minWidth = CANVAS_MIN_WIDTH_FRAC * view.width;
  if (probe.canvas === null || probe.canvasCount !== 1) {
    // Measuring the wrong canvas would be worse than measuring none.
    record(
      ctx,
      "B",
      "canvas size",
      false,
      `expected exactly one canvas, found ${probe.canvasCount}`,
    );
  } else {
    record(
      ctx,
      "B",
      "canvas height",
      probe.canvas.height >= minHeight,
      `${probe.canvas.height.toFixed(1)} px (min ${minHeight.toFixed(1)})`,
    );
    record(
      ctx,
      "B",
      "canvas width",
      probe.canvas.width >= minWidth,
      `${probe.canvas.width.toFixed(1)} px (min ${minWidth.toFixed(1)})`,
    );
  }

  for (const [what, other] of [
    ["transport bar", probe.transport],
    ["canvas", probe.canvas],
  ] as const) {
    if (probe.aside === null || other === null) {
      record(ctx, "B", `aside clear of ${what}`, false, "not found");
      continue;
    }
    record(
      ctx,
      "B",
      `aside clear of ${what}`,
      !overlaps(probe.aside, other),
      `aside ${ySpan(probe.aside)} · ${what} ${ySpan(other)} · overlap ${size(intersect(probe.aside, other))}`,
    );
  }

  recordTransportInView(ctx, "B", probe);

  record(
    ctx,
    "B",
    "no horizontal overflow",
    probe.scrollWidth <= view.width + H_OVERFLOW_SLACK_PX,
    `scrollWidth ${probe.scrollWidth} vs innerWidth ${view.width}`,
  );

  if (probe.legend === null || probe.header === null) {
    record(ctx, "B", "legend clear of header", false, "not found");
  } else {
    record(
      ctx,
      "B",
      "legend clear of header",
      !overlaps(probe.legend, probe.header),
      `legend ${ySpan(probe.legend)} · header ${ySpan(probe.header)}`,
    );
  }
}

/** C — the gallery reopened from the header, over the loaded replay. */
export async function stateC(ctx: StateContext): Promise<void> {
  const { page } = ctx;
  ctx.step("reopening the gallery");
  if (!(await page.evaluate(clickToggle, { toggle: SELECTORS.panelToggle }))) {
    throw new Error("the gallery toggle was not found");
  }
  await waitFor(
    ctx,
    "the gallery panel to reopen",
    PANEL_OPEN_MS,
    () => page.evaluate(probeLayout, SELECTORS),
    (p) => p.panel !== null,
  );
  ctx.step("measuring state C");
  await page.evaluate(settle, undefined);
  await page.evaluate(resetPanelScroll, SELECTORS);
  const probe = await page.evaluate(probeLayout, SELECTORS);
  if (probe.panel === null) {
    record(ctx, "C", "panel present", false, "dialog not found");
    return;
  }
  const visible = intersect(
    viewportBox(probe.viewport.width, probe.viewport.height),
    probe.panel.scrollport,
  );
  record(
    ctx,
    "C",
    "panel visible height",
    visible.height >= PANEL_MIN_VISIBLE_PX,
    `${visible.height.toFixed(1)} px (min ${PANEL_MIN_VISIBLE_PX})`,
  );
  recordPanelHeader(ctx, "C", probe);
}
