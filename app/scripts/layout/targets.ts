/**
 * targets.ts — every session a page's requests can come from, attached and routed
 * to the recorder of the viewport it belongs to.
 *
 * Why this exists (Slice 22's review, measured): the recorder first listened to
 * the page's own session only, and a request made from a Worker never reached it.
 * With fetches injected into a dedicated worker, a shared worker and a service
 * worker, Chrome's net-log showed all three attempted at every viewport and the
 * "no off-origin requests" row listed none of them. A worker is its own CDP
 * target with its own session, so each one has to be attached and have
 * `Network` enabled on it.
 *
 * Two ways in, because Chrome splits them (measured on Chrome 154):
 *   - under the PAGE session, `Target.setAutoAttach` brings in dedicated workers,
 *     out-of-process iframes and the page's service worker (and, recursively,
 *     their children);
 *   - a SHARED worker belongs to no page and arrives only through the same
 *     command at the BROWSER level, so that is asked for shared workers alone —
 *     asking for service workers there too attaches each one twice.
 * Pages are never auto-attached: the check creates and attaches its own, and a
 * page the app opened itself (a popup) is outside what this sees.
 *
 * Every auto-attached target starts PAUSED (`waitForDebuggerOnStart`), so its
 * first request — the line a probe puts at the top of a worker script — cannot
 * race the `Network.enable`. Two rules follow, both measured the hard way:
 *   - the enables are SENT before the resume but not AWAITED: a paused service
 *     worker does not answer them until it runs, so awaiting first deadlocked —
 *     the worker never started and its request was never made;
 *   - every attached target is resumed, ours or not, on every path, or it hangs.
 */
import type { CdpClient, CdpEvent } from "./cdp";

/** The client surface this needs — a fake in the tests, the socket in a run. */
export type CdpLike = Pick<CdpClient, "send" | "onEvent">;

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
};

/** Browser-level auto-attach: only what no page session brings in. */
const BROWSER_LEVEL_FILTER = [{ type: "shared_worker", exclude: false }];

interface AttachedParams {
  sessionId: string;
  targetInfo: { type: string; browserContextId?: string };
}

export class Targets {
  /** browserContextId → where that context's events go. */
  private readonly sinks = new Map<string, (event: CdpEvent) => void>();
  /** sessionId → the browser context it belongs to, for every routed session. */
  private readonly contextOf = new Map<string, string>();

  constructor(private readonly cdp: CdpLike) {
    cdp.onEvent((event) => this.dispatch(event));
  }

  /** Start attaching shared workers, browser-wide. Once per run. */
  async start(): Promise<void> {
    await this.cdp.send("Target.setAutoAttach", {
      ...AUTO_ATTACH,
      filter: BROWSER_LEVEL_FILTER,
    });
  }

  /** Route every event of `browserContextId`'s sessions to `sink`, until undone. */
  watch(browserContextId: string, sink: (event: CdpEvent) => void): () => void {
    this.sinks.set(browserContextId, sink);
    return () => {
      this.sinks.delete(browserContextId);
      for (const [session, context] of this.contextOf) {
        if (context === browserContextId) this.contextOf.delete(session);
      }
    };
  }

  /**
   * A page the check attached itself: route its events, and auto-attach whatever
   * it starts. Call before navigating, so nothing the page starts is missed.
   */
  async adoptPage(sessionId: string, browserContextId: string): Promise<void> {
    this.contextOf.set(sessionId, browserContextId);
    await this.cdp.send("Target.setAutoAttach", AUTO_ATTACH, sessionId);
  }

  private dispatch(event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const child = event.params as unknown as AttachedParams;
      // The check's own `Target.attachToTarget` announces itself here too; that
      // page is `adoptPage`'s, and was never paused.
      if (child.targetInfo.type === "page") return;
      // A page-level child inherits its parent's context; a browser-level one
      // (no parent session) names its own.
      const context =
        event.sessionId === undefined
          ? child.targetInfo.browserContextId
          : this.contextOf.get(event.sessionId);
      if (context !== undefined && this.sinks.has(context)) {
        this.contextOf.set(child.sessionId, context);
        void this.adopt(child.sessionId);
      } else {
        void this.resume(child.sessionId);
      }
      return;
    }
    if (event.method === "Target.detachedFromTarget") {
      this.contextOf.delete(String(event.params.sessionId));
      return;
    }
    if (event.sessionId === undefined) return;
    const context = this.contextOf.get(event.sessionId);
    if (context !== undefined) this.sinks.get(context)?.(event);
  }

  /** Instrument a paused child, then let it run. */
  private async adopt(sessionId: string): Promise<void> {
    // Sent in order, so Chrome applies them before the resume; NOT awaited
    // before it (see the header). Each may fail on its own — a worker that
    // already exited, a target without the domain — and none may stop the resume.
    const enables = [
      this.cdp.send("Network.enable", {}, sessionId),
      this.cdp.send("Runtime.enable", {}, sessionId),
      this.cdp.send("Target.setAutoAttach", AUTO_ATTACH, sessionId),
    ];
    await Promise.allSettled([...enables, this.resume(sessionId)]);
  }

  /** Let a paused target run. Never left undone: a paused worker hangs its page. */
  private async resume(sessionId: string): Promise<void> {
    await this.cdp
      .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
      .catch(() => undefined);
  }
}
