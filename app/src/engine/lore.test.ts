/**
 * Corner-lore contract tests (Slice 18).
 *
 * Three jobs. Hold a lore file to its schema, one rejection per rule, so a broken
 * file fails here and never in front of a visitor. Pin the matching: a replay gets
 * a circuit's stories only when its corner record IS the one the stories were
 * written against, and anything else gets none rather than wrong ones. And pin the
 * derived copy, the eyebrow and the accessible name, to the ruled formats.
 *
 * Synthetic circuits with integer coordinates, so every distance is exact. The
 * committed lore files have their own test beside them (`src/lore/lore.test.ts`).
 */
import { describe, expect, it } from "vitest";
import {
  CornerLoreError,
  EYEBROW_START_FINISH,
  LORE_MATCH_TOLERANCE_M,
  LORE_SCHEMA_VERSION,
  LORE_STORY_MAX_CHARS,
  cornerLabel,
  layoutOffsetM,
  loreAccessibleName,
  loreEyebrow,
  parseCircuitLore,
  parseLoreCatalogue,
  resolveLore,
  stepStory,
  turnRuns,
} from "./lore";

/** A deep copy typed loosely, so a test can break it on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mutations are deliberately invalid; that is the point
type Mutable = any;

/** Four corners 100 m apart on a line: units are tenths of a metre. */
const RECORD = [
  { number: 1, letter: "", x: 0, y: 0 },
  { number: 2, letter: "", x: 1000, y: 0 },
  { number: 3, letter: "", x: 2000, y: 0 },
  { number: 4, letter: "", x: 3000, y: 0 },
];

const SOURCE = "https://example.org/history";

/**
 * Features listed OUT of lap order, and anchors in yet another order, so the
 * resolved order can only have come from the layout.
 */
const circuit = (): Mutable => ({
  schemaVersion: 1,
  id: "test-ring",
  features: [
    {
      id: "last-bend",
      name: "Last Bend",
      story: "The final corner.",
      sources: [SOURCE],
    },
    {
      id: "pit-straight",
      name: "Pit Straight",
      story: "Where the lap begins.",
      sources: [SOURCE],
    },
    {
      id: "first-bend",
      name: "First Bend",
      subtitle: "Uno",
      story: "The first corner.",
      sources: [SOURCE, "https://example.org/other"],
    },
    {
      id: "the-esses",
      name: "The Esses",
      story: "Two corners as one.",
      sources: [SOURCE],
    },
  ],
  layouts: [
    {
      id: "survey-1",
      provenance: "synthetic",
      corners: structuredClone(RECORD),
      anchors: {
        "the-esses": { corners: ["2", "3"] },
        "last-bend": { corners: ["4"] },
        "pit-straight": { startFinish: true },
        "first-bend": { corners: ["1"] },
      },
    },
  ],
});

const corners = (): Mutable[] => structuredClone(RECORD);
const catalogue = () => parseLoreCatalogue([circuit()]);

describe("parseCircuitLore — acceptance", () => {
  it("accepts a well-formed circuit and returns it", () => {
    const lore = parseCircuitLore(circuit());
    expect(lore.schemaVersion).toBe(LORE_SCHEMA_VERSION);
    expect(lore.features.map((f) => f.id)).toEqual([
      "last-bend",
      "pit-straight",
      "first-bend",
      "the-esses",
    ]);
    expect(lore.layouts[0].anchors["pit-straight"]).toEqual({
      startFinish: true,
    });
  });

  it("accepts a story of exactly the maximum length", () => {
    const ok = circuit();
    ok.features[0].story = "a".repeat(LORE_STORY_MAX_CHARS);
    expect(() => parseCircuitLore(ok)).not.toThrow();
  });

  it("accepts typographic apostrophes and en-dashed ranges", () => {
    const ok = circuit();
    ok.features[0].story =
      "It was tightened in 1994–95, after the park’s deer.";
    expect(() => parseCircuitLore(ok)).not.toThrow();
  });

  it("accepts corners just over twice the tolerance apart", () => {
    const ok = circuit();
    ok.layouts[0].corners[1].x = 2 * LORE_MATCH_TOLERANCE_M * 10 + 1;
    expect(() => parseCircuitLore(ok)).not.toThrow();
  });
});

