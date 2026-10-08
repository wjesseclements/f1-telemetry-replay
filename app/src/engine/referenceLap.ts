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
 *  - `legacyReferenceLap` — the span a file WITHOUT the field is settled to: on an
 *    open window, the one the gap engine used to SEARCH for, `cars[0]` from its first
 *    sample to `findLapEnd`'s return (its whole path when it never returns); on a
 *    closed lap, the whole loop, wrap step included. Called from exactly ONE place,
 *    `ReplaySchema`'s transform, and it calls `gaps.ts`'s own `findLapEnd`,
 *    `travelIntegral` and `pathLength` with gaps.ts's own constants — the same
 *    functions, not a copy that could drift.
 *  - the bounds the schema checks a PRESENT field against. The geometry it checks
 *    them with — `referenceLapEnds` / `metresApart`: where `cars[car]` is at `fromT`
 *    and at `toT`, and the car's own metre bridge over the span, so "does the span
 *    close" and "is the line where the lap starts" are both answered in metres —
 *    lives in `gaps.ts`, because `buildReference` applies the same closure test
 *    through the same bridge and gaps.ts cannot import this module (see there).
 *
 * WHAT A FILE WITHOUT THE FIELD KEEPS, AND WHAT IT DOES NOT. Not "everything": this
 * is what measurement at the Slice 24 final review showed, against the Slice 23
 * engine.
 *  - KEPT: an open window's gap output — every gap, key and residual — is
 *    bit-identical (all five gallery assets with the field deleted, and the fixture
 *    as an open window); and the committed fixture's VISIBLE output is identical
 *    (both draw-call digests unchanged).
 *  - CHANGED, a closed lap's ring: its span is `0 .. duration`, so the ring now
 *    includes the closing chord that the old search, stopping at the last sample,
 *    left out, and `lapSeconds` is the duration — on the fixture 58.4 → 58.5 s and
 *    `lapUnits` 4608.04 → 4616.82. A one-car closed file shows none of it (the
 *    fixture's single-car outputs are identical); on a hand-built four-car closed
 *    variant of the fixture gaps move by up to 0.111 s (250 of 3120 queries), and
 *    one query on the closing chord reads `null` where it read a gap.
 *  - CHANGED, an open window's ribbon: `scene.ts` now draws the settled span —
 *    `cars[0]`'s first lap — where it drew `cars[0]`'s whole path (field deleted:
 *    red flag 2948 → 924 points, restart 4253 → 1662), and the centroid that points
 *    the corner and start/finish labels moves with it.
 *
 * THE CONSUMERS (Slice 24, consumer half) read the settled field and nothing else:
 * `gaps.ts`'s reference circuit, its pace and its metre bridge, and `scene.ts`'s
 * ribbon — through `referenceSpan.ts`, which owns the one rule for `toT = duration`.
 * The start/finish line is the pipeline's, placed at the lap's start.
 *
 * A FALLBACK THE CONSUMERS KEEP. When an open window's `cars[0]` never returns to its
 * start, the legacy span is its whole path, and `gaps.ts` treats that case as "no
 * ring" (`lapUnits` 0). `{car, fromT, toT}` cannot carry that bit, so `buildReference`
 * recognises it from the span itself, by the schema's own tests of a present field:
 * shorter than `MIN_LAP_S`, or not closing within `MAX_RESIDUAL_M` through the car's
 * bridge over the span. Over a whole path that bridge is the window's — the one
 * `findLapEnd` searched with — so the span test and the search agree there, and a
 * real reference lap always passes it (the schema requires it of a PRESENT field). A
 * legacy lap the search DID close is re-tested through its own bridge, not the
 * window's it was found with; `buildReference`'s doc says when that can differ (a
 * closing chord within the bridges' drift of 25 m — on the shipped assets none is).
 * A `cars[0]` that never MOVED is caught first, by `buildProgressIndex` on
 * `unitsPerMetre === 0` (review of the contract half; kept).
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

/**
 * How far apart `cars[car]`'s positions at `fromT` and at `toT` may be, in metres:
 * a reference lap must CLOSE, because one lap ends where it started. `MAX_RESIDUAL_M`
 * once more — the radius `findLapEnd` uses for "back where it started", and the one
 * `buildReference` tests a span's closure against, through the same `referenceLapEnds`
 * bridge as the schema: so whatever the schema accepts, the gap engine rings.
 * Grid rounding costs at most half a step at each end (4.9 m each at 350 km/h).
 * What it catches is a span that is not ONE lap: a lap and a bit, a timing-table
 * row that disagrees with the positions, or a file's `fromT`/`toT` pointing at the
 * wrong car.
 */
export const REFERENCE_LAP_CLOSE_M = MAX_RESIDUAL_M;

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
 * The reference lap a file WITHOUT `track.referenceLap` is settled to. Not in every
 * respect the lap the engine used before the field existed — the header says where
 * it differs.
 *
 * `loop: "closed"` — the lap is the whole loop, wrap step included: `0 .. duration`.
 * `loop: "open"` — `cars[0]` from sample 0 to `findLapEnd`'s first return, searched
 * exactly as the engine searched before Slice 24 (the window's metre bridge — the one
 * `buildProgressIndex` still reports as `unitsPerMetre` — and the `MAX_RESIDUAL_M`
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
