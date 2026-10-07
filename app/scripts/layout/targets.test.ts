import type { CdpEvent } from "./cdp";
import { Targets, type CdpLike } from "./targets";

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A CDP client that records what is sent and lets the test emit events. */
function fakeClient(answer: (sent: Sent) => Promise<unknown>) {
  const sent: Sent[] = [];
  let listener: (event: CdpEvent) => void = () => undefined;
  const client: CdpLike = {
    send: <T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) => {
      const s = { method, params, sessionId };
      sent.push(s);
      return answer(s) as Promise<T>;
    },
    onEvent: (l) => {
      listener = l;
      return () => undefined;
    },
  };
  return { client, sent, emit: (event: CdpEvent) => listener(event) };
}

const attached = (
  parent: string | undefined,
  child: string,
  type: string,
  browserContextId?: string,
): CdpEvent => ({
  method: "Target.attachedToTarget",
  sessionId: parent,
  params: { sessionId: child, targetInfo: { type, browserContextId } },
});

const methodsFor = (sent: Sent[], sessionId: string) =>
  sent.filter((s) => s.sessionId === sessionId).map((s) => s.method);

describe("Targets", () => {
  it("asks the browser level for shared workers only", async () => {
    const { client, sent } = fakeClient(() => Promise.resolve({}));
    await new Targets(client).start();
    expect(sent).toEqual([
      {
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: [{ type: "shared_worker", exclude: false }],
        },
        sessionId: undefined,
      },
    ]);
  });

  it("instruments a page's worker, resumes it, and routes its events", async () => {
    const { client, sent, emit } = fakeClient(() => Promise.resolve({}));
    const targets = new Targets(client);
    const seen: CdpEvent[] = [];
    targets.watch("ctx", (e) => seen.push(e));
    await targets.adoptPage("page", "ctx");
    expect(methodsFor(sent, "page")).toEqual(["Target.setAutoAttach"]);

    emit(attached("page", "worker", "worker"));
    expect(methodsFor(sent, "worker")).toEqual([
      "Network.enable",
      "Runtime.enable",
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);

    const fromWorker = {
      method: "Network.requestWillBeSent",
      sessionId: "worker",
      params: {},
    };
    const fromPage = {
      method: "Network.requestWillBeSent",
      sessionId: "page",
      params: {},
    };
    const stranger = {
      method: "Network.requestWillBeSent",
      sessionId: "other",
      params: {},
    };
    emit(fromWorker);
    emit(fromPage);
    emit(stranger);
    expect(seen).toEqual([fromWorker, fromPage]);
  });

  it("resumes even when a paused target never answers the enables", () => {
    // A paused service worker does not answer Network.enable until it runs;
    // awaiting the enables first deadlocked (measured). The resume must already
    // be on the wire by the time `dispatch` returns.
    const { client, sent, emit } = fakeClient((s) =>
      s.method === "Runtime.runIfWaitingForDebugger"
        ? Promise.resolve({})
        : new Promise(() => undefined),
    );
    const targets = new Targets(client);
    targets.watch("ctx", () => undefined);
    void targets.adoptPage("page", "ctx");
    emit(attached("page", "sw", "service_worker"));
    expect(methodsFor(sent, "sw")).toContain("Runtime.runIfWaitingForDebugger");
  });

  it("routes a browser-level shared worker by its own context", () => {
    const { client, sent, emit } = fakeClient(() => Promise.resolve({}));
    const targets = new Targets(client);
    const seen: CdpEvent[] = [];
    targets.watch("ctx", (e) => seen.push(e));
    emit(attached(undefined, "shared", "shared_worker", "ctx"));
    expect(methodsFor(sent, "shared")).toContain("Network.enable");
    emit({
      method: "Runtime.exceptionThrown",
      sessionId: "shared",
      params: {},
    });
    expect(seen).toHaveLength(1);
  });

  it("only resumes what it does not watch, and ignores the pages it attaches itself", () => {
    const { client, sent, emit } = fakeClient(() => Promise.resolve({}));
    const targets = new Targets(client);
    targets.watch("ctx", () => undefined);
    emit(attached(undefined, "elsewhere", "shared_worker", "other-ctx"));
    expect(methodsFor(sent, "elsewhere")).toEqual([
      "Runtime.runIfWaitingForDebugger",
    ]);
    emit(attached(undefined, "own-page", "page", "ctx"));
    expect(methodsFor(sent, "own-page")).toEqual([]);
  });

  it("stops routing a context once unwatched, and a detached session at once", async () => {
    const { client, emit } = fakeClient(() => Promise.resolve({}));
    const targets = new Targets(client);
    const seen: CdpEvent[] = [];
    const unwatch = targets.watch("ctx", (e) => seen.push(e));
    await targets.adoptPage("page", "ctx");
    emit(attached("page", "worker", "worker"));
    emit({
      method: "Target.detachedFromTarget",
      sessionId: "page",
      params: { sessionId: "worker" },
    });
    emit({ method: "Network.loadingFailed", sessionId: "worker", params: {} });
    expect(seen).toEqual([]);

    unwatch();
    emit({ method: "Network.loadingFailed", sessionId: "page", params: {} });
    expect(seen).toEqual([]);
  });
});