describe("parseCircuitLore — rejection, one per rule", () => {
  const rejects = (mutate: (c: Mutable) => void, message: RegExp) => {
    const bad = circuit();
    mutate(bad);
    expect(() => parseCircuitLore(bad)).toThrow(CornerLoreError);
    expect(() => parseCircuitLore(bad)).toThrow(message);
  };

  it("names its source in the error", () => {
    const bad = circuit();
    bad.schemaVersion = 2;
    expect(() => parseCircuitLore(bad, "monza.json")).toThrow(
      /Invalid corner lore \(monza\.json\)/,
    );
    expect(() => parseCircuitLore(bad)).toThrow(
      /Invalid corner lore \(lore file\)/,
    );
  });

  it("rejects a wrong schemaVersion", () => {
    rejects((c) => (c.schemaVersion = 2), /schemaVersion must be 1/);
  });

  it("rejects an unknown key anywhere, rather than dropping it", () => {
    rejects((c) => (c.circuit = "Test Ring"), /circuit/);
    rejects((c) => (c.features[0].officialName = "X"), /officialName/);
    rejects((c) => (c.layouts[0].corners[0].angle = 1), /angle/);
    rejects((c) => (c.layouts[0].note = "x"), /note/);
  });

  it("rejects an id that is not a lowercase slug", () => {
    rejects((c) => (c.id = "Test Ring"), /lowercase slug/);
    rejects((c) => (c.features[0].id = "last_bend"), /lowercase slug/);
  });

  it("rejects an anchor keyed by a non-slug", () => {
    rejects(
      (c) => (c.layouts[0].anchors["Last Bend"] = { corners: ["4"] }),
      /Invalid key in record[\s\S]*anchors\["Last Bend"\]/,
    );
  });

  it("rejects empty copy", () => {
    rejects((c) => (c.features[0].name = ""), /must not be empty/);
  });

  it("rejects copy with whitespace at either end", () => {
    rejects((c) => (c.features[0].name = " Last Bend"), /start or end/);
    rejects((c) => (c.features[2].subtitle = "Uno "), /start or end/);
  });

  it("rejects a story of more than one paragraph", () => {
    rejects((c) => (c.features[0].story = "One.\nTwo."), /one paragraph/);
  });

  it("rejects a turn number in the copy, in any spelling", () => {
    rejects((c) => (c.features[0].story = "At Turn 4 it ends."), /turn number/);
    rejects((c) => (c.features[0].story = "Turns 10 to 14."), /turn number/);
    rejects((c) => (c.features[0].name = "T11"), /turn number/);
    rejects((c) => (c.features[2].subtitle = "turn 1"), /turn number/);
    rejects((c) => (c.features[0].story = "Corner 11 is last."), /turn number/);
  });

  it("rejects straight quotes and apostrophes", () => {
    rejects((c) => (c.features[0].story = "The park's deer."), /typographic/);
    rejects((c) => (c.features[0].name = '"Last"'), /typographic/);
  });

  it("rejects a hyphen in a numeric range", () => {
    rejects((c) => (c.features[0].story = "In 1994-95."), /en dash/);
    rejects((c) => (c.features[0].story = "In 1994 - 95."), /en dash/);
  });

  it("rejects a story over the maximum length", () => {
    rejects(
      (c) => (c.features[0].story = "a".repeat(LORE_STORY_MAX_CHARS + 1)),
      /at most 300 characters/,
    );
  });

  it("rejects a feature with no source", () => {
    rejects((c) => (c.features[0].sources = []), /cites a source/);
  });

  it("rejects a source that is not an https URL", () => {
    rejects(
      (c) => (c.features[0].sources = ["http://example.org"]),
      /https URL/,
    );
    rejects((c) => (c.features[0].sources = ["monzanet.it"]), /https URL/);
  });

  it("rejects an API query as a source: a page to cite, not a service's answer", () => {
    // Ruled 2026-10-15, "Drop the map-service links": the three Nominatim
    // geocoder queries once committed among Silverstone's sources.
    for (const query of [
      "https://nominatim.openstreetmap.org/reverse?lat=52.0728&lon=-1.0178&format=json&zoom=18&addressdetails=1",
      "https://nominatim.openstreetmap.org/search?q=Silverstone,+West+Northamptonshire&format=json&limit=3",
      "https://nominatim.openstreetmap.org/search?q=Stowe+School,+Buckingham&format=json&limit=3",
      // The same kind of thing from anywhere else.
      "https://nominatim.example.org/search?q=Monza",
      "https://api.example.org/v1/corners/11",
      "https://example.org/lookup?q=Monza&format=geojson",
      "https://example.org/lookup?output=XML",
      "https://example.org/lookup?format=jsonv2#top",
    ]) {
      rejects(
        (c) => (c.features[0].sources = [query]),
        /a page to cite, not an API query/,
      );
    }
  });

  it("accepts a page whose address merely mentions a format or an API", () => {
    for (const page of [
      "https://example.org/history/format-json-explained",
      "https://example.org/apis/of-monza",
      "https://example.org/lookup?format=html",
      "https://www.example.org/api.html",
    ]) {
      const ok = circuit();
      ok.features[0].sources = [page];
      expect(() => parseCircuitLore(ok)).not.toThrow();
    }
  });

  it("rejects a source listed twice", () => {
    rejects(
      (c) => (c.features[0].sources = [SOURCE, SOURCE]),
      /lists a source twice/,
    );
  });

  it("rejects a duplicate feature id", () => {
    rejects(
      (c) => (c.features[1].id = "last-bend"),
      /duplicate feature id "last-bend"/,
    );
  });

  it("rejects a duplicate layout id", () => {
    rejects((c) => {
      const second = structuredClone(c.layouts[0]);
      second.corners = second.corners.map((k: Mutable) => ({
        ...k,
        y: k.y + 5000,
      }));
      c.layouts.push(second);
    }, /duplicate layout id "survey-1"/);
  });

  it("rejects a layout that repeats a corner label", () => {
    rejects(
      (c) => (c.layouts[0].corners[3].number = 3),
      /repeats the corner label "3"/,
    );
  });

  it("rejects two corners within twice the match tolerance", () => {
    rejects(
      (c) => (c.layouts[0].corners[1].x = 2 * LORE_MATCH_TOLERANCE_M * 10),
      /corners "1" and "2" .* 20\.0 m apart, within twice the 10 m match tolerance/,
    );
  });

  it("rejects a layout that anchors nothing", () => {
    rejects((c) => {
      c.layouts.push({
        id: "survey-2",
        provenance: "synthetic",
        corners: [{ number: 9, letter: "", x: 9000, y: 9000 }],
        anchors: {},
      });
    }, /layout "survey-2" anchors no feature/);
  });

  it("rejects an anchor naming an unknown feature", () => {
    rejects(
      (c) => (c.layouts[0].anchors["no-such-bend"] = { corners: ["4"] }),
      /anchors "no-such-bend", which is not in features/,
    );
  });

  it("rejects an anchor to a corner the layout lacks", () => {
    rejects(
      (c) => (c.layouts[0].anchors["last-bend"] = { corners: ["5"] }),
      /corner "5", which is not in layout "survey-1"/,
    );
  });

  it("rejects one corner claimed by two features", () => {
    rejects(
      (c) => (c.layouts[0].anchors["last-bend"] = { corners: ["3"] }),
      /corner "3" in layout "survey-1" is anchored twice \("the-esses" and "last-bend"\)/,
    );
  });

  it("rejects one corner listed twice by the same feature", () => {
    rejects(
      (c) => (c.layouts[0].anchors["the-esses"] = { corners: ["2", "2"] }),
      /corner "2" .* anchored twice/,
    );
  });

  it("rejects two features on the start/finish line", () => {
    rejects(
      (c) => (c.layouts[0].anchors["last-bend"] = { startFinish: true }),
      /"last-bend" and "pit-straight" both anchor to the start\/finish line/,
    );
  });

  it("rejects an anchor that is not one run of neighbours in lap order", () => {
    const run = /must anchor to one run of neighbouring corners/;
    rejects((c) => {
      c.layouts[0].anchors["the-esses"] = { corners: ["2", "4"] };
      delete c.layouts[0].anchors["last-bend"];
      c.features.shift();
    }, run);
    rejects(
      (c) => (c.layouts[0].anchors["the-esses"] = { corners: ["3", "2"] }),
      run,
    );
  });

  it("rejects an anchor that is both kinds, or neither", () => {
    const both = circuit();
    both.layouts[0].anchors["last-bend"] = {
      corners: ["4"],
      startFinish: true,
    };
    expect(() => parseCircuitLore(both)).toThrow(CornerLoreError);
    rejects(
      (c) => (c.layouts[0].anchors["pit-straight"] = { startFinish: false }),
      /pit-straight/,
    );
    rejects(
      (c) => (c.layouts[0].anchors["last-bend"] = { corners: [] }),
      /last-bend/,
    );
  });

  it("rejects a feature no layout anchors", () => {
    rejects(
      (c) => delete c.layouts[0].anchors["last-bend"],
      /feature "last-bend" is anchored in no layout/,
    );
  });
});

