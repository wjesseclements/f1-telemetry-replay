/**
 * schema.ts — the single contract between the Python pipeline and the app.
 *
 * This Zod schema is also the TypeScript type (via `z.infer`), so there is exactly
 * one definition of the replay shape. `load.ts` validates every replay JSON against
 * it; nothing in the app consumes raw JSON. (CLAUDE.md architecture rule 7.)
 *
 * Evolution strategy: unknown keys are STRIPPED, not rejected, so the pipeline can
 * add channels (e.g. `rpm`) without breaking an older app build. Breaking changes
 * are caught instead by `meta.schemaVersion`, which must match SCHEMA_VERSION.
 */
import { z } from "zod";

/** Bump only for a BREAKING contract change; additive fields do not need it. */
export const SCHEMA_VERSION = 1;

/**
 * Whether a replay's samples form a CYCLE or an open segment.
 *
 * `"closed"` — a lap. The segment leaving the last sample runs back to the first,
 * because that is where the car actually went. Every v1 replay is one.
 *
 * `"open"` — a session-time WINDOW containing several cars (v2). It cannot close:
 * twenty cars do not simultaneously return to their starting positions, so the last
 * sample is the end of the data and `interpolate.ts` holds it rather than
 * interpolating a jump back to the start.
 *
 * This is a fact about the DATA, which is why it lives in the data rather than in a
 * heuristic — see the `interpolate.ts` header for what each mode does.
 */
export const LOOP_MODES = ["closed", "open"] as const;

/** Speed is km/h everywhere: the engine's thermal color stops are km/h-calibrated. */
export const SPEED_UNIT = "km/h";

/**
 * Tyre compounds, 2024-era, plus `"UNKNOWN"` as an in-band member.
 *
 * The degradation contract for compounds the pipeline does not recognise
 * (historical HYPERSOFT/ULTRASOFT, test-session codes, missing data) is that the
 * PIPELINE maps them to `"UNKNOWN"` and says so in its report — the loader then
 * rejects arbitrary strings exactly as `LOOP_MODES` rejects a typo. So a strange
 * season still loads (as UNKNOWN, rendered neutrally), while a hand-mangled file
 * still fails loudly. Season-dependence never reaches the app (CLAUDE.md rule 8):
 * the UI only ever looks at what the data carries.
 */
export const COMPOUNDS = [
  "SOFT",
  "MEDIUM",
  "HARD",
  "INTERMEDIATE",
  "WET",
  "UNKNOWN",
] as const;

/**
 * Track-status flags, plus `"unknown"` as an in-band member.
 *
 * The same degradation contract as `COMPOUNDS`: the PIPELINE maps FastF1 codes it
 * does not recognise to `"unknown"` and says so in its report, so a strange season
 * still loads (rendered as no flag), while a hand-mangled file still fails loudly.
 * `"sc"`/`"vsc"` are the Safety Car and Virtual Safety Car; no year branch anywhere
 * (CLAUDE.md rule 8) — the UI only ever looks at what the data carries.
 */
export const TRACK_STATUSES = [
  "green",
  "yellow",
  "sc",
  "vsc",
  "red",
  "unknown",
] as const;

/**
 * One track-status interval, in replay-window seconds.
 *
 * Intervals are the pipeline's clipped, merged view of the session's status
 * transitions: sorted, non-overlapping (enforced below), and covering only the
 * stretches the source data actually describes — a gap means "no answer", which the
 * UI renders as nothing rather than inventing green.
 */
const StatusIntervalSchema = z.object({
  status: z.enum(TRACK_STATUSES),
  /** Seconds from the start of the replay, inclusive. */
  fromT: z.number().nonnegative(),
  /** Seconds from the start of the replay; must exceed `fromT`. */
  toT: z.number(),
});

const MetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION, {
    error: `replay.meta.schemaVersion must be ${SCHEMA_VERSION}; regenerate the JSON with a matching pipeline`,
  }),
  year: z.number().int(),
  event: z.string().min(1),
  session: z.string().min(1),
  track: z.string().min(1),
  /** Degrees, from FastF1 `circuit_info`; applied at render, not to stored x/y. */
  rotation: z.number(),
  /** Samples sit on a uniform time grid at this rate — lookup is `t * sampleRateHz`. */
  sampleRateHz: z.number().positive(),
  /** Seconds. */
  duration: z.number().positive(),
  /**
   * Cyclic (a lap) or open (a session-time window). See `LOOP_MODES`.
   *
   * ADDITIVE within schemaVersion 1, deliberately: `.default()` rather than
   * `.optional()`, so a replay written before this field existed still validates,
   * still means "a lap", and still behaves identically — while `z.infer` makes the
   * parsed value REQUIRED, so the engine never has to branch on `undefined`.
   * Bumping the version instead would invalidate every generated lap on disk to
   * describe something none of them do differently.
   */
  loop: z.enum(LOOP_MODES).default("closed"),
  units: z.object({
    speed: z.literal(SPEED_UNIT, {
      error: `replay.meta.units.speed must be "${SPEED_UNIT}" — the engine's speed-to-color stops are calibrated in km/h`,
    }),
  }),
});

