/**
 * lore.ts — corner lore, as a contract (Slice 18).
 *
 * A circuit's corner names and their stories are CURATED data: one committed JSON
 * file per circuit under `src/lore/`, bundled and parsed once by `src/lore/index.ts`,
 * never fetched and never generated. This module holds the shape of those files and
 * the pure logic that binds them to a replay. It is in `src/engine/` because it is
 * pure (CLAUDE.md rule 4); nothing here knows about React, the DOM or the canvas.
 *
 * TWO HALVES PER FILE
 * -------------------
 * - `features` is the COPY: a name, an optional second name, a story of one
 *   paragraph, and the sources it was checked against (committed, not rendered).
 *   It is human-owned and applied verbatim, and it never names a turn number: the
 *   numbers come from the anchors, so a renumbering cannot strand one in prose.
 * - `layouts` is the BINDING: the exact `track.corners` record the copy was written
 *   against, and `anchors` from each feature to corner labels or to the start/finish
 *   line. When the corner record is renumbered, a layout is added and the copy is
 *   left alone.
 *
 * HOW A REPLAY FINDS ITS LORE
 * ---------------------------
 * By its corner record, never by `meta.event` or `meta.track`: same count, same
 * labels, and every corner within `LORE_MATCH_TOLERANCE_M` of the recorded one. An
 * event is not a circuit and neither name says which numbering a file carries, but
 * the record says both. A mismatch of any kind gives NO lore, never wrong lore, and
 * no lore is simply what every replay looked like before this slice.
 */
import { z } from "zod";
import type { Corner } from "./schema";

/** Bump only for a breaking lore-file change. Independent of the replay schema's. */
export const LORE_SCHEMA_VERSION = 1;

/**
 * How far a replay's corner may sit from the recorded one and still be the same
 * corner, in metres. Markers lie 0–4 m off the driven line; the closest pair of
 * corners in either circuit is 51 m apart (Monza 4 and 5), so 10 m cannot land a
 * label on its neighbour. The schema holds every layout to twice this spacing.
 */
export const LORE_MATCH_TOLERANCE_M = 10;

/** A story is one short paragraph; the card is sized for it. */
export const LORE_STORY_MAX_CHARS = 300;

/** Replay x/y are FastF1 position units: tenths of a metre. */
const UNITS_PER_METRE = 10;

/** The eyebrow over a start/finish story (ruled copy, 2026-10-15). */
export const EYEBROW_START_FINISH = "Start/finish";

/**
 * A corner's painted label: its number plus its letter ("" for a plain corner).
 * `render/scene.ts` builds the same text inline; a test pins the two equal so the
 * render file need not import this.
 */
export function cornerLabel(corner: Pick<Corner, "number" | "letter">): string {
  return `${corner.number}${corner.letter}`;
}

const TURN_NUMBER = /\b(?:t|turns?)\s?\d/i;

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
  error: "an id is a lowercase slug, e.g. curva-alboreto",
});

/**
 * Text a visitor reads, held to the copy ruling: verbatim, so never padded; one
 * paragraph; typographic apostrophes and en dashes; and no turn numbers, which only
 * the anchors may supply.
 */
const Copy = z
  .string()
  .min(1, { error: "copy must not be empty" })
  .refine((s) => s === s.trim(), {
    error: "copy must not start or end with whitespace",
  })
  .refine((s) => !/[\r\n]/.test(s), {
    error: "copy is one paragraph: no line breaks",
  })
  .refine((s) => !TURN_NUMBER.test(s), {
    error:
      "copy must not name a turn number: numbers come from the anchors, so a renumbering cannot leave one behind",
  })
  .refine((s) => !/['"]/.test(s), {
    error:
      "copy takes typographic quotes and apostrophes (’), not straight ones",
  })
  .refine((s) => !/\d-\d/.test(s), {
    error: "a numeric range takes an en dash (–), not a hyphen",
  });

const Source = z.string().regex(/^https:\/\/\S+$/, {
  error: "a source is an https URL",
});

const FeatureSchema = z.strictObject({
  id: Slug,
  name: Copy,
  /** A second name, shown under the first in a dimmer style. Bare: no prefix. */
  subtitle: Copy.optional(),
  story: Copy.max(LORE_STORY_MAX_CHARS, {
    error: `a story is at most ${LORE_STORY_MAX_CHARS} characters`,
  }),
  /** What the copy was checked against. Committed next to it, not rendered. */
  sources: z.array(Source).min(1, { error: "every story cites a source" }),
});

/** The replay's own corner shape (`schema.ts`), held strictly here. */
const CornerRecordSchema = z.strictObject({
  number: z.number().int(),
  letter: z.string(),
  x: z.number(),
  y: z.number(),
});