describe("parseLoreCatalogue", () => {
  it("parses every file, in order", () => {
    const other = circuit();
    other.id = "other-ring";
    other.layouts[0].corners = other.layouts[0].corners.map((k: Mutable) => ({
      ...k,
      y: k.y + 5000,
    }));
    expect(parseLoreCatalogue([circuit(), other]).map((c) => c.id)).toEqual([
      "test-ring",
      "other-ring",
    ]);
  });

  it("names the failing file by its position", () => {
    const bad = circuit();
    bad.schemaVersion = 0;
    expect(() => parseLoreCatalogue([circuit(), bad])).toThrow(
      /\(lore file 1\)/,
    );
  });

  it("rejects two circuits with one id", () => {
    const twin = circuit();
    twin.layouts[0].corners[0].y = -5000;
    expect(() => parseLoreCatalogue([circuit(), twin])).toThrow(
      /duplicate lore circuit id "test-ring"/,
    );
  });

  it("rejects two circuits whose layouts match the same corner record", () => {
    const twin = circuit();
    twin.id = "twin-ring";
    // 5 m off: a replay inside both tolerances would match either.
    twin.layouts[0].corners[0].x = 50;
    expect(() => parseLoreCatalogue([circuit(), twin])).toThrow(
      /"test-ring\/survey-1" and "twin-ring\/survey-1" could match the same corner record: same labels, every corner within 5\.0 m/,
    );
  });

  it("rejects two layouts that one replay could match, though neither matches the other", () => {
    // 15 m apart: past the tolerance, so neither layout's record matches the
    // other's; but a replay 7.5 m from each is inside both.
    const twin = circuit();
    twin.id = "twin-ring";
    twin.layouts[0].corners[0].x = 150;
    expect(layoutOffsetM(RECORD, twin.layouts[0])).toBeNull();
    const between = corners();
    between[0].x = 75;
    expect(layoutOffsetM(between, circuit().layouts[0])).toBe(7.5);
    expect(layoutOffsetM(between, twin.layouts[0])).toBe(7.5);
    expect(() => parseLoreCatalogue([circuit(), twin])).toThrow(
      /could match the same corner record: same labels, every corner within 15\.0 m of its namesake, inside twice the 10 m match tolerance/,
    );
  });

  it("accepts two layouts more than twice the tolerance apart: no replay is within reach of both", () => {
    const twin = circuit();
    twin.id = "twin-ring";
    twin.layouts[0].corners[0].x = 2 * LORE_MATCH_TOLERANCE_M * 10 + 1;
    const both = parseLoreCatalogue([circuit(), twin]);
    expect(both.map((c) => c.id)).toEqual(["test-ring", "twin-ring"]);
    // Halfway is the point nearest both, and it is past the tolerance of each.
    const between = corners();
    between[0].x = (2 * LORE_MATCH_TOLERANCE_M * 10 + 1) / 2;
    expect(resolveLore(between, both)).toBeNull();
  });

  it("rejects two layouts in one circuit that match each other", () => {
    const c = circuit();
    c.layouts.push({ ...structuredClone(c.layouts[0]), id: "survey-2" });
    expect(() => parseLoreCatalogue([c])).toThrow(
      /"test-ring\/survey-1" and "test-ring\/survey-2" could match the same corner record/,
    );
  });
});

