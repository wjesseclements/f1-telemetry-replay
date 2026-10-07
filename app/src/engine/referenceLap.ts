/**
 * referenceLap.ts — the replay's reference lap: which car, which span (Slice 24).
 *
 * `track.referenceLap = { car, fromT, toT }` names a span during which `cars[car]`
 * drives exactly one clean racing lap, timing line to timing line. It used to be
 * IMPLICIT — `cars[0]`'s first lap, found by `gaps.ts`'s `findLapEnd` — and four
 * things rest on it: the start/finish line, the track ribbon, the gap reference
 * circuit, and the pace that scales gaps. The pipeline now chooses it by rule and
 * writes it into the file (`pipeline/replay_transform/reference_lap.py`); this
 * module is the app's half of the contract:
 *
 *  - `legacyReferenceLap` — what a file WITHOUT the field means. It reproduces the
 *    span the engine used before the field existed, so every old file, the committed
 *    fixture and hand-built JSON behave identically: a closed lap is its own whole
 *    loop; an open window is `cars[0]` from its first sample to `findLapEnd`'s
 *    return, or its whole path when it never returns. Called from exactly ONE place,
 *    `ReplaySchema`'s transform, and it calls `gaps.ts`'s own `findLapEnd`,
 *    `travelIntegral` and `pathLength` with gaps.ts's own constants — the same
 *    functions, not a copy that could drift.
 *  - `startFinishOffsetM` — the geometry the schema needs to check a PRESENT field:
 *    how far `track.startFinish` sits from the reference car at `fromT`, in metres.
 *
 * Consumers do not read the field yet; switching them over is the next phase. Until
 * then this module changes nothing a user can see.
 *
 * A FALLBACK FOR CONSUMERS TO KNOW ABOUT. When an open window's `cars[0]` never
 * returns to its start, the legacy span is its whole path — what `buildReference`
 * projects onto today — but `gaps.ts` treats that case as "no ring" (`lapUnits` 0).
 * `{car, fromT, toT}` cannot carry that bit. Exactly that case is recognisable from
 * the span itself: it is shorter than `MIN_LAP_S` or does not return within
 * `MAX_RESIDUAL_M` of where it started, which a real reference lap always does.
 */
import {
  MAX_RESIDUAL_M,
  MIN_LAP_S,
  findLapEnd,
  pathLength,
  travelIntegral,
} from "./gaps";
import type { Replay, ReferenceLap } from "./schema";

/**
 * Shortest reference lap the schema accepts, in seconds: the engine's own
 * `MIN_LAP_S`, the shortest lap `findLapEnd` will believe. Shared rather than
 * restated, so the schema can never accept a lap the lap finder would refuse to
 * have found. No F1 lap is within an order of magnitude of it (the shortest run
 * ~55 s); what it rejects is nonsense — a degenerate span, or a lap time read in
 * minutes. Mirrored by the pipeline as `REFERENCE_LAP_MIN_S`.
 */
export const REFERENCE_LAP_MIN_S = MIN_LAP_S;

/**
 * How far `track.startFinish` may sit from the reference car at `fromT`, in metres.
 *
 * The line IS where the reference lap starts, so this is the engine's existing
 * meaning of "at the same point of the circuit": `MAX_RESIDUAL_M`, a track width
 * plus run-off, the bound `findLapEnd` already uses for "back where it started" and
 * `gapTo` for "on the line". The pipeline emits the line at distance 0; the margin
 * is for a hand-built file whose line came from elsewhere (official circuit data,
 * another car's crossing, a grid-rounded lap start — half a step at 350 km/h is
 * 4.9 m). The defect it exists to catch is the red-flag asset's: its line sits
 * ~290 m from where any racing lap starts.
 */
export const START_FINISH_MAX_OFFSET_M = MAX_RESIDUAL_M;

/** A replay before its reference lap is settled: the field may be absent. */
export type UnreferencedReplay = Omit<Replay, "track"> & {
  track: Omit<Replay["track"], "referenceLap"> & {
    referenceLap?: ReferenceLap;
  };
};

/**
 * The replay with `track.referenceLap` settled: the file's own when it carries one
 * (already validated by the schema), else `legacyReferenceLap`. THE one place the
 * legacy reference is synthesized — `ReplaySchema`'s transform is this function,
 * and a test that builds a parsed replay by hand calls it to get exactly what the
 * loader would have produced.
 */
export function withReferenceLap(replay: UnreferencedReplay): Replay {
  return {
    ...replay,
    track: {
      ...replay.track,
      referenceLap: replay.track.referenceLap ?? legacyReferenceLap(replay),
    },
  };
}

/**
 * The reference lap a file WITHOUT `track.referenceLap` has always meant.
 *
 * `loop: "closed"` — the lap is the whole loop, wrap step included: `0 .. duration`.
 * `loop: "open"` — `cars[0]` from sample 0 to `findLapEnd`'s first return, measured
 * exactly as `buildProgressIndex` measures it (same metre bridge, same same-spot
 * radius); its whole path, `0 .. (n-1)/rate`, when it never returns or never moved.
 */
export function legacyReferenceLap(
  replay: Pick<Replay, "meta" | "cars">,
): ReferenceLap {
  const { loop, sampleRateHz, duration } = replay.meta;
  if (loop === "closed") return { car: 0, fromT: 0, toT: duration };

  const samples = replay.cars[0].samples;
  const n = samples.length;
  const whole: ReferenceLap = { car: 0, fromT: 0, toT: (n - 1) / sampleRateHz };
  // `buildProgressIndex`'s metre bridge, verbatim: cars[0]'s path over its travel.
  const metres = travelIntegral(samples, sampleRateHz)[n - 1];
  const unitsPerMetre = metres === 0 ? 0 : pathLength(samples) / metres;
  // A reference that never moved: gaps.ts builds no circuit at all. The whole
  // (stationary) path is the only span there is.
  if (unitsPerMetre === 0) return whole;

  const xs = Float64Array.from(samples, (s) => s.x);
  const ys = Float64Array.from(samples, (s) => s.y);
  const lapEnd = findLapEnd(
    xs,
    ys,
    sampleRateHz,
    MAX_RESIDUAL_M * unitsPerMetre,
  );
  return lapEnd === null
    ? whole
    : { car: 0, fromT: 0, toT: lapEnd / sampleRateHz };
}

/**
 * Metres between `track.startFinish` and `cars[car]` at `fromT`, or `null` when the
 * car covers no ground over the span (no metre bridge, and no lap either).
 *
 * Position units are converted through the car's own bridge over the span — its
 * path against its speed integral, the `gaps.ts` rule — never through a constant:
 * FastF1's position unit is undocumented and the engine refuses to know it.
 * Indices are clamped to the last sample: a closed lap's `toT` is `duration`, one
 * step past the last sample, where the loop wraps back to the first.
 */
export function startFinishOffsetM(
  replay: Pick<Replay, "meta" | "cars"> & {
    track: Pick<Replay["track"], "startFinish">;
  },
  reference: ReferenceLap,
): number | null {
  const rate = replay.meta.sampleRateHz;
  const samples = replay.cars[reference.car].samples;
  const last = samples.length - 1;
  const from = Math.min(Math.round(reference.fromT * rate), last);
  const to = Math.min(Math.round(reference.toT * rate), last);
  const span = samples.slice(from, to + 1);
  const metres = travelIntegral(span, rate)[span.length - 1];
  const path = pathLength(span);
  if (metres === 0 || path === 0) return null;
  const { x, y } = replay.track.startFinish;
  return Math.hypot(x - samples[from].x, y - samples[from].y) / (path / metres);
}
