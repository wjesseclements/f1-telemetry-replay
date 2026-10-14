import { axTextOf, judgeNames, type NameCheck } from "./accessibility";

describe("axTextOf", () => {
  it("reads the node that belongs to the DOM node, not the first one", () => {
    const nodes = [
      { backendDOMNodeId: 7, name: { value: "Playback controls" } },
      {
        backendDOMNodeId: 12,
        name: { value: "Pause" },
        description: { value: "Pause" },
      },
    ];
    expect(axTextOf(nodes, 12)).toEqual({
      name: "Pause",
      description: "Pause",
    });
  });

  it("reads an absent name or description as empty", () => {
    // Chrome omits `description` when there is none, which is the passing case.
    expect(
      axTextOf([{ backendDOMNodeId: 3, name: { value: "Play" } }], 3),
    ).toEqual({ name: "Play", description: "" });
    expect(axTextOf([{ backendDOMNodeId: 3 }], 3)).toEqual({
      name: "",
      description: "",
    });
  });

  it("is null when no node belongs to the DOM node", () => {
    expect(axTextOf([{ backendDOMNodeId: 4 }], 5)).toBeNull();
    expect(axTextOf([], 5)).toBeNull();
  });
});

describe("judgeNames", () => {
  const toggle = (name: string, description = ""): NameCheck => ({
    what: "toggle",
    expected: ["Play", "Pause"],
    reading: { name, description },
  });
  const restart = (name: string, description = ""): NameCheck => ({
    what: "restart",
    expected: ["Restart lap"],
    reading: { name, description },
  });

  it("passes expected names with no description, and prints both", () => {
    expect(judgeNames([toggle("Play"), restart("Restart lap")])).toEqual({
      pass: true,
      measured:
        'toggle: name "Play", description "" · restart: name "Restart lap", description ""',
    });
    expect(judgeNames([toggle("Pause"), restart("Restart lap")]).pass).toBe(
      true,
    );
  });

  it("fails a description equal to the name: the tooltip read twice", () => {
    // What Chrome 155 reported for 5075d6a's markup, and for cb75031's.
    expect(
      judgeNames([
        toggle("Play", "Play"),
        restart("Restart lap", "Restart lap"),
      ]),
    ).toEqual({
      pass: false,
      measured:
        'toggle: name "Play", description "Play" · restart: name "Restart lap", description "Restart lap"',
    });
    // Either control on its own is enough.
    expect(
      judgeNames([toggle("Play"), restart("Restart lap", "Restart lap")]).pass,
    ).toBe(false);
  });

  it("fails a name that is not one of the expected names", () => {
    // A glyph that leaked into the name, say.
    expect(judgeNames([toggle("▶ Play"), restart("Restart lap")]).pass).toBe(
      false,
    );
    expect(judgeNames([toggle("Play"), restart("")]).pass).toBe(false);
  });

  it("fails a control that was not found or has no accessibility node, saying which", () => {
    expect(
      judgeNames([
        { ...toggle("Play"), reading: "not found" },
        restart("Restart lap"),
      ]),
    ).toEqual({
      pass: false,
      measured:
        'toggle: not found · restart: name "Restart lap", description ""',
    });
    expect(
      judgeNames([
        toggle("Play"),
        { ...restart("Restart lap"), reading: "no accessibility node" },
      ]).measured,
    ).toBe(
      'toggle: name "Play", description "" · restart: no accessibility node',
    );
  });
});
