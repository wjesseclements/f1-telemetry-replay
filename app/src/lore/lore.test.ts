/**
 * The committed corner-lore catalogue (Slice 18).
 *
 * `engine/lore.test.ts` holds the contract to its rules on synthetic circuits.
 * This holds the COMMITTED files to the rulings:
 *
 * - the catalogue is every JSON file in this directory, each named by its id, so
 *   a new circuit cannot be committed and silently left out of `index.ts`;
 * - every story is the human's ruled copy (2026-10-15), byte for byte, in lap
 *   order, with the derived eyebrow and accessible name in the ruled formats. The
 *   expected strings are written out below, not read from anywhere, so changing
 *   a word means changing it here too, on purpose;
 * - every painted number at both circuits has exactly one story;
 * - the real corner records refuse the near misses a regenerated file could
 *   bring: a corner moved past the tolerance, a renumbering, an extra corner, a
 *   lettered split, a repeated label. The fixture matches nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import {
  LORE_SCHEMA_VERSION,
  parseCircuitLore,
  resolveLore,
  type CircuitLore,
} from "../engine/lore";
import { LORE } from "./index";

const DIR = dirname(fileURLToPath(import.meta.url));

const JSON_FILES = readdirSync(DIR)
  .filter((file) => file.endsWith(".json"))
  .sort();

const circuitById = (id: string): CircuitLore => {
  const circuit = LORE.find((c) => c.id === id);
  if (circuit === undefined) throw new Error(`no lore circuit "${id}"`);
  return circuit;
};

/** The circuit's own record: what a replay of it carries as `track.corners`. */
const recordOf = (id: string) =>
  structuredClone(circuitById(id).layouts[0].corners);

/**
 * The ruled copy, verbatim, in lap order: curly apostrophes (U+2019) and en
 * dashes (U+2013) as ruled. The eyebrows are the ruled formats applied to the
 * ruled anchors.
 */
