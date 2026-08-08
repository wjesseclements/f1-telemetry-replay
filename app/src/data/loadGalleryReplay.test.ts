/**
 * Gallery load-path tests — including the offline boundary itself.
 *
 * Two things are pinned here that nothing else can pin:
 *
 *  1. **The fetch trap works.** `src/test/setup.ts` replaces `fetch` with a stub
 *     that throws, so the suite cannot reach the network by accident. The first
 *     test asserts that directly, because a trap nobody verifies is a trap that
 *     might already be disarmed. Everything below it stubs `fetch` deliberately.
 *  2. **Every failure degrades.** Four distinct ways loading a scenario can fail,
 *     each asserted to return a message rather than throw — the contract the panel
 *     depends on to keep the current replay on screen.
 *
 * No test here touches the network. The success case is served from the committed
 * fixture, so this file runs offline exactly like every other.
 */
import { describe, it, expect, vi } from "vitest";
import sampleLap from "../engine/__fixtures__/sample-lap.json";
import manifest from "../gallery/manifest.json";
import { parseGalleryManifest } from "../engine/gallery";
import { loadGalleryReplay } from "./loadGalleryReplay";

const scenario = parseGalleryManifest(manifest).scenarios[0];

/**
 * A `fetch` that answers one request with the given body, recording the URL.
 *
 * Defaults to `application/json`, because a real gallery asset is served that way
 * and the loader now checks — see the SPA-fallback regression test below. Tests that
 * need a different content-type pass their own headers.
 */
function stubFetch(body: BodyInit, init: ResponseInit = {}) {
  const headers = init.headers ?? { "content-type": "application/json" };
  // Typed through the generic rather than a discarded parameter, so `mock.calls`
  // is typed without leaving an unused binding for lint to object to.
  const spy = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
    async () => new Response(body, { status: 200, ...init, headers }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("the offline boundary", () => {
  it("blocks an unmocked fetch with an actionable message", async () => {
    // The trap from `src/test/setup.ts`, verified rather than assumed. If this ever
    // stops throwing, the suite has silently gained the ability to hit the network.
    await expect(fetch("https://example.com/anything")).rejects.toThrow(
      /Blocked network call/,
    );
  });

  it("tells a developer how to opt in", async () => {
    await expect(fetch("/gallery/x.json")).rejects.toThrow(/vi\.stubGlobal/);
  });
});

describe("loadGalleryReplay — success", () => {
  it("validates through the real parseReplay and returns the replay", async () => {
    stubFetch(JSON.stringify(sampleLap));

    const result = await loadGalleryReplay(scenario);

    expect(result.error).toBeNull();
    expect(result.replay?.cars.length).toBeGreaterThanOrEqual(1);
    expect(result.replay?.meta.schemaVersion).toBe(1);
  });

  it("fetches the scenario's own same-origin path", async () => {
    const spy = stubFetch(JSON.stringify(sampleLap));

    await loadGalleryReplay(scenario, "/");

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toBe(`/gallery/${scenario.file}`);
  });

  it("resolves under a non-root base path", async () => {
    const spy = stubFetch(JSON.stringify(sampleLap));

    await loadGalleryReplay(scenario, "/preview/");

    expect(spy.mock.calls[0][0]).toBe(`/preview/gallery/${scenario.file}`);
  });
});

describe("loadGalleryReplay — every failure degrades, none throws", () => {
  it("reports a network error and suggests the picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const result = await loadGalleryReplay(scenario);

    expect(result.replay).toBeNull();
    expect(result.error).toMatch(/Could not reach/);
    expect(result.error).toMatch(/Failed to fetch/);
    // The degradation contract: the picker is still a way in.
    expect(result.error).toMatch(/Load replay JSON/);
  });

  it("reports a non-200 as a missing deployment, with the status", async () => {
    stubFetch("<!doctype html>", { status: 404, statusText: "Not Found" });

    const result = await loadGalleryReplay(scenario);

    expect(result.replay).toBeNull();
    expect(result.error).toMatch(/404/);
    expect(result.error).toMatch(/missing from the deployment/);
  });

  it("reports an SPA fallback as a missing asset, not as malformed JSON", async () => {
    // A REGRESSION TEST, and the defect was found in a browser rather than here.
    // A missing gallery asset almost never 404s: `vite preview` — and any SPA host,
    // Vercel included — answers an unknown path with the index document at
    // **200 text/html**. So `res.ok` is true, and before the content-type check the
    // visitor was told "not valid JSON: Unexpected token '<'" for a file that was
    // simply absent. jsdom could not have caught this; it is a server property.
    stubFetch("<!doctype html><html><body>app shell</body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const result = await loadGalleryReplay(scenario);

    expect(result.replay).toBeNull();
    expect(result.error).toMatch(/missing from the deployment/);
    expect(result.error).toMatch(/text\/html/);
    expect(result.error).not.toMatch(/not valid JSON/);
  });

  it("reports a response with no content-type as missing too", async () => {
    // `Response` always defaults a Content-Type for a body, so the header has to be
    // deleted to produce the headerless case. Guards the `?? ""` fallback.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response("whatever");
        response.headers.delete("content-type");
        return response;
      }),
    );

    const result = await loadGalleryReplay(scenario);

    expect(result.error).toMatch(/no content-type/);
    expect(result.error).toMatch(/missing from the deployment/);
  });

  it("reports malformed JSON as a syntax problem, not 500 schema violations", async () => {
    stubFetch('{"meta": {"schemaVersion": 1,');

    const result = await loadGalleryReplay(scenario);

    expect(result.replay).toBeNull();
    expect(result.error).toMatch(/is not valid JSON/);
    // The distinction that makes the message useful: a truncated file is one
    // syntax error, not a wall of schema paths.
    expect(result.error).not.toMatch(/schema violation/);
  });

  it("reports a schema-invalid payload with the offending path", async () => {
    const broken = structuredClone(sampleLap) as {
      cars: { samples: { speed: number }[] }[];
    };
    broken.cars[0].samples[3].speed = -1;
    stubFetch(JSON.stringify(broken));

    const result = await loadGalleryReplay(scenario);

    expect(result.replay).toBeNull();
    // Verbatim `ReplayValidationError.message`: the `→ at …` path is the whole
    // value of it, and the gallery gets the same shaping as the file picker.
    expect(result.error).toMatch(/cars\[0\]\.samples\[3\]\.speed/);
    expect(result.error).toMatch(/schema violation/);
  });

  it("names the scenario file, not the URL, in a payload error", async () => {
    stubFetch("not json at all");

    const result = await loadGalleryReplay(scenario);

    expect(result.error).toContain(scenario.file);
  });
});