/** Where a feature's badge sits: on corner labels, or on the painted S/F label. */
const AnchorSchema = z.union([
  z.strictObject({ corners: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ startFinish: z.literal(true) }),
]);

const LayoutSchema = z.strictObject({
  id: Slug,
  /** Where this corner record came from, for whoever adds the next layout. */
  provenance: z.string().min(1),
  /** The exact `track.corners` the anchors were written against. */
  corners: z.array(CornerRecordSchema).min(1),
  /** Feature id → anchor. */
  anchors: z.record(Slug, AnchorSchema),
});

export const CircuitLoreSchema = z
  .strictObject({
    schemaVersion: z.literal(LORE_SCHEMA_VERSION, {
      error: `lore schemaVersion must be ${LORE_SCHEMA_VERSION}`,
    }),
    id: Slug,
    features: z.array(FeatureSchema).min(1),
    layouts: z.array(LayoutSchema).min(1),
  })
  .superRefine((lore, ctx) => {
    // Committed and bundled, so every rule here is a build-time mistake that a
    // test catches before a visitor can meet it.
    const featureIds = new Set<string>();
    lore.features.forEach((feature, i) => {
      if (featureIds.has(feature.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["features", i, "id"],
          message: `duplicate feature id "${feature.id}"`,
        });
      }
      featureIds.add(feature.id);
      if (new Set(feature.sources).size !== feature.sources.length) {
        ctx.addIssue({
          code: "custom",
          path: ["features", i, "sources"],
          message: `feature "${feature.id}" lists a source twice`,
        });
      }
    });

    const anchored = new Set<string>();
    const layoutIds = new Set<string>();
    lore.layouts.forEach((layout, li) => {
      const at = (...rest: (string | number)[]) => ["layouts", li, ...rest];
      if (layoutIds.has(layout.id)) {
        ctx.addIssue({
          code: "custom",
          path: at("id"),
          message: `duplicate layout id "${layout.id}"`,
        });
      }
      layoutIds.add(layout.id);

      const labels = layout.corners.map(cornerLabel);
      const indexOf = new Map<string, number>();
      labels.forEach((label, ci) => {
        if (indexOf.has(label)) {
          ctx.addIssue({
            code: "custom",
            path: at("corners", ci),
            message: `layout "${layout.id}" repeats the corner label "${label}"`,
          });
        } else {
          indexOf.set(label, ci);
        }
      });

      // Two corners within twice the tolerance could both match one replay corner,
      // so a renumbering by one might still "match". Hold every pair apart.
      for (let a = 0; a < layout.corners.length; a++) {
        for (let b = a + 1; b < layout.corners.length; b++) {
          const m = distanceM(layout.corners[a], layout.corners[b]);
          if (m <= 2 * LORE_MATCH_TOLERANCE_M) {
            ctx.addIssue({
              code: "custom",
              path: at("corners", b),
              message: `corners "${labels[a]}" and "${labels[b]}" in layout "${layout.id}" are ${m.toFixed(1)} m apart, within twice the ${LORE_MATCH_TOLERANCE_M} m match tolerance`,
            });
          }
        }
      }

      const entries = Object.entries(layout.anchors);
      if (entries.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: at("anchors"),
          message: `layout "${layout.id}" anchors no feature`,
        });
      }
      const claimedBy = new Map<string, string>();
      let startFinishBy: string | null = null;
      for (const [featureId, anchor] of entries) {
        anchored.add(featureId);
        if (!featureIds.has(featureId)) {
          ctx.addIssue({
            code: "custom",
            path: at("anchors", featureId),
            message: `layout "${layout.id}" anchors "${featureId}", which is not in features`,
          });
        }
        if ("startFinish" in anchor) {
          if (startFinishBy !== null) {
            ctx.addIssue({
              code: "custom",
              path: at("anchors", featureId),
              message: `"${startFinishBy}" and "${featureId}" both anchor to the start/finish line in layout "${layout.id}"; it has one label`,
            });
          }
          startFinishBy = featureId;
          continue;
        }
        const indices: number[] = [];
        for (const label of anchor.corners) {
          const ci = indexOf.get(label);
          if (ci === undefined) {
            ctx.addIssue({
              code: "custom",
              path: at("anchors", featureId),
              message: `"${featureId}" anchors to corner "${label}", which is not in layout "${layout.id}"`,
            });
          } else {
            indices.push(ci);
          }
          const prior = claimedBy.get(label);
          if (prior !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: at("anchors", featureId),
              message: `corner "${label}" in layout "${layout.id}" is anchored twice ("${prior}" and "${featureId}"); one badge opens one card`,
            });
          }
          claimedBy.set(label, featureId);
        }
        // The eyebrow says "Turns 10–14", which is only true of neighbours listed
        // round the lap in order.
        if (
          indices.length === anchor.corners.length &&
          turnRuns(indices).length !== 1
        ) {
          ctx.addIssue({
            code: "custom",
            path: at("anchors", featureId),
            message: `"${featureId}" in layout "${layout.id}" must anchor to one run of neighbouring corners, listed in lap order`,
          });
        }
      }
    });

    for (const feature of lore.features) {
      if (!anchored.has(feature.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["features"],
          message: `feature "${feature.id}" is anchored in no layout, so no visitor could ever open it`,
        });
      }
    }
  });

