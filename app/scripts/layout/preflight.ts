/**
 * preflight.ts — prove the page can run the shipped probes before trusting a
 * single measurement.
 *
 * The in-page probes travel as their own source text (`CdpPage.evaluate` sends
 * `fn.toString()`), which works only while the toolchain that loads this script
 * leaves each function self-contained. A transform that injects a module-scope
 * helper breaks that silently on the Node side: esbuild's `keepNames` wraps every
 * named arrow in `__name(...)`, a down-levelled `async` becomes `__async(...)`,
 * and the page has neither. Every probe would then throw a ReferenceError, every
 * state would "not be reached", and the table would read like a page full of
 * layout bugs (Slice 22's review). So each probe runs once first, on a blank page,
 * and a throw stops the run with a message that names the cause.
 *
 * On a blank page every probe takes its early-out path, which still executes its
 * top level — where a transform puts the helpers it wraps declarations in (the
 * one probe with named inner arrows, `probeLayout`, declares them first). A
 * helper reached only inside a branch the blank page skips would get past this;
 * the first evaluate to reach it would then fail with `in-page script threw:
 * ReferenceError: …`, naming the helper there instead. Measured with a scratch
 * `__name` wrapper around `probeLayout`'s `box`: exit 2 in 0.5 s, the message
 * below, nothing left running.
 */
import type { CdpPage } from "./cdp";
import {
  clickScenario,
  clickToggle,
  probeLastCardReach,
  probeLayout,
  resetPanelScroll,
  settle,
} from "./probe";
import { SELECTORS } from "./states";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Run every shipped probe on `page` (blank); throw naming the first that fails. */
export async function preflight(page: CdpPage): Promise<void> {
  const probes: [string, () => Promise<unknown>][] = [
    ["probeLayout", () => page.evaluate(probeLayout, SELECTORS)],
    ["resetPanelScroll", () => page.evaluate(resetPanelScroll, SELECTORS)],
    ["probeLastCardReach", () => page.evaluate(probeLastCardReach, SELECTORS)],
    [
      "clickScenario",
      () => page.evaluate(clickScenario, { sel: SELECTORS, title: "" }),
    ],
    ["clickToggle", () => page.evaluate(clickToggle, SELECTORS)],
    ["settle", () => page.evaluate(settle, undefined)],
  ];
  for (const [name, run] of probes) {
    try {
      await run();
    } catch (err) {
      throw new Error(
        [
          `the page cannot run the shipped probe \`${name}\`: ${message(err)}`,
          "  This is the toolchain, not the layout. Each probe is sent to Chrome as its",
          "  own source text, so it must be self-contained, and something now compiles",
          "  a module-scope reference into one: a helper a transform injected",
          "  (`__name`, `__async`), or a function the probe borrowed.",
          "  Fix: turn off the transform that injects the helper named above (esbuild's",
          "  `keepNames`, a down-levelled `async`), or inline what the probe borrowed",
          "  (scripts/layout/probe.ts).",
        ].join("\n"),
      );
    }
  }
}
