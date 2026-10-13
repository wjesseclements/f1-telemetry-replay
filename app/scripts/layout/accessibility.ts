/**
 * accessibility.ts — what Chrome's accessibility tree calls a control, read over
 * the DevTools Protocol, and the verdict on it.
 *
 * The one row of the layout check that is not geometry (Slice 27, fourth batch).
 * Play/pause and restart repeat their names as tooltips, and Chrome 155 exposes a
 * `title` as a DESCRIPTION unless it equals the button's rendered text,
 * `aria-hidden` text included — so whether a screen reader is handed the name a
 * second time depends on how the glyph is drawn, which no jsdom test can see
 * (jsdom reports every title as a description). Measured on 2026-10-13, ten
 * viewports, playing and paused: a description equal to the name in 40 of 40
 * readings with the glyph as text, labelled by `aria-label` or by `sr-only` text
 * alike, and in 0 of 40 with the glyph as generated content (`TransportBar.tsx`).
 * This reads Chrome's answer at every gated viewport, so in Chrome the fix
 * cannot regress unseen.
 *
 * The reading is Node-side CDP, not an in-page probe: nothing here is shipped to
 * the page as source text, so `preflight.ts` has nothing of it to run. The verdict
 * (`judgeNames`) is pure and unit-tested; `readAxText` is the plumbing.
 */
import type { CdpPage } from "./cdp";

/** A node's name and description as Chrome exposes them; "" for an absent one. */
export interface AxText {
  name: string;
  description: string;
}

/** The fields of a CDP `Accessibility.AXNode` read here. */
export interface AxNodeLike {
  backendDOMNodeId?: number;
  name?: { value?: unknown };
  description?: { value?: unknown };
}

/** What reading one control found: its text, or why there is none. */
export type AxReading = AxText | "not found" | "no accessibility node";

/** One control the row checks, and the names it may carry. */
export interface NameCheck {
  /** How the measured column calls it. */
  what: string;
  /** Every name it may carry; anything else fails. */
  expected: readonly string[];
  reading: AxReading;
}

const text = (value: { value?: unknown } | undefined): string =>
  value?.value === undefined ? "" : String(value.value);

/**
 * The text of the node among `nodes` that belongs to DOM node `backendNodeId`,
 * or null when none does. By id, never by position: `getPartialAXTree` may
 * answer with more than the one node asked for.
 */
export function axTextOf(
  nodes: readonly AxNodeLike[],
  backendNodeId: number,
): AxText | null {
  const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
  if (node === undefined) return null;
  return { name: text(node.name), description: text(node.description) };
}

/**
 * Every control has one of its expected names and no description at all. The
 * measured column prints each control's name and description as read, so a
 * FAIL says what Chrome said.
 */
export function judgeNames(checks: readonly NameCheck[]): {
  pass: boolean;
  measured: string;
} {
  let pass = true;
  const parts = checks.map(({ what, expected, reading }) => {
    if (typeof reading === "string") {
      pass = false;
      return `${what}: ${reading}`;
    }
    if (!expected.includes(reading.name) || reading.description !== "") {
      pass = false;
    }
    return `${what}: name ${JSON.stringify(reading.name)}, description ${JSON.stringify(reading.description)}`;
  });
  return { pass, measured: parts.join(" · ") };
}

/**
 * Chrome's name and description for the first element matching `selector`.
 * `DOM.querySelector` answers node id 0 for no match.
 */
export async function readAxText(
  page: CdpPage,
  selector: string,
): Promise<AxReading> {
  const { root } = await page.send<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    { depth: 0 },
  );
  const { nodeId } = await page.send<{ nodeId: number }>("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (nodeId === 0) return "not found";
  const { node } = await page.send<{ node: { backendNodeId: number } }>(
    "DOM.describeNode",
    { nodeId },
  );
  const { nodes } = await page.send<{ nodes: AxNodeLike[] }>(
    "Accessibility.getPartialAXTree",
    { nodeId, fetchRelatives: false },
  );
  return axTextOf(nodes, node.backendNodeId) ?? "no accessibility node";
}