export type CircuitLore = z.infer<typeof CircuitLoreSchema>;
export type LoreFeature = CircuitLore["features"][number];
export type LoreLayout = CircuitLore["layouts"][number];
export type LoreAnchor = LoreLayout["anchors"][string];
type CornerRecord = Pick<Corner, "number" | "letter" | "x" | "y">;

/** Thrown when a committed lore file, or the catalogue, breaks the contract. */
export class CornerLoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CornerLoreError";
  }
}

/**
 * Validate one circuit's lore, failing loudly. Loud is right for the same reason as
 * the gallery manifest: the file is committed and bundled, so a malformed one is a
 * build-time mistake a test catches, never something a visitor can hit.
 */
export function parseCircuitLore(
  json: unknown,
  source = "lore file",
): CircuitLore {
  const result = CircuitLoreSchema.safeParse(json);
  if (result.success) return result.data;
  throw new CornerLoreError(
    `Invalid corner lore (${source}).\n${z.prettifyError(result.error)}`,
  );
}

/**
 * Validate every circuit, then the catalogue as a whole: circuit ids are unique,
 * and no layout matches another layout's record, so a replay can never match two.
 */
export function parseLoreCatalogue(
  files: readonly unknown[],
): readonly CircuitLore[] {
  const catalogue = files.map((json, i) =>
    parseCircuitLore(json, `lore file ${i}`),
  );
  const ids = new Set<string>();
  for (const circuit of catalogue) {
    if (ids.has(circuit.id)) {
      throw new CornerLoreError(`duplicate lore circuit id "${circuit.id}"`);
    }
    ids.add(circuit.id);
  }
  const layouts = catalogue.flatMap((circuit) =>
    circuit.layouts.map((layout) => ({ circuit: circuit.id, layout })),
  );
  for (let a = 0; a < layouts.length; a++) {
    for (let b = a + 1; b < layouts.length; b++) {
      if (
        layoutOffsetM(layouts[a].layout.corners, layouts[b].layout) !== null
      ) {
        throw new CornerLoreError(
          `lore layouts "${layouts[a].circuit}/${layouts[a].layout.id}" and "${layouts[b].circuit}/${layouts[b].layout.id}" match the same corner record`,
        );
      }
    }
  }
  return catalogue;
}

function distanceM(a: CornerRecord, b: CornerRecord): number {
  return Math.hypot(a.x - b.x, a.y - b.y) / UNITS_PER_METRE;
}

/**
 * The largest per-corner offset, in metres, if `corners` IS this layout's record;
 * otherwise `null`. "Is" means the same number of corners, the same labels (a
 * replay that repeats one matches nothing) and every corner within the tolerance.
 * Order does not matter: corners are paired by label.
 */
export function layoutOffsetM(
  corners: readonly CornerRecord[],
  layout: Pick<LoreLayout, "corners">,
): number | null {
  if (corners.length !== layout.corners.length) return null;
  const byLabel = new Map<string, CornerRecord>();
  for (const corner of corners) {
    const label = cornerLabel(corner);
    if (byLabel.has(label)) return null;
    byLabel.set(label, corner);
  }
  let worst = 0;
  for (const want of layout.corners) {
    const got = byLabel.get(cornerLabel(want));
    if (got === undefined) return null;
    const m = distanceM(got, want);
    // Written as "not within" so a NaN coordinate fails rather than matches.
    if (!(m <= LORE_MATCH_TOLERANCE_M)) return null;
    worst = Math.max(worst, m);
  }
  return worst;
}

/** One story, bound to the replay it was resolved against. */
export interface LoreStory {
  /** The feature id; stable, so a DOM id can be built from it. */
  readonly id: string;
  readonly name: string;
  readonly subtitle: string | undefined;
  readonly story: string;
  /** True when the story sits on the painted S/F label rather than on corners. */
  readonly startFinish: boolean;
  /**
   * Indices into the REPLAY's `track.corners`, which is the order
   * `render/paths.ts` builds its corner badges in. In lap order; empty for a
   * start/finish story.
   */
  readonly cornerIndices: readonly number[];
  /** "Turn 11", "Turns 10–14" or "Start/finish". */
  readonly eyebrow: string;
  /** "Turn 11: Curva Alboreto (Parabolica)". */
  readonly accessibleName: string;
}