describe("cornerLabel", () => {
  it("is the number, then the letter", () => {
    expect(cornerLabel({ number: 11, letter: "" })).toBe("11");
    expect(cornerLabel({ number: 10, letter: "A" })).toBe("10A");
  });
});

describe("layoutOffsetM and resolveLore — matching by corner record", () => {
  const layout = { corners: RECORD };
  const moved = (index: number, dx: number, dy = 0) =>
    corners().map((c, i) =>
      i === index ? { ...c, x: c.x + dx, y: c.y + dy } : c,
    );

  it("matches the exact record at 0 m", () => {
    expect(layoutOffsetM(corners(), layout)).toBe(0);
  });

  it("matches a corner 9 m off and reports the worst offset", () => {
    expect(layoutOffsetM(moved(2, 90), layout)).toBe(9);
    // Euclidean, not per-axis: 5.4 m and 7.2 m is 9 m.
    expect(layoutOffsetM(moved(2, 54, 72), layout)).toBeCloseTo(9, 12);
  });

  it("matches at exactly the tolerance, and not 1 m past it", () => {
    expect(layoutOffsetM(moved(1, 100), layout)).toBe(LORE_MATCH_TOLERANCE_M);
    expect(layoutOffsetM(moved(1, 110), layout)).toBeNull();
  });

  it("refuses a record with a corner missing, or one extra", () => {
    expect(layoutOffsetM(corners().slice(0, 3), layout)).toBeNull();
    expect(
      layoutOffsetM(
        [...corners(), { number: 5, letter: "", x: 4000, y: 0 }],
        layout,
      ),
    ).toBeNull();
  });

  it("refuses a renumbering, shifted or rotated", () => {
    const shifted = corners().map((c) => ({ ...c, number: c.number + 1 }));
    expect(layoutOffsetM(shifted, layout)).toBeNull();
    // The same four labels, each on its neighbour's corner.
    const rotated = corners().map((c) => ({
      ...c,
      number: (c.number % 4) + 1,
    }));
    expect(layoutOffsetM(rotated, layout)).toBeNull();
  });

  it("refuses a lettered split", () => {
    const lettered = corners().map((c) =>
      c.number === 2 ? { ...c, letter: "A" } : c,
    );
    expect(layoutOffsetM(lettered, layout)).toBeNull();
  });

  it("refuses a record that repeats a label", () => {
    const repeated = corners().map((c) =>
      c.number === 3 ? { ...c, number: 2 } : c,
    );
    expect(layoutOffsetM(repeated, layout)).toBeNull();
  });

  it("refuses a corner whose position is not a number", () => {
    expect(layoutOffsetM(moved(0, Number.NaN), layout)).toBeNull();
  });

  it("pairs corners by label, so the record's order does not matter", () => {
    const reversed = corners().reverse();
    expect(layoutOffsetM(reversed, layout)).toBe(0);
    const lore = resolveLore(reversed, catalogue());
    // Indices are the REPLAY's (what the painted badges are built from), and the
    // story order is still the lap's.
    expect(lore?.stories.map((s) => [s.id, s.cornerIndices])).toEqual([
      ["pit-straight", []],
      ["first-bend", [3]],
      ["the-esses", [2, 1]],
      ["last-bend", [0]],
    ]);
  });

  it("gives no lore for an unknown record, or an empty catalogue", () => {
    expect(resolveLore(moved(0, 0, 500), catalogue())).toBeNull();
    expect(resolveLore(corners(), [])).toBeNull();
  });
});

