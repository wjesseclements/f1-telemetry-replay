/**
 * Tests for the picked-file path.
 *
 * The point of these is that a picked file gets the SAME treatment as the committed
 * fixture — real `parseReplay`, real error message — and that the three ways it can
 * fail (unreadable, not JSON, not a replay) are told apart, because "this file is
 * truncated" and "this file has 600 schema violations" want different fixes.
 */
import { describe, expect, it } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import { loadReplayFile } from "./loadReplayFile";

/** jsdom's File implements `.text()`, so no shim is needed for the happy path. */
const fileOf = (contents: string, name = "replay.json") =>
  new File([contents], name, { type: "application/json" });

describe("loadReplayFile", () => {
  it("validates a conforming replay and returns it", async () => {
    const result = await loadReplayFile(fileOf(JSON.stringify(sampleLap)));
    expect(result.error).toBeNull();
    expect(result.replay?.meta.schemaVersion).toBe(1);
    expect(result.replay?.cars).toHaveLength(1);
  });

  it("reports malformed JSON as a syntax problem, not a schema one", async () => {
    const result = await loadReplayFile(fileOf('{"meta": {', "truncated.json"));
    expect(result.replay).toBeNull();
    expect(result.error).toContain("truncated.json is not valid JSON");
    // Crucially NOT a wall of schema violations, which is what a naive
    // `JSON.parse` failure falling through to the schema would produce.
    expect(result.error).not.toContain("schema violation");
  });

  it("passes the schema error through verbatim, paths and all", async () => {
    const broken = structuredClone(sampleLap) as {
      meta: { schemaVersion: number };
    };
    broken.meta.schemaVersion = 99;
    const result = await loadReplayFile(
      fileOf(JSON.stringify(broken), "wrong-version.json"),
    );
    expect(result.replay).toBeNull();
    // The filename is quoted, and the `→ at …` path lines survive intact — this is
    // the same message `ReplayError` renders for a bad fixture.
    expect(result.error).toContain("wrong-version.json");
    expect(result.error).toContain("schemaVersion must be 1");
    expect(result.error).toContain("→ at meta.schemaVersion");
  });

  it("reports an unreadable file rather than throwing", async () => {
    const unreadable = {
      name: "gone.json",
      text: () => Promise.reject(new Error("NotReadableError")),
    } as unknown as File;
    const result = await loadReplayFile(unreadable);
    expect(result.replay).toBeNull();
    expect(result.error).toContain("Could not read gone.json");
    expect(result.error).toContain("NotReadableError");
  });
});