const CornerSchema = z.object({
  number: z.number().int(),
  letter: z.string(),
  x: z.number(),
  y: z.number(),
});

const TrackSchema = z.object({
  /** `angle` is RADIANS, matching the `atan2` heading convention used by the engine. */
  startFinish: z.object({ x: z.number(), y: z.number(), angle: z.number() }),
  corners: z.array(CornerSchema),
});

const SampleSchema = z.object({
  /** Seconds from the start of the replay; strictly increasing within a car. */
  t: z.number().nonnegative(),
  x: z.number(),
  y: z.number(),
  speed: z.number().nonnegative(),
  /**
   * Percent. Real FastF1 throttle occasionally reads above 100 in some seasons —
   * the PIPELINE clamps, the schema enforces. The app never widens its contract
   * to absorb dirty upstream data.
   */
  throttle: z.number().min(0).max(100),
  brake: z.literal([0, 1], { error: "brake must be 0 or 1" }),
  /** 0 = neutral; F1 cars have 8 forward gears. */
  gear: z.number().int().min(0).max(8),
  /**
   * OPTIONAL, season-dependent: the RAW FastF1 DRS code, decoded by `drs.ts`.
   * Absent for 2026+ (DRS removed, no published replacement channel).
   * See CLAUDE.md rule 8 and PRD sources [2], [5].
   */
  drs: z.number().int().optional(),
});

const LapSchema = z.object({
  /** The session's lap number — real, not window-relative. */
  number: z.number().int().positive(),
  /**
   * Replay-relative seconds at which this lap began. MAY BE NEGATIVE for the
   * first entry: a v2 window is the reference driver's lap range, and another
   * car's lap-in-progress at the window start began before it. The pipeline
   * emits the true value; clamping would lie about when the lap started.
   */
  startT: z.number(),
});

const StintSchema = z.object({
  compound: z.enum(COMPOUNDS),
  fromLap: z.number().int().positive(),
  toLap: z.number().int().positive(),
  /**
   * Laps already on this tyre set at the stint's first in-window lap (FastF1
   * `TyreLife`, which counts other sessions' use of a used set). OPTIONAL:
   * absent means the age is unknown, which is not the same as zero — the UI
   * shows the compound without an age rather than inventing a fresh set.
   */
  ageAtStart: z.number().int().nonnegative().optional(),
});

