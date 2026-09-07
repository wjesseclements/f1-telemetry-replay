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
 *
 * THE LAP INDICATOR, AND WHOSE LAP IT IS
 * --------------------------------------
 * `leaderLap` — the highest lap any car is on — not the tower's first row. The
 * running order lives inside `Hud` (local state, hysteresis and all), and lifting it
 * out would mean a second gap computation here or a 30 Hz store write; the max lap is
 * a pure function of the replay and the clock, needs neither, and IS the race leader
 * whenever the number differs. It is a NUMBER, never a car: ties are the normal case
 * and are not broken, and a number past the window's advertised range would display
 * honestly rather than clamp. Hidden entirely when no car carries lap data, so every
 * pre-Slice-14 file renders this bar exactly as before. On a closed single-lap file
 * it reads the same lap on every wrap — correct: the data is one lap, replayed.
 */
import { formatLapIndicator, formatLapTime } from "../engine/format";
import { leaderLap } from "../engine/laps";
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
  const lap = leaderLap(replay, clock);

  return (
    <section
      aria-label="Playback controls"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-panel px-4 py-2"
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

      {/* See the header: leaderLap's number, or nothing at all for a replay
          with no lap data. An <output> like the clock beside it — it is the
          same kind of transport-derived readout. */}
      {lap !== null && (
        <output className="font-mono text-xs font-bold tabular-nums tracking-wider text-txt">
          {formatLapIndicator(lap)}
        </output>
      )}

      {/* The scrubber is the one control that needs length rather than room. It takes
          the leftover width on a wide bar and a full row of its own once the bar
          wraps — `order-last` keeps it below the buttons there rather than splitting
          them. */}
      <div className="order-last w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
        <Scrubber
          clock={clock}
          duration={duration}
          sampleRateHz={sampleRateHz}
          onSeek={seek}
        />
      </div>

      <span className="font-mono text-xs tabular-nums text-dim">
        {formatLapTime(duration)}
      </span>

      <SpeedControl speedMult={speedMult} onChange={setSpeedMult} />
    </section>
  );
}
