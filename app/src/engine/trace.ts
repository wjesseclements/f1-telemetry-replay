/**
 * trace.ts — the speed trace's geometry: a fixed playhead with a window scrolling past it.
 *
 * Pure and headless like the rest of the engine: this returns an SVG path string and a
 * playhead position, and knows nothing about React or the DOM.
 *
 * WHY IT IS WINDOWED (Slice 9e)
 * -----------------------------
 * It used to draw the WHOLE replay across the box. On a 9-minute window that is 5792
 * samples in ~192 CSS px — about thirty samples per pixel — so every braking zone became
 * one pixel of noise and the trace's legibility died with window length. That is Slice
 * 9b's defect in a different organ: an unbounded quantity drawn into fixed space.
 *
 * So the trace shows the last `TRACE_SECONDS` and scrolls. Heart-monitor semantics: the
 * present is always at the same place on screen, and history moves past it.
 *
 * THE WINDOW IS A PURE FUNCTION OF THE CLOCK, WHICH IS THE WHOLE DESIGN
 * --------------------------------------------------------------------
 * There is no accumulator, no retained path and no history buffer: a seek, a scrub, a lap
 * wrap and a replay swap are all just "recompute at the new clock". The trace is a VIEW of
 * the transport's time base, never a second one that could drift from it. A backwards seek
 * is bit-identical to arriving at the same clock forwards, and that is pinned by a test
 * rather than argued.
 *
 * THE COST STORY
 * --------------
 * The O(samples) work is `speedRange`, which a component memoises per car and pays once
 * per focus change. What a HUD tick pays is `buildTraceWindow`, bounded at
 * `TRACE_SECONDS x sampleRateHz + 2` points — 202 at 20 s on a 10 Hz grid, INDEPENDENT of
 * window length. Sample lookup is `index = t * sampleRateHz` (rule 3), never a scan.
 */
import type { Sample } from "./schema";

/**
 * How many seconds of history the trace shows. **Eyeball-tuned**, like `COMET_SECONDS`.
 *
 * The ceiling is arithmetic rather than taste: the sidebar gives the trace ~192 CSS px, so
 * at 10 Hz anything past ~19 s asks the box to show more samples than it has pixels —
 * which is this module's own defect, just less of it. `trace.test.ts` pins that
 * inequality against `TRACE_W` so the constant cannot drift back into it silently (the
 * lesson `TAIL_SECONDS` taught: before Slice 9b's follow-up, no test could observe it at
 * all). The floor is one braking event plus its recovery, ~4-6 s at Monza, so the trace
 * reads as a shape and not a spike.
 */
export const TRACE_SECONDS = 20;

/**
 * Where the playhead sits across the box: 1 = the right-hand edge, history only.
 *
 * A named fraction rather than a hard-coded edge. History-only is the correct v1 — it is
 * the heart-monitor semantic the finding asked for, it matches broadcast convention, and
 * what is COMING is already shown in the better representation: the track itself, where a
 * car approaches a corner spatially. Should a future lead ever be worth an experiment,
 * 0.75 here is the whole change, so trying it is an eyeball test rather than a rework.
 */
export const PLAYHEAD_FRACTION = 1;

/** The drawing box in SVG user units. Here, not in the component, so `TRACE_SECONDS`'s
 *  one-sample-per-pixel bound can be pinned next to the constant it bounds. */
export const TRACE_W = 240;
export const TRACE_H = 44;

/** The y axis's domain: the focused car's speeds across the WHOLE replay. */
export interface SpeedRange {
  minKmh: number;
  maxKmh: number;
}

/** One window of the trace: the curve, and where the present is in it. */
export interface TraceWindow {
  /** SVG `d` for the visible span. Bounded — see the module header. */
  path: string;
  /** The playhead's x, in the same box. Fixed at `PLAYHEAD_FRACTION * width` once the
   *  clock is older than the window; sweeps up to it before that. */
  playheadX: number;
  /** The visible span in replay seconds, so a caller can label it honestly. */
  startS: number;
  endS: number;
}

/** Everything one window needs. An object because a positional list of seven would read
 *  as a puzzle at the one call site that has to get it right. */
export interface TraceView {
  samples: readonly Sample[];
  sampleRateHz: number;
  clock: number;
  duration: number;
  range: SpeedRange;
  width: number;
  height: number;
}

/**
 * The lowest and highest speed in a car's replay, km/h.
 *
 * O(samples), so a component memoises it per car: it is the trace's whole per-focus-change
 * cost, and it is deliberately NOT recomputed per window. Scaling y to the visible window
 * instead would make the curve breathe — a constant-speed straight would fill the box
 * top to bottom — and the trace would be lying about relative speed. The axis is the
 * replay's; only the x window moves.
 *
 * @throws {RangeError} on an empty sample array — an empty path renders as a blank box
 *         with no clue why, the same reasoning as `computeBounds`.
 */
