/**
 * TransportBar.tsx — play/pause, restart, scrub, speed.
 *
 * Subscribes to the telemetry channel for the clock (<=30 Hz) and to the transport store
 * for the discrete state a human changes. It is a SIBLING of `TrackCanvas`, never an
 * ancestor: re-rendering here at 30 Hz must never pull the canvas back into React's
 * render path (CLAUDE.md rule 1).
 *
 * Every control writes to the store and nothing else. The clock lives in the render
 * loop's ref and this component cannot reach it, which is the point — `seek` is a
 * request the loop applies exactly, so the UI never has to know where the clock is in
 * order to move it.
 */
import { formatLapTime } from "../engine/format";
import type { Replay } from "../engine/schema";
import { useTransport } from "../store/transport";
import { useTelemetry } from "../telemetry/useTelemetry";
import { FOCUS_RING } from "./focus";
import { Scrubber } from "./Scrubber";
import { SpeedControl } from "./SpeedControl";

export interface TransportBarProps {
  replay: Replay;
}

export function TransportBar({ replay }: TransportBarProps) {
  const { clock } = useTelemetry();
  const isPlaying = useTransport((s) => s.isPlaying);
  const speedMult = useTransport((s) => s.speedMult);
  const togglePlay = useTransport((s) => s.togglePlay);
  const setSpeedMult = useTransport((s) => s.setSpeedMult);
  const seek = useTransport((s) => s.seek);

  const { duration, sampleRateHz } = replay.meta;

  return (
    <section
      aria-label="Playback controls"
      className="flex items-center gap-3 border-t border-line bg-panel px-4 py-2"
    >
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause" : "Play"}
        aria-keyshortcuts="Space"
        className={`rounded border border-line px-3 py-1 font-mono text-xs font-bold text-txt hover:border-accent ${FOCUS_RING}`}
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>

      <button
        type="button"
        onClick={() => seek(0)}
        aria-label="Restart lap"
        aria-keyshortcuts="Home"
        className={`rounded border border-line px-3 py-1 font-mono text-xs text-dim hover:text-txt ${FOCUS_RING}`}
      >
        ↺
      </button>

      {/* tabular-nums so the digits do not jitter the layout as the clock runs. */}
      <output className="font-mono text-xs tabular-nums text-txt">
        {formatLapTime(clock)}
      </output>

      <Scrubber
        clock={clock}
        duration={duration}
        sampleRateHz={sampleRateHz}
        onSeek={seek}
      />

      <span className="font-mono text-xs tabular-nums text-dim">
        {formatLapTime(duration)}
      </span>

      <SpeedControl speedMult={speedMult} onChange={setSpeedMult} />
    </section>
  );
}
