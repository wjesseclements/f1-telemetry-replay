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
import { readChromeColors } from "./palette";
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

    /** Size the backing store and refit the track. Resize-time work only. */
    const measure = (): Viewport => {
      const dpr = window.devicePixelRatio || 1;
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      return {
        width,
        height,
        dpr,
        fit: fitTransform(scene.bounds, width, height, PAD_PX),
      };
    };

    let view = measure();
    const observer = new ResizeObserver(() => {
      view = measure();
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
      // render path entirely.
      const { isPlaying, speedMult, seekTarget, consumeSeek } =
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
      drawFrame(ctx, scene, view, snapshots, colors);
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
