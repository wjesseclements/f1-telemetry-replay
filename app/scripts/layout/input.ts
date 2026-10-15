/**
 * input.ts — trusted input, sent over the DevTools Protocol (Slice 18).
 *
 * State D presses things the way a person does: a mouse press and release at a
 * point, and a key press. Chrome dispatches these as TRUSTED events from its
 * input pipeline, so they go through hit testing (a press lands on whatever is
 * on top at that point, not on the element a script picked), focus a pressed
 * button, and reach React like any real input. An in-page `.click()` would do
 * none of that, and the rows these feed (a badge that a tap can reach, focus
 * that comes back to it) are about exactly that.
 *
 * Node-side, like `accessibility.ts`: nothing here is shipped to the page as
 * source text, so `preflight.ts` has nothing of it to run.
 */
import type { CdpPage } from "./cdp";

/** A left-button press and release at (x, y), CSS px from the viewport. */
export async function trustedClick(
  page: CdpPage,
  x: number,
  y: number,
): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
}

/** Escape, pressed and released, delivered to whatever has focus. */
export async function trustedEscape(page: CdpPage): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
}