const RULED = {
  monza: [
    {
      id: "prima-variante",
      eyebrow: "Turns 1–2",
      name: "Prima Variante",
      subtitle: undefined,
      story:
        "The first chicane, built in 1972 to slow cars before the Curva Grande, rebuilt as a double chicane in 1976 and in 2000 as today’s right-left. Prima variante means first chicane; rettifilo, as in its older name Variante del Rettifilo, means straight.",
    },
    {
      id: "curva-biassono",
      eyebrow: "Turn 3",
      name: "Curva Biassono",
      subtitle: "Curva Grande",
      story:
        "Called Curva Grande, the big curve, for its wide radius of about 300 metres. It was renamed in 1972 after the nearby town of Biassono, though it is still commonly called Curva Grande.",
    },
    {
      id: "seconda-variante",
      eyebrow: "Turns 4–5",
      name: "Seconda Variante",
      subtitle: "Variante della Roggia",
      story:
        "The second chicane, built in 1976 to cut speeds on the run to Lesmo. It keeps the name of the old Curva della Roggia, after a small stream nearby.",
    },
    {
      id: "prima-curva-di-lesmo",
      eyebrow: "Turn 6",
      name: "Prima Curva di Lesmo",
      subtitle: "Lesmo 1",
      story:
        "Originally the Curva delle Querce, the curve of the oaks, after the surrounding woods. By 1927 it had taken the name of the nearby town of Lesmo.",
    },
    {
      id: "seconda-curva-di-lesmo",
      eyebrow: "Turn 7",
      name: "Seconda Curva di Lesmo",
      subtitle: "Lesmo 2",
      story:
        "Known as the Curva dei 100 Metri in 1922, and in 1927 as the Curva del Bosco dei Cervi, after the park’s deer. It was tightened in 1994–95. The very slight left that follows, the Curva del Serraglio, is not counted as a corner; it is named after a royal hunting lodge in the park.",
    },
    {
      id: "variante-ascari",
      eyebrow: "Turns 8–10",
      name: "Variante Ascari",
      subtitle: undefined,
      story:
        "Once the Curva del Vialone or del Platano, it was named in 1955 for Alberto Ascari, twice world champion, who was killed here that May testing a Ferrari sports car. It became the Variante Ascari when the chicane was built in 1972.",
    },
    {
      id: "curva-alboreto",
      eyebrow: "Turn 11",
      name: "Curva Alboreto",
      subtitle: "Parabolica",
      story:
        "Built in 1955 to replace two hairpins paved with porphyry, and named Parabolica for its shape. In 2021 it was renamed for the Milanese driver Michele Alboreto, twenty years after his death.",
    },
  ],
  silverstone: [
    {
      id: "hamilton-straight",
      eyebrow: "Start/finish",
      name: "Hamilton Straight",
      subtitle: undefined,
      story:
        "The International Pits Straight until December 2020, when it was renamed for Lewis Hamilton after his seventh world title. It was the first part of the circuit named after a person.",
    },
    {
      id: "abbey",
      eyebrow: "Turn 1",
      name: "Abbey",
      subtitle: undefined,
      story:
        "Named after Luffield Abbey, a medieval Benedictine priory whose remains were found nearby.",
    },
    {
      id: "farm",
      eyebrow: "Turn 2",
      name: "Farm",
      subtitle: undefined,
      story:
        "Named after a farm that the original straight here once ran past.",
    },
    {
      id: "village",
      eyebrow: "Turn 3",
      name: "Village",
      subtitle: undefined,
      story:
        "Named after Silverstone, the village just north of the circuit that also gave the track its name. It was built with the Arena section in 2010.",
    },
    {
      id: "the-loop",
      eyebrow: "Turn 4",
      name: "The Loop",
      subtitle: undefined,
      story:
        "The only Silverstone corner named for its shape: a tight left-hand hairpin and the slowest point of the lap, added in 2010.",
    },
    {
      id: "aintree",
      eyebrow: "Turn 5",
      name: "Aintree",
      subtitle: undefined,
      story:
        "Named after Aintree, near Liverpool, where a circuit in the racecourse grounds held the British Grand Prix five times between 1955 and 1962.",
    },
    {
      id: "brooklands",
      eyebrow: "Turn 6",
      name: "Brooklands",
      subtitle: undefined,
      story:
        "Named after Brooklands in Surrey, the first purpose-built motor racing circuit, which held the first two British Grands Prix, in 1926 and 1927. The Wellington Straight leading to it is built on a wartime runway and named after the Vickers Wellington bombers flown from RAF Silverstone.",
    },
    {
      id: "luffield",
      eyebrow: "Turn 7",
      name: "Luffield",
      subtitle: undefined,
      story:
        "Like Abbey, named after the medieval Luffield priory. Added in the late 1980s, it was once two corners and is now one long right-hander.",
    },
    {
      id: "woodcote",
      eyebrow: "Turn 8",
      name: "Woodcote",
      subtitle: undefined,
      story:
        "Named after Woodcote Park in Surrey, the country club of the Royal Automobile Club, which ran the first British Grand Prix at Silverstone, in 1948. It was once the last corner of the lap.",
    },
    {
      id: "copse",
      eyebrow: "Turn 9",
      name: "Copse",
      subtitle: undefined,
      story:
        "Named after the small woods nearby, Chapel Copse and Cheese Copse. It was the first corner of the lap for almost sixty years.",
    },
    {
      id: "maggotts-becketts-chapel",
      eyebrow: "Turns 10–14",
      name: "Maggotts, Becketts and Chapel",
      subtitle: undefined,
      story:
        "Maggotts takes its name from a nearby moor, and Becketts and Chapel from a medieval chapel of St Thomas Becket, demolished in 1943 to make way for an airfield runway. The three bends became one run of esses in 1991.",
    },
    {
      id: "stowe",
      eyebrow: "Turn 15",
      name: "Stowe",
      subtitle: undefined,
      story:
        "Named after Stowe School, south of the circuit. The Hangar Straight leading to it is named after the wartime RAF base’s aircraft hangars, two of which stood beside the straight.",
    },
    {
      id: "vale",
      eyebrow: "Turn 16",
      name: "Vale",
      subtitle: undefined,
      story:
        "Its origin is not settled: the name may describe the slight dip on the run down from Stowe, or come from Aylesbury Vale, the district this part of the circuit lay in until 2020.",
    },
    {
      id: "club",
      eyebrow: "Turns 17–18",
      name: "Club",
      subtitle: undefined,
      story:
        "Named after the Royal Automobile Club’s clubhouse on Pall Mall in London. It is now the last corner of the lap.",
    },
  ],
} as const;

