/**
 * carState.ts — is this car something a time gap can be quoted against? (Slice 19)
 *
 * THE RULE, STATED BEFORE THE CODE
 * --------------------------------
 * A time gap is meaningful only between two cars that are both MOVING on the RACING
 * LINE. Everything here exists to decide, per car per HUD tick, which side of that rule
 * a car is on — and the three recorded exhibits are what happens when nobody decides:
 * a parked focused car (LEC, red flag) read as leading everyone by up to a lap;
 * pit-lane starters (LAW/ALO) sorted to P1/P2 before the race start; and the
 * standing-restart grid showed RUS "−52.8 s" from a stationary ANT — the interval two
 * parked cars will eventually take to cross each other's grid slots, which is not a
 * gap.
 *
 * THREE STATES, EACH FROM DATA THE FILE ALREADY CARRIES
 * -----------------------------------------------------
 *  - **RETIRED** — `clock >= car.retiredAt`, the Slice 9l dead-feed emission. Nothing
 *    is inferred: a car that is merely stationary until the window's end is NOT
 *    promoted to retired, because the red-flag window ends with the whole live field
 *    parked and an inference would retire all 22 of them. The pipeline's PARTIAL
 *    coverage case (a feed that simply stops) emits nothing today and has no instance
 *    in the corpus; when one arrives, its honest spelling is `retiredAt` itself — the
 *    car is frozen from an instant, which is the meaning that field already has — so
 *    no `coverageEnd`/`parkedAt` schema fields were added for a consumer with zero
 *    corpus instances. PARKED (never moved at all) is already derivable: it is
 *    `ProgressIndex.degenerate`.
 *  - **OFF-LINE** — projection residual above `OFFLINE_RESIDUAL_M`. See the bound's
 *    own comment: the old 25 m gate was measured wrong for Monza's pit lane.
 *  - **STATIONARY** — speed below `STATIONARY_MAX_KMH` sustained for
 *    `STATIONARY_MIN_S`. See the constants for the measured floors.
 *
 * All three are functions of the replay and the clock — the `tyreStateAt` shape:
 * derived at the ≤30 Hz tick, never a `CarSnapshot` field, never on the 60 fps frame
 * path, and `displaySignature` needs no new term because the clock term already forces
 * an emit whenever any of them could change (CLAUDE.md rule 1).
 *
 * WHAT THE TOWER DOES WITH THEM (`towerGap`, plus `orderKeyFor`)
 * --------------------------------------------------------------
 *  - A RETIRED car's gap cell says OUT (rendered by the tower), sorts last, and the
 *    row greys — the broadcast treatment. Still focusable: focus is selection, not
 *    a claim about motion.
 *  - A car that is OFF-LINE or STATIONARY gets no number — an em dash, the module's
 *    existing "no honest answer" mark, NOT a "PIT" label: the data carries no
 *    pit-lane fact, and the corpus contains at-speed off-track excursions (ALO,
 *    restart window: three, 1.4–4.9 s, up to 310 km/h) that a PIT label would
 *    mislabel. Slice 16's pit-lane geometry is the honest upgrade path.
 *  - A focused car that is not racing blanks EVERY number (the rows keep their
 *    order). The alternatives were re-referencing to the leader — a silent change of
 *    what the column means, mid-replay — or freezing the last moving reference,
 *    which quotes intervals against a car that is not covering ground. The em dash
 *    is the only one of the three that cannot lie.
 *  - Gaps measured ACROSS a standing spell are suppressed: if the focused car's
 *    timeline between `t*` and `now` contains a hold (a stationary spell ≥
 *    `HOLD_MIN_S`), the "gap" includes parked time and is not an interval. This is
 *    what makes the first seconds after a standing start honest — a car three grid
 *    rows back is NOT "+41 s behind" because the leader passed its slot before the
 *    hold; the number returns the moment the measurement no longer spans the hold.
 *    Pit stops (measured 2.3–3.1 s across the corpus) sit far below `HOLD_MIN_S`, so
 *    mid-race gaps across a rival's pit stop are untouched.
 *  - Before a standing start the whole tower shows order and no numbers — see
 *    `launchT`.
 */
import type { Replay } from "./schema";
import { residualAt, travelSoFarM, type ProgressIndex, type Gap } from "./gaps";

