/**
 * TrackCanvas.tsx — the one animation loop, and the only owner of the clock.
 *
 * CLAUDE.md architecture rule 1 in code form:
 *
 *  - a single `requestAnimationFrame` loop advances a clock held in `clockRef`;
 *  - the clock is never React state and never store state, so no frame re-renders
 *    anything;
 *  - the loop READS the transport with `useTransport.getState()` instead of
 *    subscribing to it, so even play/pause and speed changes leave this component's
 *    render count at one.
 *
 * Everything the loop touches lives inside the effect: the frame callback, the
 * viewport, the previous timestamp. Only the clock is a ref, because only the clock
 * has to survive a resize or a StrictMode remount without restarting the lap.
 *
 * The loop draws every frame, including while paused. That is deliberate for now:
 * a seek or a resize while paused repaints for free, and the loop stays a straight
 * line with no wake-up path to get wrong. If idle battery ever matters, the fix is
 * to skip the DRAW when the clock and viewport are both unchanged since the last
 * frame — not to stop the rAF, which would put resuming back on a timer.
 */
import { useEffect, useMemo, useRef } from "react";
import { advanceClock, frameDelta } from "../engine/clock";
import { fitTransform } from "../engine/geometry";
import { sampleAt, wrapClock } from "../engine/interpolate";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";
import { readChromeColors } from "./palette";
import { buildScenePaths, type ScenePaths } from "./paths";
import { buildScene, drawFrame, type Viewport } from "./scene";

/** Margin, in CSS pixels, between the fitted track and the canvas edge. */
export const PAD_PX = 46;

export interface TrackCanvasProps {
  /** A validated replay. Loading and validation happen before mount. */
  replay: Replay;
}

export function TrackCanvas({ replay }: TrackCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * The live playback clock, in seconds. A ref, not state — see the file header.
   * It outlives the effect so resizing (or StrictMode's remount) resumes the lap
   * where it was rather than snapping back to the start/finish line.
   */
  const clockRef = useRef(0);
  /**
   * Which replay the clock belongs to.
   *
   * The clock ref deliberately outlives the effect so a resize or StrictMode's
   * remount resumes the lap. Loading a DIFFERENT replay is the one case where that
   * is wrong: 45 s into a 58 s lap, a picked 30 s lap would start most of the way
   * round someone else's circuit. Comparing identity distinguishes the two — a
   * remount sees the same object and keeps its clock.
   */
  const clockOwnerRef = useRef(replay);

  // Rotating and bounding every sample is O(samples): once per replay, never per
  // frame.
  const scene = useMemo(() => buildScene(replay), [replay]);
  const duration = replay.meta.duration;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (wrap === null || canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const colors = readChromeColors();

    // A new lap starts at the line. See `clockOwnerRef`.
    if (clockOwnerRef.current !== replay) {
      clockOwnerRef.current = replay;
      clockRef.current = 0;
    }

    /**
     * Size the backing store, refit the track and re-project it into screen space.
     *
     * All the O(samples) drawing work lives here rather than in the frame callback:
     * the ribbon path, every sample's screen coordinates and the corner anchors
     * depend on the viewport, and the viewport changes on resize, not on the clock.
     */
    const measure = (): { view: Viewport; paths: ScenePaths } => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const fit = fitTransform(scene.bounds, width, height, PAD_PX);
      return {
        view: { width, height, dpr, fit },
        // Fresh trail painters: they refill to the covered portion on the next
        // frame, so a resize mid-lap redraws the trail at the new scale rather
        // than leaving it stretched. See `buildScenePaths`.
        paths: buildScenePaths(scene, fit),
      };
    };

    let measured = measure();
    const observer = new ResizeObserver(() => {
      measured = measure();
    });
    observer.observe(wrap);

    // Effect-local, not refs: a remount SHOULD forget the last frame's timestamp
    // (so the first frame back measures no elapsed time) and re-measure the view.
    let prevMs: number | null = null;
    let rafId = 0;

    const frame = (nowMs: number) => {
      rafId = requestAnimationFrame(frame);

      const dt = frameDelta(prevMs, nowMs);
      // Advanced even while paused, so unpausing measures one frame, not the
      // length of the pause.
      prevMs = nowMs;

      // Read, don't subscribe: this is what keeps transport changes off React's
      // render path entirely. `focusedCarIndex` rides the same read — which is the
      // reason it lives in this store at all. Held in React and passed down as a
      // prop, changing the followed car would re-render this component; here it
      // costs one property access inside a callback that already runs every frame.
      const { isPlaying, speedMult, seekTarget, consumeSeek, focusedCarIndex } =
        useTransport.getState();

      // The clock ref is read and written here and nowhere else. That is what
      // keeps it out of render — and what keeps `react-hooks/refs` quiet without
      // a suppression: everything below runs inside the effect's frame callback.
      if (seekTarget !== null) {
        // A seek lands EXACTLY on its target: this frame's elapsed time is spent
        // getting there, not added on top. Advancing as well would put the clock
        // one frame past the requested position — 0.1 s out at 4x — so a scrub
        // would never quite agree with the position it was released at.
        clockRef.current = wrapClock(seekTarget, duration);
        consumeSeek();
      } else if (isPlaying) {
        // Scaled deltas accumulate; the clock is never derived from an absolute
        // timestamp, so changing speed does not rescale elapsed time. Wrapping is
        // the engine's `wrapClock`, reached through `advanceClock`.
        clockRef.current = advanceClock(
          clockRef.current,
          dt,
          speedMult,
          duration,
        );
      }

      const snapshots = sampleAt(replay, clockRef.current);
      drawFrame(
        ctx,
        scene,
        measured.paths,
        measured.view,
        snapshots,
        colors,
        focusedCarIndex,
      );

      // Hand the same snapshot to the HUD. This is a plain function call into a module,
      // NOT a setState: the channel rate-limits to <=30fps and wakes its subscribers
      // itself, so nothing here enters React's render path and this component's commit
      // count stays at one. `nowMs` is the rAF timestamp, so the HUD's cadence is
      // measured on the same clock as the frames.
      telemetry.publish(nowMs, clockRef.current, snapshots);
    };

    rafId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [replay, scene, duration]);

  return (
    <div ref={wrapRef} className="relative h-full w-full min-w-0">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