const CarSchema = z
  .object({
    driver: z.string().min(1),
    team: z.string(),
    color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
      error: "color must be a hex color such as #3671C6",
    }),
    // >= 2 because heading and interpolation need at least one segment.
    samples: z.array(SampleSchema).min(2, {
      error: "a car needs at least 2 samples to interpolate between",
    }),
    /**
     * Laps intersecting the replay window, in order. ADDITIVE within
     * schemaVersion 1 with `.default([])`, per the `meta.loop` doctrine: an
     * empty array means exactly what absence means — "this replay carries no
     * lap data" — so every file written before the field existed still
     * validates and still behaves identically, while `z.infer` makes the
     * parsed value REQUIRED and the engine branches on `length`, never on
     * `undefined` (the `carHasDrs` shape).
     */
    laps: z.array(LapSchema).default([]),
    /** Tyre stints over `laps`, in order. Same additive contract as `laps`. */
    stints: z.array(StintSchema).default([]),
    /**
     * Replay-relative seconds at which this car's telemetry feed died and the
     * pipeline froze it in place (the Slice 9l dead-feed screen). From this
     * instant the car's samples hold one position with zero dynamics — that is
     * data, not absence. OPTIONAL by the `ageAtStart` precedent, not
     * `.default()`: absence means "never retired", a scalar has no empty-array
     * spelling to default to, and 0 would claim a retirement at the window's
     * first instant. Consumers: the renderer stops the car's trail here;
     * tower/gap semantics are Slice 19's.
     */
    retiredAt: z.number().nonnegative().optional(),
  })
  .superRefine((car, ctx) => {
    // Time must be sorted: interpolation and seek assume it. Unsorted or duplicate
    // timestamps are pipeline drift, and would surface as NaN headings mid-replay.
    for (let i = 1; i < car.samples.length; i++) {
      const prev = car.samples[i - 1].t;
      const cur = car.samples[i].t;
      if (cur <= prev) {
        ctx.addIssue({
          code: "custom",
          path: ["samples", i, "t"],
          message: `samples must be strictly increasing in t: sample ${i} (t=${cur}) is not after sample ${i - 1} (t=${prev})`,
        });
        break; // one issue is enough to reject; don't flood the error message
      }
    }
    // DRS is all-or-nothing per car. A partially present channel is drift, and would
    // otherwise silently disable the HUD indicator instead of failing loudly.
    const withDrs = car.samples.filter((s) => s.drs !== undefined).length;
    if (withDrs !== 0 && withDrs !== car.samples.length) {
      ctx.addIssue({
        code: "custom",
        path: ["samples"],
        message: `drs must be present on every sample or none: ${withDrs} of ${car.samples.length} samples carry it`,
      });
    }
    // Laps are looked up by predecessor search on startT, so both orderings are
    // load-bearing: unsorted startT mis-answers the search, and unsorted numbers
    // would show laps counting backwards.
    for (let i = 1; i < car.laps.length; i++) {
      const prev = car.laps[i - 1];
      const cur = car.laps[i];
      if (cur.startT <= prev.startT || cur.number <= prev.number) {
        ctx.addIssue({
          code: "custom",
          path: ["laps", i],
          message: `laps must be strictly increasing in number and startT: lap ${cur.number} (startT=${cur.startT}) does not follow lap ${prev.number} (startT=${prev.startT})`,
        });
        break; // one issue is enough to reject; don't flood the error message
      }
    }
    // Stints are located via the lap table (stintAt goes through lapAt), so a
    // stint without laps is unreachable data — pipeline drift, rejected loudly.
    if (car.stints.length > 0 && car.laps.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["stints"],
        message:
          "stints without laps are unreachable: a stint is located via the lap table",
      });
    }
    // Each stint spans an ordered, non-overlapping lap range.
    for (let i = 0; i < car.stints.length; i++) {
      const stint = car.stints[i];
      if (stint.toLap < stint.fromLap) {
        ctx.addIssue({
          code: "custom",
          path: ["stints", i],
          message: `stint ${i} runs from lap ${stint.fromLap} to lap ${stint.toLap}, which is backwards`,
        });
        break;
      }
      if (i > 0 && stint.fromLap <= car.stints[i - 1].toLap) {
        ctx.addIssue({
          code: "custom",
          path: ["stints", i],
          message: `stints must be ordered and non-overlapping: stint ${i} starts at lap ${stint.fromLap} but the previous stint runs to lap ${car.stints[i - 1].toLap}`,
        });
        break;
      }
    }
  });

/**
 * Tolerance, in seconds, for a sample's `t` against its ideal grid position.
 *
 * The pipeline rounds `t` to 3 decimal places, so 2 ms leaves comfortable headroom
 * for that rounding plus float error while still catching real irregularity.
 */
export const GRID_TOLERANCE_S = 0.002;

