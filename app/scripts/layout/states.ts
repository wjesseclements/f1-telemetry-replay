/**
 * states.ts — the three states the layout check visits, and what it asserts in
 * each.
 *
 *   A  first load — the gallery panel open over the committed fixture;
 *   B  the largest gallery scenario (most cars) loaded by clicking its card;
 *   C  the gallery reopened over that replay.
 *
 * Every threshold is named and justified where it is declared. Every selector is
 * an existing role, label, id or ARIA attribute in the app — no test ids were
 * added. Every row is geometry but one: in B, the transport's two icon buttons'
 * names are read from Chrome's accessibility tree (`accessibility.ts`).
 */
import { judgeNames, readAxText } from "./accessibility";
import type { CdpPage } from "./cdp";
import {
  contains,
  intersect,
  overlaps,
  sameBox,
  size,
  viewportBox,
  xySpan,
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
 * Where the check finds things — every dependency it has on the app's markup, in
 * one place (the in-page probes take all of it as their argument). The legend is
 * found by its accessible name, which for a `<figure>` is its `<figcaption>`.
 */
export const SELECTORS: Selectors = {
  header: "main > header",
  transport: 'section[aria-label="Playback controls"]',
  // The toggle has an id (the event card's focus fallback). Restart has none,
  // and is found by the key it answers to.
  playToggle: "#transport-play-toggle",
  restart:
    'section[aria-label="Playback controls"] button[aria-keyshortcuts="Home"]',
  aside: 'aside[aria-label="Telemetry"]',
  tower: 'ul[aria-label="Running order"]',
  canvas: "main canvas",
  panel: '#featured-replays[role="dialog"]',
  panelToggle: 'button[aria-controls="featured-replays"]',
  card: "ul > li > button",
  cardTitle: "span",
  close: "button",
  alert: '[role="alert"]',
  legend: "figure",
  legendCaption: "figcaption",
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
 * The track canvas's minimum height. The track is fitted inside margins that
 * scale with the canvas (`canvasInsets`, `src/engine/geometry.ts`; Slice 26): on a
 * canvas this short, 32 px at the top and 46 px at the bottom (the speed legend's
 * row), so a 200 px canvas leaves 122 px for the circuit itself (108 px under the
 * fixed 46 px a side it replaced) — a thumbnail. That is the floor, not a target.
 */
const CANVAS_MIN_HEIGHT_PX = 200;
/**
 * …and at least this share of the viewport's height (244 px on a 812 px phone).
 * The fixed floor alone would let a tall screen pass with the HUD owning most of
 * it; the track is the product, so it keeps at least ~a third of the height.
 *
 * ONE floor (Slice 25): the stacked strip's cap in `src/components/Hud.tsx`
 * reserves exactly max(CANVAS_MIN_HEIGHT_PX, CANVAS_MIN_HEIGHT_FRAC of the
 * height) for the track, as `max(12.5rem, 30dvh + 1px)`. Change one, change
 * both. The layout meets this rule; the rule was not loosened to meet the
 * layout. The 1px is the canvas's own: `TrackCanvas` sizes it from its cell's
 * whole-px `clientHeight`, and with a bare `30dvh` the cell measured 200.1 px at
 * 375x667 and the canvas 200.0. If the canvas is ever sized from fractional
 * boxes, the 1px becomes 1 px of strip given away for nothing; drop it then.
 */
const CANVAS_MIN_HEIGHT_FRAC = 0.3;
/**
 * The canvas's minimum share of the viewport's width. The side-by-side layout
 * gives the HUD a fixed column: 224 px from `md` (`md:w-56`), which is under half
 * of every `md` viewport, and 256 px below it (`side:w-64`, a screen 5:4 or
 * wider; Slice 25), which is under half of any viewport 512 px wide or more. The
 * smallest phone held sideways, 568x320, leaves 312 px of track. A 5:4 window
 * narrower than 512 px (so under 410 px tall) would fail here; no phone is that
 * shape and no gated viewport is. Stacked, the canvas is full width. Under half
 * means a sidebar has grown into the track.
 */
const CANVAS_MIN_WIDTH_FRAC = 0.5;
/**
 * The gallery panel's minimum VISIBLE height when reopened over a loaded replay.
 * Measured with the panel at its top: the heading row ends ~57 px below the
 * scrollport's top edge (16 px scrim padding + 16 px card padding + a 24.5 px
 * row) and the first scenario card starts at ~70 px, 148.6 px tall at 1440 wide
 * and 166.5 px at 375. So 200 px shows the heading, its Close button and at least
 * 130 px of a card — what the panel is, and something to click in it. Less, and
 * reopening the gallery shows a sliver nobody can use. On a phone the row is
 * Close's 44 px touch floor (`overlay.ts`), so it ends at 77 and the first card
 * starts at 89, but there the panel is the whole screen.
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
  /**
   * Whether the app lays this viewport out as a phone (`phone:`), where the
   * gallery covers the whole screen. Decided by the check (`isPhoneLayout` in
   * `layout-check.ts`), never read from the page, so a variant that stops
   * matching fails the rows it decides rather than removing them.
   */
  phone: boolean;
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

/**
 * GEOMETRY ONLY: the bar's box lies inside the viewport. It does not say the bar
 * can be used, and in state A on a phone it cannot: the full-screen gallery
 * covers it with its wash and the page behind it is inert while it is open
 * (Slice 26), yet this row passes. That is intended — the bar is laid out where
 * it will be when the gallery closes — so read the row as "laid out", never as
 * "the transport works on first load".
 */
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

/**
 * On a phone the gallery covers the whole screen (`phone:fixed`, Slice 26): its
 * box IS the viewport's, within 1 px. A direct row, because the full-screen
 * gallery had none: 375x626's "last card reachable" failed with the gallery in
 * the cell only because the footer under the last card was ~10 px too tall
 * (Slice 26's review), and a one-line copy edit would have switched it off.
 * Recorded only at phone-layout viewports; a desktop gallery sits in the track
 * cell, and every desktop row already prints where.
 */
function recordPanelCovers(
  ctx: StateContext,
  state: StateKey,
  probe: LayoutProbe,
): void {
  if (!ctx.phone) return;
  const what = "panel covers the viewport";
  if (probe.panel === null) {
    record(ctx, state, what, false, "dialog not found");
    return;
  }
  const view = viewportBox(probe.viewport.width, probe.viewport.height);
  record(
    ctx,
    state,
    what,
    sameBox(probe.panel.box, view),
    `${xySpan(probe.panel.box)} vs ${xySpan(view)}`,
  );
}

/**
 * The names the transport's two icon buttons carry (`TransportBar.tsx`): the
 * toggle says what a press will do. Copied rather than imported, because the
 * component module brings React with it; a rename is a copy change, and this row
 * failing on one is how the check hears of it.
 */
const TRANSPORT_NAMES = {
  playToggle: ["Play", "Pause"],
  restart: ["Restart lap"],
} as const;

/**
 * Play/pause and restart repeat their names as tooltips (ruled 2026-10-13), and
 * Chrome exposes a `title` as a description unless it equals the button's
 * rendered text. A glyph drawn as text, `aria-hidden` or not, left each button
 * described by its own name, which a screen reader may read a second time, and
 * every geometric row passed (`accessibility.ts` has the numbers). Read in B,
 * the loaded scenario with no overlay open, so neither button is inert. A
 * failed read is this row's FAIL, never a lost state C.
 */
async function recordTransportNames(ctx: StateContext): Promise<void> {
  const what = "transport names carry no description";
  ctx.step("reading the transport's accessible names");
  try {
    const verdict = judgeNames([
      {
        what: "toggle",
        expected: TRANSPORT_NAMES.playToggle,
        reading: await readAxText(ctx.page, SELECTORS.playToggle),
      },
      {
        what: "restart",
        expected: TRANSPORT_NAMES.restart,
        reading: await readAxText(ctx.page, SELECTORS.restart),
      },
    ]);
    record(ctx, "B", what, verdict.pass, verdict.measured);
  } catch (err) {
    record(
      ctx,
      "B",
      what,
      false,
      `could not read the accessibility tree: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  recordPanelCovers(ctx, "A", probe);
}

/** B — the largest scenario, loaded the way a visitor loads it: its card. */
export async function stateB(
  ctx: StateContext,
  scenario: Scenario,
): Promise<void> {
  const { page } = ctx;
  ctx.step("clicking the scenario card");
  const click = await page.evaluate(clickScenario, {
    sel: SELECTORS,
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

  // Ruled 2026-10-13. Since Slice 27 the header is a grid item on the
  // shortest landscape phones (`fulltrack:`, App.tsx), placed beside the track
  // rather than above it, and a header placed in the track's cell sat over the
  // canvas with every other row passing (Slice 27's review, by mutation).
  // Before, the flex column made that impossible. Both spans, because there
  // the two are side by side.
  if (probe.header === null || probe.canvas === null) {
    record(ctx, "B", "header clear of the track", false, "not found");
  } else {
    record(
      ctx,
      "B",
      "header clear of the track",
      !overlaps(probe.header, probe.canvas),
      `header ${xySpan(probe.header)} · canvas ${xySpan(probe.canvas)} · overlap ${size(intersect(probe.header, probe.canvas))}`,
    );
  }

  await recordTransportNames(ctx);
}

/** C — the gallery reopened from the header, over the loaded replay. */
export async function stateC(ctx: StateContext): Promise<void> {
  const { page } = ctx;
  ctx.step("reopening the gallery");
  if (!(await page.evaluate(clickToggle, SELECTORS))) {
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
  recordPanelCovers(ctx, "C", probe);
}