describe("resolveLore — the stories", () => {
  it("names the circuit, the layout and the offset", () => {
    const lore = resolveLore(corners(), catalogue());
    expect(lore).toMatchObject({
      circuitId: "test-ring",
      layoutId: "survey-1",
      offsetM: 0,
    });
  });

  it("orders the stories round the lap, start/finish first", () => {
    const lore = resolveLore(corners(), catalogue());
    expect(lore?.stories.map((s) => s.id)).toEqual([
      "pit-straight",
      "first-bend",
      "the-esses",
      "last-bend",
    ]);
  });

  it("carries the copy verbatim, and derives the eyebrow and the name", () => {
    const [straight, first, esses] = resolveLore(
      corners(),
      catalogue(),
    )!.stories;
    expect(straight).toEqual({
      id: "pit-straight",
      name: "Pit Straight",
      subtitle: undefined,
      story: "Where the lap begins.",
      startFinish: true,
      cornerIndices: [],
      eyebrow: "Start/finish",
      accessibleName: "Start/finish: Pit Straight",
    });
    expect(first).toMatchObject({
      subtitle: "Uno",
      startFinish: false,
      cornerIndices: [0],
      eyebrow: "Turn 1",
      accessibleName: "Turn 1: First Bend (Uno)",
    });
    expect(esses).toMatchObject({
      cornerIndices: [1, 2],
      eyebrow: "Turns 2–3",
      accessibleName: "Turns 2–3: The Esses",
    });
  });

  it("leaves a corner with no story out, and a feature this layout does not anchor", () => {
    // A second layout (a re-survey, say): the same copy with fresh anchors, here
    // leaving one feature unanchored and corner 1 bare.
    const c = circuit();
    c.layouts.push({
      id: "survey-2",
      provenance: "synthetic renumbering",
      corners: RECORD.map((k) => ({ ...k, y: k.y + 5000 })),
      anchors: {
        "first-bend": { corners: ["2"] },
        "the-esses": { corners: ["3", "4"] },
      },
    });
    const renumbered = c.layouts[1].corners;
    const lore = resolveLore(renumbered, parseLoreCatalogue([c]));
    expect(lore?.layoutId).toBe("survey-2");
    expect(
      lore?.stories.map((s) => [s.id, s.eyebrow, s.cornerIndices]),
    ).toEqual([
      ["first-bend", "Turn 2", [1]],
      ["the-esses", "Turns 3–4", [2, 3]],
    ]);
  });

  it("matches the first circuit whose layout fits", () => {
    const other = circuit();
    other.id = "other-ring";
    other.layouts[0].corners = other.layouts[0].corners.map((k: Mutable) => ({
      ...k,
      y: k.y + 5000,
    }));
    const both = parseLoreCatalogue([circuit(), other]);
    expect(resolveLore(other.layouts[0].corners, both)?.circuitId).toBe(
      "other-ring",
    );
  });
});

