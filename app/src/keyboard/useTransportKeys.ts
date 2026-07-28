/**
 * useTransportKeys.ts — global keyboard control of the transport.
 *
 * One `keydown` listener on `window`, mounted once by `App`. Every binding writes to the
 * transport store and nothing else; like every other consumer in this slice, it cannot
 * reach the clock and does not need to.
 *
 * Two things here are less obvious than they look.
 *
 * **Native first.** The controls are real `<button>`s and a real `<input type="range">`,
 * which already handle Space and the arrow keys themselves. Without a guard, arrowing a
 * focused scrubber would seek twice per press — once natively, once here — and land
 * somewhere neither path intended. So this handler stands down whenever the event landed
 * somewhere that already handles that key.
 *
 * **Relative seeks without a clock.** `seek` takes an absolute position, and the clock
 * lives in the render loop's ref where no component can read it. Relative seeks are
 * therefore based on the last published clock, which is at most one HUD frame (~33 ms)
 * stale. Under key-repeat that staleness would compound — ten fast presses of the same
 * arrow would each build on a clock that had not caught up yet, landing short. So the
 * hook remembers the target it last issued and prefers it while it is still newer than
 * anything published, which makes a burst of presses land exactly where counting says.
 */
import { useEffect, useRef } from "react";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";

/** Arrow seek, in seconds. */
export const SMALL_STEP_S = 1;
/** Shift+arrow seek, in seconds. */
export const LARGE_STEP_S = 5;

/** Elements that handle arrow/Home/End themselves. */
const SELF_STEPPING = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/**
 * Input types the platform ACTIVATES on Space. Deliberately a type list and not the
 * `INPUT` tag: `<input type="range">` — the Scrubber — does not activate on Space in
 * any browser, so exempting the whole tag would silently remove play/pause from the
 * control most likely to hold focus during playback.
 */
const SPACE_ACTIVATED_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "color",
]);

/**
 * Does the platform already do something with Space on this element?
 *
 * The file's native-first rule, generalised. It used to be `tag === "BUTTON"`, which
 * was true of every control that existed at the time; the file picker
 * (`<input type="file">`) is the first control that activates on Space without being
 * a button, and it would otherwise open the file dialog AND toggle playback on one
 * keypress.
 *
 * `a[href]` is in the list for consistency with the rule's intent even though links
 * activate on Enter rather than Space — there is no double-activation to prevent
 * there, so its only effect is to leave Space alone while a link has focus.
 */
function nativelyActivatable(target: EventTarget | null): boolean {
  // The listener is on `window`, so an unfocused keypress arrives with `window`
  // itself as the target — not an element, and not something to ask about tag names.
  if (!(target instanceof Element)) return false;
  const el = target;
  switch (el.tagName) {
    case "BUTTON":
    case "SUMMARY":
      return true;
    case "A":
      return el.hasAttribute("href");
    case "INPUT":
      return SPACE_ACTIVATED_INPUT_TYPES.has((el as HTMLInputElement).type);
    default:
      return el.getAttribute("role") === "button";
  }
}

const NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function useTransportKeys(replay: Replay | null): void {
  /**
   * The last position this hook asked for, and the published clock it was based on.
   * A ref because it is bookkeeping for the next event, never something to render.
   */
  const pending = useRef<{ target: number; basedOn: number } | null>(null);

  useEffect(() => {
    if (replay === null) return;
    const { duration, sampleRateHz } = replay.meta;

    /** Where the clock is, as well as this hook can know. */
    const currentClock = (): number => {
      const published = telemetry.getSnapshot().clock;
      const p = pending.current;
      // Keep using our own target until the published clock reflects it (or moves past
      // it, which means playback carried on from there).
      if (p !== null && p.basedOn === published) return p.target;
      pending.current = null;
      return published;
    };

    const seekTo = (seconds: number) => {
      const clamped = Math.min(duration, Math.max(0, seconds));
      pending.current = {
        target: clamped,
        basedOn: telemetry.getSnapshot().clock,
      };
      useTransport.getState().seek(clamped);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Someone else already dealt with it.
      if (event.defaultPrevented) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";

      if (event.key === " " || event.code === "Space") {
        // A focused button — or file picker, or checkbox — activates on Space
        // natively; handling it here as well would both toggle playback and press
        // the control. See `nativelyActivatable`.
        if (nativelyActivatable(event.target)) return;
        event.preventDefault(); // stop the page scrolling
        useTransport.getState().togglePlay();
        return;
      }

      if (!NAVIGATION_KEYS.has(event.key)) return;
      // The range input steps itself — see the file header.
      if (SELF_STEPPING.has(tag)) return;

      const step = event.shiftKey ? LARGE_STEP_S : SMALL_STEP_S;

      switch (event.key) {
        case "ArrowLeft":
        case "PageDown":
          event.preventDefault();
          seekTo(
            currentClock() - (event.key === "PageDown" ? LARGE_STEP_S : step),
          );
          return;
        case "ArrowRight":
        case "PageUp":
          event.preventDefault();
          seekTo(
            currentClock() + (event.key === "PageUp" ? LARGE_STEP_S : step),
          );
          return;
        case "Home":
          event.preventDefault();
          seekTo(0);
          return;
        case "End":
          event.preventDefault();
          // One grid step short of the end: `duration` itself wraps to 0, which would
          // make "End" indistinguishable from "Home".
          seekTo(duration - 1 / sampleRateHz);
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [replay]);
}