/**
 * Below this a car is "not moving", in km/h.
 *
 * Measured on the corpus (all five gallery windows): genuinely parked cars — the
 * restart's 21-car grid hold, pit-stop boxes, LEC's wreck — mass at 0–1 km/h (7760
 * samples in the restart window alone), while the formation crawl to the grid spreads
 * thinly from 1 km/h up (≤37 samples per 1 km/h bucket, cars decelerating THROUGH the
 * band, never holding it). 5 admits every real stop and, with the sustain below, no
 * crawling car.
 */
export const STATIONARY_MAX_KMH = 5;

/**
 * How long a car must sit below the floor before it is STATIONARY, in seconds.
 *
 * A guard against transient dips, not a definition: the corpus's shortest genuine stop
 * is 2.3 s (VER's rain-window pit stop), and outside window edges the corpus contains
 * ZERO sub-floor runs shorter than a second — so 1.0 rejects nothing real and exists
 * for the interpolated speed ramp through a stop's edges.
 *
 * A run touching the WINDOW EDGE qualifies at any length: the red-flag window opens on
 * the lights with all 22 cars at speed 0 for their first 0.4–0.8 s (the only sub-1 s
 * runs in the corpus), and "stationary since before the data began" is not a transient.
 */
export const STATIONARY_MIN_S = 1.0;

/**
 * Residual above which a car is OFF the racing line, in metres.
 *
 * `gaps.ts`'s 25 m bound answers a different question — "can the projection be trusted
 * at all" — and stays untouched. This one answers "is the car ON the line", and 25 was
 * measured wrong for it: Monza's pit lane runs 15.8–19.4 m off the reference (LAW/ALO's
 * pit start, LEC/NOR's 2024 stops — every traversal, both years), entirely inside the
 * old bound, which is why pit-lane cars carried confident phantom gaps in two of the
 * three exhibits.
 *
 * 10 separates cleanly on today's corpus: the widest legitimate racing-line deviation
 * in all five windows is 9.2 m (PIA, red-flag window, at pace), and every excursion
 * above 10 m in ~15,000 car-seconds is a pit traversal, a window-edge pit entry, or a
 * genuine off-track moment — zero on-line excursions. (The 19.4 m on-line figure in
 * `gaps.ts`'s header was measured in Slice 9d, before 9i/9j anchored placement to the
 * timing loops; on today's assets the envelope is a third of that.) The two classes sit
 * 6.6 m apart, so the bound has real margin in both directions — but it is a corpus
 * fact, not a law: a future circuit whose pit lane hugs the track tighter than 10 m
 * re-opens it.
 */
export const OFFLINE_RESIDUAL_M = 10;

/**
 * A stationary spell at least this long is a HOLD — a standing period gaps must not be
 * measured across — in seconds.
 *
 * The corpus's stationary spells split into two populations with an empty band between:
 * pit stops at 2.3–3.1 s, and standing periods at 17.2 s and up (the restart's per-car
 * grid holds run 17.2–63.1 s; LEC's wreck parks him 119.8 s). Nothing sits between
 * 3.1 and 17.2, so 10 is a bound inside an empty band, the 9l precedent: pit stops
 * can triple before touching it, holds would have to shed 40 % of their shortest
 * instance.
 */
export const HOLD_MIN_S = 10;

/**
 * How many cars must be simultaneously stationary before the field itself is standing.
 *
 * Two cars stop together in ordinary racing — a double-stacked pit box. Three cars
 * simultaneously stationary for a sustained spell has no green-flag reading. Measured:
 * the restart window holds ≥3 cars stationary for one 55.7 s interval (the grid), the
 * red-flag window for 0.8 s (its own opening grid, correctly rejected by `HOLD_MIN_S`
 * because per-car edge runs already blank it), and the three 2024 windows peak at TWO
 * simultaneous stationary cars — so the quorum changes nothing anywhere it should not.
 */
export const GRID_QUORUM = 3;

/**
 * Metres of travel below which a car has not yet JOINED the running.
 *
 * Kin to the pipeline's `PARKED_TRAVEL_M` (5 m — half a car length). A car that is
 * off-line, stationary, and has covered no ground is a pit-lane starter in its box or a
 * car in its garage: it has no position in the running order yet, and sorts to the
 * untimed bottom rather than where its box happens to project onto the reference line
 * (Monza's pit boxes project alongside the S/F straight — AHEAD of pole, which is
 * exhibit 2). The same car mid-race — stopped in its pit box during a stop — keeps its
 * progress key and its row, because it has a position to keep.
 */
