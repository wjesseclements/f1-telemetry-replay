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

/** Speed is km/h everywhere: the engine's thermal color stops are km/h-calibrated. */
export const SPEED_UNIT = "km/h";

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
  });

export const ReplaySchema = z.object({
  meta: MetaSchema,
  track: TrackSchema,
  // Always an array — v1 emits one car, v2 emits twenty, and nothing branches on
  // the count. (CLAUDE.md architecture rule 2.)
  cars: z.array(CarSchema).min(1, {
    error: "replay.cars must contain at least one car",
  }),
});

export type Replay = z.infer<typeof ReplaySchema>;
export type Meta = Replay["meta"];
export type Track = Replay["track"];
export type Corner = Track["corners"][number];
export type Car = Replay["cars"][number];
export type Sample = Car["samples"][number];