export function speedRange(samples: readonly Sample[]): SpeedRange {
  if (samples.length === 0) {
    throw new RangeError("speedRange needs at least one sample");
  }
  let minKmh = Infinity;
  let maxKmh = -Infinity;
  for (const s of samples) {
    if (s.speed < minKmh) minKmh = s.speed;
    if (s.speed > maxKmh) maxKmh = s.speed;
  }
  return { minKmh, maxKmh };
}

/**
 * Build the visible window of the trace at `clock`.
 *
 * Screen y is inverted (fast is UP), which is the opposite of the track canvas's
 * convention and correct here: a chart reads upward, a circuit map does not.
 *
 * ONE FORMULA, AND THE DEGRADATIONS FALL OUT OF ITS CLAMP
 * ------------------------------------------------------
 *     span = min(TRACE_SECONDS, duration)
 *     t0   = clamp(clock - PLAYHEAD_FRACTION * span, 0, max(0, duration - span))
 *
 *  - **A replay shorter than the window** (every v1 lap, and the committed fixture) has
 *    `span = duration` and `t0 = 0` forever, so it draws the whole replay across the box
 *    with the playhead sweeping — exactly the behaviour this module had before Slice 9e.
 *    Degradation, not letterboxing, and not a branch.
 *  - **A clock younger than the window** pins `t0` at 0, so the trace FILLS IN from the
 *    left and the playhead sweeps until there is a full window behind it.
 *  - **The end of an open window** pins `t0` at `duration - span`, so it never runs off.
 *
 * In a CLOSED replay the fill-in happens again every lap: the window clamps at the line
 * rather than reaching back into the previous lap. That is the covered-portion trail's
 * ruling (Slice 4b) on the time axis — crossing the line starts a fresh picture — and it
 * keeps the trace agreeing with the canvas about what the line means.
 *
 * The last point is interpolated at exactly `clock` rather than snapped to the grid, so
 * the curve always meets the playhead.
 *
 * @throws {RangeError} on an empty sample array, as `speedRange` does.
 */
export function buildTraceWindow({
  samples,
  sampleRateHz,
  clock,
  duration,
  range,
  width,
  height,
}: TraceView): TraceWindow {
  if (samples.length === 0) {
    throw new RangeError("buildTraceWindow needs at least one sample");
  }

  // A replay whose duration or rate is nonsense cannot be windowed. The schema forbids
  // both, so this is the "impossible data draws nothing rather than NaN" guard the
  // playhead used to carry on its own.
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const rate =
    Number.isFinite(sampleRateHz) && sampleRateHz > 0 ? sampleRateHz : 0;
  const span = Math.min(TRACE_SECONDS, total);
  if (span <= 0 || rate <= 0) {
    return { path: "", playheadX: 0, startS: 0, endS: 0 };
  }

  const now = Math.min(total, Math.max(0, clock));
  const t0 = Math.min(
    Math.max(0, now - PLAYHEAD_FRACTION * span),
    Math.max(0, total - span),
  );

  const x = (t: number): number => ((t - t0) / span) * width;
  const speedSpan = range.maxKmh - range.minKmh;
  // A flat lap has no range to scale against, so it sits on the centre line instead of
  // dividing by zero.
  const y = (kmh: number): number =>
    height - (speedSpan > 0 ? (kmh - range.minKmh) / speedSpan : 0.5) * height;

  const last = samples.length - 1;
  // `floor`, so the polyline starts just OUTSIDE the left edge and the SVG viewport clips
  // it. Starting at the first sample inside the window would leave a gap up to one grid
  // step wide at the trailing edge.
  const first = Math.min(last, Math.max(0, Math.floor(t0 * rate)));
  const head = Math.min(last, Math.max(0, Math.floor(now * rate)));

  let path = "";
  for (let i = first; i <= head; i++) {
    path += `${path === "" ? "M" : " L"}${round(x(i / rate))} ${round(y(samples[i].speed))}`;
  }

  // The head, at exactly `clock` rather than at the grid point behind it. Interpolated
  // where there is a next sample, held where there is not (the end of an open window),
  // and skipped when the clock sits exactly on the grid and it would be a duplicate.
  const frac = now * rate - head;
  if (frac > 0) {
    const next = samples[Math.min(last, head + 1)].speed;
    const kmh = samples[head].speed + (next - samples[head].speed) * frac;
    path += ` L${round(x(now))} ${round(y(kmh))}`;
  }

  return {
    path,
    playheadX: Math.min(width, Math.max(0, x(now))),
    startS: t0,
    endS: t0 + span,
  };
}

/** Two decimal places is sub-pixel at any realistic trace size. */
const round = (n: number): number => Math.round(n * 100) / 100;