export const ReplaySchema = z
  .object({
    meta: MetaSchema,
    track: TrackSchema,
    // Always an array — v1 emits one car, v2 emits twenty, and nothing branches on
    // the count. (CLAUDE.md architecture rule 2.)
    cars: z.array(CarSchema).min(1, {
      error: "replay.cars must contain at least one car",
    }),
    /**
     * Track-status intervals over the window, in order. ADDITIVE within
     * schemaVersion 1 with `.default([])`, per the `meta.loop` doctrine: an empty
     * array means exactly what absence means — "this replay carries no status
     * data" — so every file written before the field existed still validates and
     * still behaves identically, while `z.infer` makes the parsed value REQUIRED
     * and the engine branches on `length`, never on `undefined`.
     *
     * TOP-LEVEL, not in `meta`, by ruling: `meta` holds scalar facts about the
     * recording; this is window DATA like `cars`, and its duration cross-check
     * below needs `meta.sampleRateHz`'s replay-level vantage anyway.
     */
    trackStatus: z.array(StatusIntervalSchema).default([]),
  })
  .superRefine((replay, ctx) => {
    // A retirement past the window's end is unreachable data — pipeline drift,
    // rejected loudly by the same argument as the trackStatus bound below.
    replay.cars.forEach((car, c) => {
      if (
        car.retiredAt !== undefined &&
        car.retiredAt > replay.meta.duration + GRID_TOLERANCE_S
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["cars", c, "retiredAt"],
          message: `car ${car.driver} retires at ${car.retiredAt}s but meta.duration is ${replay.meta.duration}s`,
        });
      }
    });
    // Status intervals are looked up by scan at the HUD tick, so ordering and
    // non-overlap are load-bearing: an unsorted or overlapping list would answer
    // with whichever interval happened to come first. Bounds are pinned to the
    // replay's duration because the pipeline clips before emitting — an interval
    // past the end is pipeline drift, rejected loudly like everything else.
    for (let i = 0; i < replay.trackStatus.length; i++) {
      const cur = replay.trackStatus[i];
      if (cur.toT <= cur.fromT) {
        ctx.addIssue({
          code: "custom",
          path: ["trackStatus", i],
          message: `status intervals must run forwards: interval ${i} runs from ${cur.fromT} to ${cur.toT}`,
        });
        break; // one issue is enough to reject; don't flood the error message
      }
      if (cur.toT > replay.meta.duration + GRID_TOLERANCE_S) {
        ctx.addIssue({
          code: "custom",
          path: ["trackStatus", i],
          message: `status intervals must lie inside the replay: interval ${i} ends at ${cur.toT} but meta.duration is ${replay.meta.duration}`,
        });
        break;
      }
      if (i > 0 && cur.fromT < replay.trackStatus[i - 1].toT) {
        ctx.addIssue({
          code: "custom",
          path: ["trackStatus", i],
          message: `status intervals must be ordered and non-overlapping: interval ${i} starts at ${cur.fromT} but the previous one ends at ${replay.trackStatus[i - 1].toT}`,
        });
        break;
      }
    }
    // Uniform-grid guard. `interpolate.ts` looks samples up with `index = t *
    // sampleRateHz` and never reads `t` again (CLAUDE.md architecture rule 3), so
    // irregular spacing would silently place the car in the wrong spot rather than
    // fail. Strictly-increasing `t` (checked per car above) is not enough: it admits
    // arbitrary gaps. This is the load-time guard for that assumption.
    //
    // It lives here rather than on CarSchema because it needs `meta.sampleRateHz`,
    // which a car cannot see.
    const { sampleRateHz, duration } = replay.meta;
    // The span comparison is done in SAMPLE COUNTS, not seconds: comparing seconds
    // means subtracting nearby doubles, and |58.4 - 58.5| evaluates to
    // 0.10000000000000142 — over a 0.1 s tolerance that should have passed. Counts
    // are integers, so "within one grid step" is exact.
    const expectedSamples = Math.round(duration * sampleRateHz);

    replay.cars.forEach((car, c) => {
      // Span agreement. `interpolate.ts` wraps the clock on the car's OWN grid
      // (`samples.length / sampleRateHz`) because that is the array being indexed,
      // while the transport wraps its clock on `meta.duration`. Those are two
      // different numbers, and if they ever drift apart the car and the scrubber
      // disagree a little more with every lap — a slow desync with no error.
      //
      // Pinning every car's span to `meta.duration` here keeps the two definitions
      // interchangeable by construction, and rejects multi-car replays whose drivers
      // carry different sample counts (v2 desync) before anything can render them.
      if (Math.abs(car.samples.length - expectedSamples) > 1) {
        const span = car.samples.length / sampleRateHz;
        ctx.addIssue({
          code: "custom",
          path: ["cars", c, "samples"],
          message: `car ${car.driver} spans ${span}s (${car.samples.length} samples at ${sampleRateHz} Hz) but meta.duration is ${duration}s (${expectedSamples} samples); every car must cover the replay's duration to within one grid step`,
        });
      }

      for (let k = 0; k < car.samples.length; k++) {
        const ideal = k / sampleRateHz;
        const actual = car.samples[k].t;
        if (Math.abs(actual - ideal) > GRID_TOLERANCE_S) {
          ctx.addIssue({
            code: "custom",
            path: ["cars", c, "samples", k, "t"],
            message: `samples must lie on a uniform ${sampleRateHz} Hz grid: sample ${k} has t=${actual} but the grid puts it at ${ideal}`,
          });
          break; // one issue per car is enough; don't flood the error message
        }
      }
    });
  });

export type Replay = z.infer<typeof ReplaySchema>;
export type Meta = Replay["meta"];
export type Track = Replay["track"];
export type Corner = Track["corners"][number];
export type Car = Replay["cars"][number];
export type Sample = Car["samples"][number];
export type Lap = Car["laps"][number];
export type Stint = Car["stints"][number];
/** One of `COMPOUNDS` — 2024-era names plus in-band `"UNKNOWN"`. */
export type Compound = Stint["compound"];
/** `"closed"` (a lap) or `"open"` (a session-time window). See `LOOP_MODES`. */
export type LoopMode = Meta["loop"];
/** One track-status interval in window seconds. See `TRACK_STATUSES`. */
export type StatusInterval = Replay["trackStatus"][number];
/** One of `TRACK_STATUSES` — semantic flag states plus in-band `"unknown"`. */
export type TrackStatus = StatusInterval["status"];
