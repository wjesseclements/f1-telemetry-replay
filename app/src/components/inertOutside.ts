/**
 * inertOutside.ts — make everything outside one element inert, and undo it
 * (Slice 26).
 *
 * A modal dialog that is not a `<dialog>`. React 18 has no `inert` prop, and
 * `showModal()` would lift the element into the top layer, out of the track cell
 * it sits in on a desktop. So the attribute is set from outside React, the way
 * the `aria-hidden` libraries do it: walk from the element up to `<body>` and
 * mark every SIBLING on the way. Nothing on the path itself is touched, so the
 * element, its ancestors and its own subtree stay live, and everything else — the
 * header, the tower, the transport bar, the canvas — leaves the tab order, the
 * accessibility tree and hit testing until the returned undo runs.
 *
 * Three rules keep it safe:
 *
 *  - Another dialog is never made inert. If the event card fires while the
 *    gallery is open, both stay live, as both always were; neither can switch
 *    off the one a visitor is looking at.
 *  - Holds are counted per element. With two dialogs open, the first to close
 *    does not wake the page under the second.
 *  - An element that was already inert, not by this module, is left alone, and
 *    is still inert after the undo.
 *
 * What it does not cover: a sibling MOUNTED while the hold is on. None can be
 * today. On the walked levels the only things that come and go are the flag
 * strip (`StatusBanner`: `aria-hidden` and `pointer-events-none`, so nothing to
 * reach) and the event card (a dialog, which this would skip anyway). Everything
 * else that changes — tower rows, readouts — changes INSIDE an inert subtree.
 */

/** How many holds each element is inert under. Only this module's holds. */
const holds = new WeakMap<Element, number>();

/** Make every element outside `element` inert; returns the undo. */
export function inertOutside(element: Element): () => void {
  const held: Element[] = [];
  for (
    let node = element;
    node.parentElement !== null && node !== document.body;
    node = node.parentElement
  ) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.getAttribute("role") === "dialog") {
        continue;
      }
      const count = holds.get(sibling) ?? 0;
      if (count === 0) {
        if (sibling.hasAttribute("inert")) continue; // someone else's
        sibling.setAttribute("inert", "");
      }
      holds.set(sibling, count + 1);
      held.push(sibling);
    }
  }
  return () => {
    for (const sibling of held) {
      const count = (holds.get(sibling) ?? 1) - 1;
      if (count > 0) {
        holds.set(sibling, count);
      } else {
        holds.delete(sibling);
        sibling.removeAttribute("inert");
      }
    }
  };
}
