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
 * ON A COMPACT SCREEN (Slice 27, `compact:` in tailwind.config.js) the bar is as
 * thin as its controls allow and no thinner: every button and the scrubber keep a
 * 44x44 CSS px target (the human's ruling; `touchTarget.ts`), with no vertical
 * padding, 6 px gaps and 8 px side margins. In landscape it is one 45 px row (43
 * before). On a ~375 px upright phone it is three 44 px rows, 133 px (109
 * before): the scrubber's own 44 px row costs 20 of those, and the header's
 * saving pays for it. Not everywhere upright: at ~420–430 px wide a one-car bar
 * was two text rows (75 px) and is three now, so its canvas loses 20 px
 * (`UPRIGHT_PHONE` in tailwind.config.js has the numbers); at 440 px, and on a
 * 600 px window, the buttons share one row, two rows, 89 px. The narrower gaps
 * and margins are what keep the scrubber's width: 122 px at 667x375 with 22
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

/** The restart button's name, and its tooltip. */
const RESTART_LABEL = "Restart lap";

/**
 * Paints a span's `data-glyph` as its `::before` content, so the glyph is seen
 * but is not text (see the buttons below). Written out whole: Tailwind compiles
 * only class names it finds verbatim in a shipped file.
 */
const GLYPH = "before:content-[attr(data-glyph)]";

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
  // The play/pause toggle's name, and its tooltip: what a press will do.
  const playLabel = isPlaying ? "Pause" : "Play";
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
      {/* Play/pause and restart are icons at every size, so each repeats its
          name as a tooltip, verbatim and everywhere (ruled 2026-10-13): one
          constant for both, so the two cannot drift. The header's buttons have
          a tooltip only where their text label is hidden (App.tsx).

          So that the tooltip is not read as a second copy of the name, each
          button's TEXT is exactly its name: the name is `sr-only` text, never
          `aria-label` (ruled 2026-10-13), and the glyph is CSS generated
          content on an `aria-hidden` span (`data-glyph`), never text. Measured
          in Chrome 155 (2026-10-13, ten viewports, playing and paused): it
          exposes a `title` as a description unless the title equals the
          button's rendered text, `aria-hidden` text included. With
          `aria-label` and the glyph as text, the description repeated the name
          ("Pause" / "Pause") in 40 of 40 readings; with the glyph as
          `aria-hidden` text beside the `sr-only` name, still 40 of 40; with
          the glyph as generated content, 0 of 40, pixels unchanged. The
          header's buttons expose none because their icons are SVG, not
          because of how they are named. jsdom cannot see any of this; the
          layout check's "transport names carry no description" row reads
          Chrome's answer at every gated viewport. */}
      <button
        type="button"
        id={PLAY_TOGGLE_ID}
        onClick={togglePlay}
        title={playLabel}
        aria-keyshortcuts="Space"
        className={`rounded border border-line px-3 py-1 font-mono text-xs font-bold text-txt hover:border-accent ${TOUCH_TARGET} ${FOCUS_RING} ${COMPACT_FOCUS_RING}`}
      >
        <span
          aria-hidden="true"
          data-glyph={isPlaying ? "❚❚" : "▶"}
          className={GLYPH}
        />
        <span className="sr-only">{playLabel}</span>
      </button>

      <button
        type="button"
        onClick={() => seek(0)}
        title={RESTART_LABEL}
        aria-keyshortcuts="Home"
        className={`rounded border border-line px-3 py-1 font-mono text-xs text-dim hover:text-txt ${TOUCH_TARGET} ${FOCUS_RING} ${COMPACT_FOCUS_RING}`}
      >
        <span aria-hidden="true" data-glyph="↺" className={GLYPH} />
        <span className="sr-only">{RESTART_LABEL}</span>
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
