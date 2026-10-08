import { isOffOrigin, PageRecorder } from "./recorder";

const ORIGIN = "http://127.0.0.1:4173";

describe("isOffOrigin", () => {
  it("passes the preview origin and in-process URLs", () => {
    expect(isOffOrigin(`${ORIGIN}/gallery/x.json`, ORIGIN)).toBe(false);
    expect(isOffOrigin("data:image/svg+xml,<svg/>", ORIGIN)).toBe(false);
    expect(isOffOrigin("blob:http://127.0.0.1:4173/abc", ORIGIN)).toBe(false);
    expect(isOffOrigin("about:blank", ORIGIN)).toBe(false);
    expect(isOffOrigin("ws://127.0.0.1:4173/socket", ORIGIN)).toBe(false);
  });

  it("flags another host, another port, an IP literal and a foreign socket", () => {
    expect(isOffOrigin("https://example.com/x", ORIGIN)).toBe(true);
    expect(isOffOrigin("http://127.0.0.1:5173/", ORIGIN)).toBe(true);
    expect(isOffOrigin("http://localhost:4173/", ORIGIN)).toBe(true);
    expect(isOffOrigin("http://192.0.2.1/x", ORIGIN)).toBe(true);
    expect(isOffOrigin("wss://example.com/live", ORIGIN)).toBe(true);
    expect(isOffOrigin("not a url", ORIGIN)).toBe(true);
  });
});

describe("PageRecorder", () => {
  const request = (requestId: string, url: string) => ({
    method: "Network.requestWillBeSent",
    params: { requestId, request: { url } },
  });

  it("records only off-origin requests, with how Chrome failed them", () => {
    const recorder = new PageRecorder(ORIGIN);
    recorder.handle(request("1", `${ORIGIN}/`));
    recorder.handle(request("2", "https://example.com/probe"));
    recorder.handle({
      method: "Network.loadingFailed",
      params: { requestId: "2", errorText: "net::ERR_NAME_NOT_RESOLVED" },
    });
    // A failure of an on-origin request is not this recorder's business.
    recorder.handle({
      method: "Network.loadingFailed",
      params: { requestId: "1", errorText: "net::ERR_ABORTED" },
    });
    expect(recorder.offOrigin).toEqual(["https://example.com/probe"]);
    expect(recorder.summary()).toBe(
      "1: https://example.com/probe (net::ERR_NAME_NOT_RESOLVED)",
    );
  });

  it("records foreign sockets and uncaught exceptions", () => {
    const recorder = new PageRecorder(ORIGIN);
    recorder.handle({
      method: "Network.webSocketCreated",
      params: { requestId: "9", url: "wss://example.com/live" },
    });
    recorder.handle({
      method: "Runtime.exceptionThrown",
      params: {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "TypeError: boom" },
        },
      },
    });
    recorder.handle({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { text: "Uncaught (in promise)" } },
    });
    expect(recorder.offOrigin).toEqual(["wss://example.com/live"]);
    expect(recorder.exceptions).toEqual([
      "TypeError: boom",
      "Uncaught (in promise)",
    ]);
  });

  it("keys a failure to its own session: a worker may reuse a page's request id", () => {
    const recorder = new PageRecorder(ORIGIN);
    recorder.handle({
      ...request("7", "https://a.example/"),
      sessionId: "page",
    });
    recorder.handle({
      ...request("7", "https://b.example/"),
      sessionId: "worker",
    });
    // Fail the PAGE's request — the FIRST registration of id 7. A key of the
    // request id alone lets the worker's registration overwrite it, so the failure
    // would land on b.example; failing the worker's instead could not tell the two
    // keyings apart.
    recorder.handle({
      method: "Network.loadingFailed",
      sessionId: "page",
      params: { requestId: "7", errorText: "net::ERR_NAME_NOT_RESOLVED" },
    });
    expect(recorder.summary()).toBe(
      "2: https://a.example/ (net::ERR_NAME_NOT_RESOLVED), https://b.example/",
    );
  });

  it("summarises exceptions by their first line, and none as 0", () => {
    const recorder = new PageRecorder(ORIGIN);
    expect(recorder.exceptionSummary()).toBe("0");
    recorder.handle({
      method: "Runtime.exceptionThrown",
      params: {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "Error: boom\n    at x (y.js:1:1)" },
        },
      },
    });
    expect(recorder.exceptionSummary()).toBe("1: Error: boom");
  });

  it("summarises a clean page by its origin, and elides a long list", () => {
    expect(new PageRecorder(ORIGIN).summary()).toBe(`0 (origin ${ORIGIN})`);
    const noisy = new PageRecorder(ORIGIN);
    for (let i = 0; i < 5; i++) {
      noisy.handle(request(String(i), `https://cdn.example/${i}`));
    }
    expect(noisy.summary()).toBe(
      "5: https://cdn.example/0, https://cdn.example/1, https://cdn.example/2, +2 more",
    );
  });
});