export interface ResolvedLore {
  readonly circuitId: string;
  readonly layoutId: string;
  /** How far the replay's worst corner sits from the record, in metres. */
  readonly offsetM: number;
  /** In lap order: the start/finish story first, then by first corner. */
  readonly stories: readonly LoreStory[];
}

/**
 * The stories for a replay with these corners, or `null` when its record matches
 * no layout in the catalogue. Pure, and cheap enough to run once per replay.
 */
export function resolveLore(
  corners: readonly CornerRecord[],
  catalogue: readonly CircuitLore[],
): ResolvedLore | null {
  for (const circuit of catalogue) {
    for (const layout of circuit.layouts) {
      const offsetM = layoutOffsetM(corners, layout);
      if (offsetM === null) continue;
      return {
        circuitId: circuit.id,
        layoutId: layout.id,
        offsetM,
        stories: storiesOf(circuit, layout, corners),
      };
    }
  }
  return null;
}

function storiesOf(
  circuit: CircuitLore,
  layout: LoreLayout,
  corners: readonly CornerRecord[],
): LoreStory[] {
  const replayIndex = new Map(corners.map((c, i) => [cornerLabel(c), i]));
  const layoutIndex = new Map(
    layout.corners.map((c, i) => [cornerLabel(c), i]),
  );
  const keyed = circuit.features.flatMap((feature) => {
    const anchor = layout.anchors[feature.id];
    if (anchor === undefined) return [];
    const labels = "startFinish" in anchor ? [] : anchor.corners;
    const eyebrow = loreEyebrow(anchor);
    const story: LoreStory = {
      id: feature.id,
      name: feature.name,
      subtitle: feature.subtitle,
      story: feature.story,
      startFinish: labels.length === 0,
      // Every label is present: the match paired every layout corner with one.
      cornerIndices: labels.map((label) => replayIndex.get(label) as number),
      eyebrow,
      accessibleName: loreAccessibleName({ eyebrow, ...feature }),
    };
    // The lap starts at the line, so the start/finish story leads.
    const key =
      labels.length === 0 ? -1 : (layoutIndex.get(labels[0]) as number);
    return [{ key, story }];
  });
  return keyed.sort((a, b) => a.key - b.key).map(({ story }) => story);
}

/** A run of consecutive indices, inclusive at both ends. */
export interface TurnRun {
  readonly first: number;
  readonly last: number;
}

/**
 * Corner indices compressed into runs of neighbours, in the order given: [9, 10,
 * 11, 12, 13] is one run, [4, 10] is two, and [2, 1] is two, because a run goes
 * forwards round the lap. An anchor must be exactly one run for its eyebrow
 * ("Turns 10–14") to be true.
 */
export function turnRuns(indices: readonly number[]): TurnRun[] {
  const runs: TurnRun[] = [];
  for (const index of indices) {
    const tail = runs[runs.length - 1];
    if (tail !== undefined && index === tail.last + 1) {
      runs[runs.length - 1] = { first: tail.first, last: index };
    } else {
      runs.push({ first: index, last: index });
    }
  }
  return runs;
}

/**
 * The small label over a story's name (ruled copy, 2026-10-15): "Turn 11" for one
 * corner, "Turns 10–14" (an en dash) for a run, "Start/finish" for the S/F label.
 */
export function loreEyebrow(anchor: LoreAnchor): string {
  if ("startFinish" in anchor) return EYEBROW_START_FINISH;
  const { corners } = anchor;
  return corners.length === 1
    ? `Turn ${corners[0]}`
    : `Turns ${corners[0]}–${corners[corners.length - 1]}`;
}

/**
 * A story's accessible name (ruled copy, 2026-10-15): the eyebrow, a colon, the
 * name, and the subtitle in brackets when there is one. Used for the badge button,
 * the card's name, and the announcement when Previous/Next changes the story.
 */
export function loreAccessibleName(story: {
  readonly eyebrow: string;
  readonly name: string;
  readonly subtitle?: string | undefined;
}): string {
  const base = `${story.eyebrow}: ${story.name}`;
  return story.subtitle === undefined ? base : `${base} (${story.subtitle})`;
}

/**
 * The story `step` places along from `index` among `count`, wrapping round the
 * lap: Next from the last story is the first, Previous from the first is the last.
 * `count` is at least 1 whenever a card is open.
 */
export function stepStory(index: number, count: number, step: -1 | 1): number {
  return (((index + step) % count) + count) % count;
}