export const JOINED_TRAVEL_M = 5;

/** A half-open interval of window time, `[fromT, toT)` seconds. */
export interface Interval {
  fromT: number;
  toT: number;
}

/**
 * Everything Slice 19 precomputes per replay, once, at load — the `ProgressIndex`
 * shape: a tick then answers any car/clock query from interval membership and O(1)
 * reads, with no per-frame work and nothing retained between ticks.
 */
export interface CarStateIndex {
  /** Per car: spells below the speed floor, sustained or window-edge. */
  readonly stationary: readonly (readonly Interval[])[];
  /** Per car: the subset of `stationary` at least `HOLD_MIN_S` long. */
  readonly holds: readonly (readonly Interval[])[];
  /**
   * Per car: the feed-dropout intervals the pipeline emitted (`car.dropouts`,
   * Slice 9m). Carried in the index like the others so a tick answers membership
   * from a precomputed list; already sorted and non-overlapping by the schema.
   */
  readonly dropouts: readonly (readonly Interval[])[];
  /**
   * When the field launches from a standing start, or `null` when the window holds no
   * standing field. The end of the first spell of `GRID_QUORUM`-or-more simultaneously
   * stationary cars lasting `HOLD_MIN_S` — until that instant EVERY gap is blank,
   * which is what makes the forming-up phase honest too: cars driving to their slots
   * carry no numbers, not even plausible-looking ones, because the field they would
   * be measured against is not yet racing.
   *
   * Scope, stated rather than implied: the blanking runs from the WINDOW START to the
   * launch, which is right for every window in the corpus (a hold is only ever
   * preceded by forming up). A window that contained green racing AND a later
   * standing restart would want the blanking to start at the stoppage instead — no
   * such window exists to measure, so that refinement waits for its evidence.
   */
  readonly launchT: number | null;
}

/** One car's classification at one instant. The flags are independent facts. */
export interface CarState {
  /** `clock >= retiredAt` — the 9l emission, never inferred. */
  retired: boolean;
  /** Further off the reference line than `OFFLINE_RESIDUAL_M`. */
  offline: boolean;
  /** Inside a sustained below-floor spell. */
  stationary: boolean;
  /** Has covered at least `JOINED_TRAVEL_M` since the window opened. */
  joined: boolean;
  /**
   * Inside one of the car's `dropouts` intervals — a stretch the pipeline's
   * stuck-channel screen flagged as a frozen feed and bridged (Slice 9m). During it
   * nothing the car reports is real: the position is a best-effort reconstruction
   * (on the racing line, so the marker still moves) but speed and pedals are
   * fabricated, so the tower and readout show NO SIGNAL. It takes PRECEDENCE over
   * `offline`: a bridged span can leave the arc-progress wobbling within a metre of
   * the line, which the residual test would read as off-line and mislabel PIT — but a
   * dropped feed is a flagged fact, not a pit stop, so `carStateAt` clears `offline`
   * whenever this is set. It is a hold for gaps like the others (`isRacing` false).
   */
  dropout: boolean;
}

/** Racing = the state a time gap may be quoted against (the rule, as a predicate). */
export function isRacing(state: CarState): boolean {
  return (
    !state.retired && !state.offline && !state.stationary && !state.dropout
  );
}

/** Below-floor spells for one car, with the window-edge rule. O(samples). */
function stationarySpells(
  samples: Replay["cars"][number]["samples"],
  sampleRateHz: number,
): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (let k = 0; k <= samples.length; k++) {
    const below = k < samples.length && samples[k].speed < STATIONARY_MAX_KMH;
    if (below && start === null) start = k;
    if (!below && start !== null) {
      const fromT = start / sampleRateHz;
      const toT = k / sampleRateHz;
      if (
        toT - fromT >= STATIONARY_MIN_S ||
        start === 0 ||
        k === samples.length
      ) {
        out.push({ fromT, toT });
      }
      start = null;
    }
  }
  return out;
}