describe("turnRuns", () => {
  it("compresses neighbours into runs, forwards only", () => {
    expect(turnRuns([])).toEqual([]);
    expect(turnRuns([3])).toEqual([{ first: 3, last: 3 }]);
    expect(turnRuns([9, 10, 11, 12, 13])).toEqual([{ first: 9, last: 13 }]);
    expect(turnRuns([4, 10])).toEqual([
      { first: 4, last: 4 },
      { first: 10, last: 10 },
    ]);
    expect(turnRuns([1, 2, 5])).toEqual([
      { first: 1, last: 2 },
      { first: 5, last: 5 },
    ]);
    expect(turnRuns([2, 1])).toEqual([
      { first: 2, last: 2 },
      { first: 1, last: 1 },
    ]);
  });
});

describe("the ruled formats (copy ruling, 2026-10-15)", () => {
  it("writes the eyebrow for one corner, a run, and the start/finish label", () => {
    expect(loreEyebrow({ corners: ["11"] })).toBe("Turn 11");
    expect(loreEyebrow({ corners: ["10", "11", "12", "13", "14"] })).toBe(
      "Turns 10–14",
    );
    expect(loreEyebrow({ corners: ["10A", "10B"] })).toBe("Turns 10A–10B");
    expect(loreEyebrow({ startFinish: true })).toBe("Start/finish");
    expect(EYEBROW_START_FINISH).toBe("Start/finish");
  });

  it("joins a run with an en dash, U+2013", () => {
    const eyebrow = loreEyebrow({ corners: ["1", "2"] });
    expect(eyebrow).toBe("Turns 1–2");
    expect(eyebrow).not.toContain("-");
  });

  it("writes the accessible name, with the subtitle in brackets when there is one", () => {
    expect(
      loreAccessibleName({
        eyebrow: "Turn 11",
        name: "Curva Alboreto",
        subtitle: "Parabolica",
      }),
    ).toBe("Turn 11: Curva Alboreto (Parabolica)");
    expect(
      loreAccessibleName({
        eyebrow: "Turns 10–14",
        name: "Maggotts, Becketts and Chapel",
      }),
    ).toBe("Turns 10–14: Maggotts, Becketts and Chapel");
    expect(
      loreAccessibleName({
        eyebrow: "Start/finish",
        name: "Hamilton Straight",
        subtitle: undefined,
      }),
    ).toBe("Start/finish: Hamilton Straight");
  });
});

describe("stepStory — Previous/Next round the lap", () => {
  it("steps forwards and backwards", () => {
    expect(stepStory(0, 7, 1)).toBe(1);
    expect(stepStory(3, 7, -1)).toBe(2);
  });

  it("wraps at both ends", () => {
    expect(stepStory(6, 7, 1)).toBe(0);
    expect(stepStory(0, 7, -1)).toBe(6);
  });

  it("stays put with one story", () => {
    expect(stepStory(0, 1, 1)).toBe(0);
    expect(stepStory(0, 1, -1)).toBe(0);
  });
});
