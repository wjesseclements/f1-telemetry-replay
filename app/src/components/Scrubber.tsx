/**
 * Scrubber.tsx — the lap position control.
 *
 * A native `<input type="range">`, which is the whole accessibility story for free:
 * tabbable, arrow/Home/End operable, announced as a slider, and draggable with a
 * pointer. Nothing here reimplements a slider.
 *
 * Two things are NOT free and are the reason this is its own component:
 *
 * 1. **Step.** Left unset, `step` defaults to 1, so an arrow press would jump a whole
 *    second while every other seek path moves in grid steps. It is set explicitly to
 *    one grid step — the finest position the engine can resolve. A smaller step would
 *    move the thumb without changing the rendered sample.
 *
 * 2. **The drag race.** The published clock arrives at up to 30 Hz. During playback the
 *    clock keeps advancing between drag events, so a purely snapshot-driven `value`
 *    would yank the thumb backwards under the finger. While a drag is in progress the
 *    component renders its own value instead. That local value exists ONLY to win that
 *    race — the seek is still committed on every change, so the canvas previews live.
 *
 * On release the local value clears and the scrubber returns to snapshot-driven. There
 * is no snap-back (the last seek already landed exactly, and `seek` lands exactly by
 * construction — see `TrackCanvas`) and no pause-on-scrub: `isPlaying` is never touched
 * here, so playback continues from wherever the thumb was let go.
 */
import { useEffect, useState } from "react";
import { formatLapTime } from "../engine/format";
import { FOCUS_RING } from "./focus";

export interface ScrubberProps {
  /** Current playback position in seconds, from the telemetry channel. */
  clock: number;
  /** Lap length in seconds — `meta.duration`, the same range the playhead uses. */
  duration: number;
  /** Samples per second; one grid step is the scrubber's `step`. */
  sampleRateHz: number;
  /** Commit a position. Wired to the transport store's `seek`. */
  onSeek: (seconds: number) => void;
}

export function Scrubber({
  clock,
  duration,
  sampleRateHz,
  onSeek,
}: ScrubberProps) {
  /** Non-null only while a pointer drag is in progress. */
  const [dragValue, setDragValue] = useState<number | null>(null);

  // A drag can end anywhere — off the input, outside the window. Listening on the
  // window rather than on the input means a release the input never sees still ends
  // the drag, instead of leaving the thumb stuck to the pointer.
  useEffect(() => {
    if (dragValue === null) return;
    const end = () => setDragValue(null);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragValue]);

  const value = dragValue ?? clock;

  const handleChange = (next: number) => {
    // Only track locally while dragging. A keyboard change has no drag in flight, so
    // it stays snapshot-driven and the thumb follows the clock as the loop applies it.
    if (dragValue !== null) setDragValue(next);
    onSeek(next);
  };

  return (
    <input
      type="range"
      min={0}
      max={duration}
      // From an off-grid clock the first arrow press snaps to the grid (17.79 -> 17.80)
      // rather than stepping a full 0.1; presses after that step normally. Deliberate —
      // the grid is the only position the engine can resolve. Verified in Chrome.
      step={1 / sampleRateHz}
      value={value}
      onPointerDown={() => setDragValue(value)}
      onChange={(e) => handleChange(Number(e.target.value))}
      aria-label="Lap position"
      // Without this a screen reader announces the raw number ("12.4"); the lap clock
      // is what the value actually means.
      aria-valuetext={formatLapTime(value)}
      className={`h-1 w-full min-w-0 cursor-pointer appearance-none rounded-full bg-line accent-accent ${FOCUS_RING}`}
    />
  );
}