describe("the lore catalogue on disk", () => {
  it("is every JSON file in this directory, each named by its id", () => {
    expect(JSON_FILES).toEqual(["monza.json", "silverstone.json"]);
    for (const file of JSON_FILES) {
      const json = JSON.parse(readFileSync(join(DIR, file), "utf8"));
      expect(`${json.id}.json`).toBe(file);
    }
    expect(LORE.map((c) => `${c.id}.json`).sort()).toEqual(JSON_FILES);
  });

  it("is exactly the files, parsed: index.ts imports each one once", () => {
    for (const file of JSON_FILES) {
      const parsed = parseCircuitLore(
        JSON.parse(readFileSync(join(DIR, file), "utf8")),
        file,
      );
      expect(parsed.schemaVersion).toBe(LORE_SCHEMA_VERSION);
      expect(circuitById(parsed.id)).toEqual(parsed);
    }
    expect(LORE).toHaveLength(JSON_FILES.length);
  });
});

describe.each(Object.entries(RULED))("the %s stories", (id, ruled) => {
  const lore = resolveLore(recordOf(id), LORE);

  it("resolve from the circuit's own corner record", () => {
    expect(lore?.circuitId).toBe(id);
    expect(lore?.offsetM).toBe(0);
  });

  it("are the ruled copy, byte for byte, in lap order", () => {
    expect(
      lore?.stories.map(({ id, eyebrow, name, subtitle, story }) => ({
        id,
        eyebrow,
        name,
        subtitle,
        story,
      })),
    ).toEqual(ruled);
  });

  it("are named in the ruled format", () => {
    for (const story of lore!.stories) {
      expect(story.accessibleName).toBe(
        story.subtitle === undefined
          ? `${story.eyebrow}: ${story.name}`
          : `${story.eyebrow}: ${story.name} (${story.subtitle})`,
      );
    }
  });

  it("give every painted number exactly one story", () => {
    const covered = lore!.stories.flatMap((s) => s.cornerIndices);
    expect([...covered].sort((a, b) => a - b)).toEqual(
      recordOf(id).map((_, i) => i),
    );
  });
});

describe("the ruled examples", () => {
  const named = (circuit: string, id: string) =>
    resolveLore(recordOf(circuit), LORE)!.stories.find((s) => s.id === id)!
      .accessibleName;

  it("reads them exactly as ruled", () => {
    expect(named("monza", "curva-alboreto")).toBe(
      "Turn 11: Curva Alboreto (Parabolica)",
    );
    expect(named("silverstone", "maggotts-becketts-chapel")).toBe(
      "Turns 10–14: Maggotts, Becketts and Chapel",
    );
    expect(named("silverstone", "hamilton-straight")).toBe(
      "Start/finish: Hamilton Straight",
    );
  });

  it("puts the Hamilton Straight on the start/finish label, first in the lap", () => {
    const [first] = resolveLore(recordOf("silverstone"), LORE)!.stories;
    expect(first.id).toBe("hamilton-straight");
    expect(first.startFinish).toBe(true);
    expect(first.cornerIndices).toEqual([]);
  });
});

describe("near misses on the real Monza record get no lore", () => {
  const monza = () => recordOf("monza");
  const at11 = (dx: number) =>
    monza().map((c) => (c.number === 11 ? { ...c, x: c.x + dx } : c));

  it("matches with the Parabolica 9 m off, not 11 m", () => {
    expect(resolveLore(at11(90), LORE)?.offsetM).toBeCloseTo(9, 6);
    expect(resolveLore(at11(110), LORE)).toBeNull();
  });

  it("refuses a renumbering by one", () => {
    const renumbered = monza().map((c) => ({
      ...c,
      number: (c.number % 11) + 1,
    }));
    expect(resolveLore(renumbered, LORE)).toBeNull();
  });

  it("refuses an extra corner, a missing one, a lettered split and a repeated label", () => {
    expect(
      resolveLore([...monza(), { number: 12, letter: "", x: 0, y: 0 }], LORE),
    ).toBeNull();
    expect(resolveLore(monza().slice(1), LORE)).toBeNull();
    expect(
      resolveLore(
        monza().map((c) => (c.number === 11 ? { ...c, letter: "A" } : c)),
        LORE,
      ),
    ).toBeNull();
    expect(
      resolveLore(
        monza().map((c) => (c.number === 2 ? { ...c, number: 1 } : c)),
        LORE,
      ),
    ).toBeNull();
  });

  it("gives the committed fixture none", () => {
    expect(resolveLore(sampleLap.track.corners, LORE)).toBeNull();
  });
});