/** Build the per-replay index. O(cars × samples), once, at load. */
export function buildCarStateIndex(replay: Replay): CarStateIndex {
  const rate = replay.meta.sampleRateHz;
  const stationary = replay.cars.map((car) =>
    stationarySpells(car.samples, rate),
  );
  const holds = stationary.map((spells) =>
    spells.filter((s) => s.toT - s.fromT >= HOLD_MIN_S),
  );
  // The pipeline's dropout intervals, straight from the schema — already the `Interval`
  // shape, sorted and non-overlapping. A car that never dropped carries `[]`.
  const dropouts = replay.cars.map((car) =>
    car.dropouts.map((d) => ({ fromT: d.fromT, toT: d.toT })),
  );

  // The field-standing count per sample, from the raw floor rather than the spells:
  // the quorum interval's own duration gate does the sustaining.
  const n = replay.cars[0].samples.length;
  let launchT: number | null = null;
  let quorumStart: number | null = null;
  for (let k = 0; k <= n; k++) {
    let standing = 0;
    if (k < n) {
      for (const car of replay.cars) {
        const s = car.samples[Math.min(k, car.samples.length - 1)];
        if (s.speed < STATIONARY_MAX_KMH) standing += 1;
      }
    }
    const quorum = k < n && standing >= GRID_QUORUM;
    if (quorum && quorumStart === null) quorumStart = k;
    if (!quorum && quorumStart !== null) {
      if ((k - quorumStart) / rate >= HOLD_MIN_S) {
        launchT = k / rate;
        break;
      }
      quorumStart = null;
    }
  }

  return { stationary, holds, dropouts, launchT };
}

/** Is `clock` inside any of these intervals? The lists are short (≤3 in the corpus). */
function within(intervals: readonly Interval[], clock: number): boolean {
  return intervals.some((i) => clock >= i.fromT && clock < i.toT);
}

/** Does `[a, b]` overlap any of these intervals? */
function overlaps(
  intervals: readonly Interval[],
  a: number,
  b: number,
): boolean {
  return intervals.some((i) => a < i.toT && b > i.fromT);
}

/** One car's state at one instant. O(intervals) — effectively O(1) per tick. */
export function carStateAt(
  replay: Replay,
  progress: ProgressIndex,
  index: CarStateIndex,
  carIndex: number,
  clock: number,
): CarState {
  const car = replay.cars[carIndex];
  const dropout = within(index.dropouts[carIndex], clock);
  return {
    retired: car.retiredAt !== undefined && clock >= car.retiredAt,
    // A dropout CLEARS offline: the bridged position can wobble within a metre of the
    // line, which the residual test would read as off-line and the tower would spell
    // PIT — but the pipeline has flagged this as a dropped feed, which is not a pit
    // stop. NO SIGNAL is the honest label, and `dropout` carries it.
    offline:
      !dropout && residualAt(progress, carIndex, clock) > OFFLINE_RESIDUAL_M,
    stationary: within(index.stationary[carIndex], clock),
    joined: travelSoFarM(progress, carIndex, clock) >= JOINED_TRAVEL_M,
    dropout,
  };
}

/**
 * The gap as the tower may QUOTE it — `null` wherever the rule says there is no gap.
 *
 * Layered exactly as argued in the header: a retired row says OUT instead (the caller
 * renders that from the state, so the gap here is null); a focused car that is not
 * racing blanks the field; a car that is not racing carries no number; nothing is
 * quoted before a standing field launches; and nothing is quoted across a hold of the
 * focused car — `t*` is recovered from the gap itself (`t* = now − seconds`), so the
 * suppression needs no second lookup.
 */
export function towerGap(
  gap: Gap | null,
  focus: CarState,
  car: CarState,
  focusHolds: readonly Interval[],
  launchT: number | null,
  now: number,
): Gap | null {
  if (gap === null) return null;
  if (!isRacing(focus) || !isRacing(car)) return null;
  if (launchT !== null && now < launchT) return null;
  const tStar = now - gap.seconds;
  if (overlaps(focusHolds, Math.min(tStar, now), Math.max(tStar, now)))
    return null;
  return gap;
}

/**
 * The sort key as the tower may USE it.
 *
 * Blanking a number does not remove a car from the running order — a stationary grid
 * still has an order (its progress), a pitting car still has a row. The ONE case with
 * no position is the car that never had one: off-line, stationary, and not yet joined
 * (a pit-lane starter in its box), which sorts to the untimed bottom by the existing
 * `orderByGap` convention instead of where its box projects (exhibit 2: P1/P2).
 */
export function orderKeyFor(
  key: number | null,
  state: CarState,
): number | null {
  if (state.offline && state.stationary && !state.joined) return null;
  return key;
}
