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
 *
 * ON A SHORT PHONE (Slice 27, `compact:` in tailwind.config.js) the bar is as thin
 * as its controls allow and no thinner: every button and the scrubber keep a 44x44
 * CSS px target (the human's ruling; `touchTarget.ts`), with no vertical padding,
 * 6 px gaps and 8 px side margins. In landscape it is one 45 px row (43 before);
 * upright it is three 44 px rows, 133 px (109 before) — the scrubber's own 44 px
 * row costs 20 of those, and the header's 38 px saving pays for it (at 440 px
 * wide a one-car bar's buttons share one row, two rows, 89 px). The narrower
 * gaps and margins are what keep the scrubber's width: 122 px at 667x375 with 22
 * cars, where 52 px of extra button width would have left it 92. Same controls,
 * same order, same names; no button changes width between Play and Pause.
 * On the shortest landscape phones (`fulltrack:`) the page is a grid (App.tsx,
 * `FULL_TRACK_GRID`), and the bar is its bottom row, across both columns.
 */
import { useMemo } from "react";
import { formatLapIndicator, formatLapTime } from "../engine/format";
import { leaderLap } from "../engine/laps";
import type { Replay } from "../engine/schema";
import { statusAt, statusSegments } from "../engine/trackStatus";
import { useTransport } from "../store/transport";
import { useTelemetry } from "../telemetry/useTelemetry";
import { COMPACT_FOCUS_RING, FOCUS_RING } from "./focus";
import { Scrubber } from "./Scrubber";
import { SpeedControl } from "./SpeedControl";
import { StatusFlag } from "./StatusFlag";
import { TOUCH_TARGET } from "./touchTarget";

/**
 * The play/pause toggle's DOM id — the event card's focus fallback (see
 * `EventCard`): the card paused playback, so when it closes with nowhere better
 * to send focus, it lands on the control that resumes it.
 */
export const PLAY_TOGGLE_ID = "transport-play-toggle";

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
  // The flag under the playhead: a scan over a handful of intervals at ≤30 Hz,
  // the same species of transport-derived readout as `leaderLap` beside it.
  const flag = statusAt(replay.trackStatus, clock);
  // The scrubber's tint is a function of static data alone — memoised on the
  // replay, untouched by the tick.
  const segments = useMemo(
    () => statusSegments(replay.trackStatus, replay.meta.duration),
    [replay],
  );

  return (
    <section
      aria-label="Playback controls"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-panel px-4 py-2 compact:gap-x-1.5 compact:gap-y-0 compact:px-2 compact:py-0 fulltrack:col-span-full fulltrack:row-start-3"
    >
      <button
        type="button"
        id={PLAY_TOGGLE_ID}
        onClick={togglePlay}
        aria-label={isPlaying ? "Pause" : "Play"}
        aria-keyshortcuts="Space"
        className={`rounded border border-line px-3 py-1 font-mono text-xs font-bold text-txt hover:border-accent ${TOUCH_TARGET} ${FOCUS_RING} ${COMPACT_FOCUS_RING}`}
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>

      <button
        type="button"
        onClick={() => seek(0)}
        aria-label="Restart lap"
        aria-keyshortcuts="Home"
        className={`rounded border border-line px-3 py-1 font-mono text-xs text-dim hover:text-txt ${TOUCH_TARGET} ${FOCUS_RING} ${COMPACT_FOCUS_RING}`}
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

      {/* The flag the clock is under. Nothing at all for a replay with no status
          data — the same absence contract as the lap indicator beside it. */}
      <StatusFlag status={flag} />

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
          segments={segments}
        />
      </div>

      <span className="font-mono text-xs tabular-nums text-dim">
        {formatLapTime(duration)}
      </span>

      <SpeedControl speedMult={speedMult} onChange={setSpeedMult} />
    </section>
  );
}
