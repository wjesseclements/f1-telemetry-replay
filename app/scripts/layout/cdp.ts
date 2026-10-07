/**
 * cdp.ts — the smallest Chrome DevTools Protocol client that does the job.
 *
 * One WebSocket to the BROWSER endpoint, with pages driven through flattened
 * sessions (`Target.attachToTarget({ flatten: true })`), so there is exactly one
 * socket to open and one to close. Node's built-in `WebSocket` (Node >= 22), no
 * dependency: the layout check is meant to cost the repo nothing it does not
 * already have.
 *
 * Every command carries its own timeout. That is the point of the file, not a
 * detail of it: the headless runs that preceded this instrument hung until a tool
 * timeout killed them, and a hang tells you nothing. A command that does not answer
 * here rejects with its method name, which the caller turns into a FAIL that says
 * which step stalled.
 */

/** A CDP event, with the session it belongs to (absent for browser-level ones). */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Default per-command budget. Generous: no command used here takes 1 s. */
export const COMMAND_TIMEOUT_MS = 10_000;

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closedReason: string | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (message) => {
      this.dispatch(String(message.data));
    });
    socket.addEventListener("close", () => {
      this.failAll("the DevTools socket closed");
    });
    socket.addEventListener("error", () => {
      this.failAll("the DevTools socket errored");
    });
  }

  /** Open the socket, or reject within `timeoutMs` saying why. */
  static connect(url: string, timeoutMs: number): Promise<CdpClient> {
    if (typeof WebSocket === "undefined") {
      return Promise.reject(
        new Error(
          `this Node (${process.version}) has no global WebSocket; the layout check needs Node >= 22`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(
          new Error(`DevTools socket did not open within ${timeoutMs} ms`),
        );
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`could not open the DevTools socket at ${url}`));
      });
    });
  }

  /**
   * Send one command and resolve with its result.
   *
   * The result type is the caller's assertion about the protocol, not something
   * checked here — CDP is a stable, versioned contract and every call site names
   * the handful of fields it reads.
   */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number = COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closedReason !== null) {
      return Promise.reject(
        new Error(`${method}: not sent, ${this.closedReason}`),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Subscribe to every event; returns the unsubscribe. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.failAll("the client was closed");
    try {
      this.socket.close();
    } catch {
      // Already closing or closed: nothing left to release.
    }
  }

  private dispatch(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return; // timed out already
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new Error(`${pending.method}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined) {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId,
      };
      for (const listener of this.listeners) listener(event);
    }
  }

  private failAll(reason: string): void {
    if (this.closedReason === null) this.closedReason = reason;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${pending.method}: ${reason}`));
      this.pending.delete(id);
    }
  }
}

/** The result shape of `Runtime.evaluate` / `Runtime.callFunctionOn`. */
interface EvaluateResult {
  result: { value?: unknown; description?: string };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

/** One page, addressed through its flattened session on the browser socket. */
export class CdpPage {
  constructor(
    private readonly client: CdpClient,
    readonly sessionId: string,
  ) {}

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /**
   * Run `fn(arg)` in the page and return its (JSON-serialisable) result.
   *
   * `fn` is shipped as its own source text, so it must be SELF-CONTAINED: it may
   * use DOM globals and its argument, and nothing from this module's scope. That
   * constraint is what lets the in-page probes be ordinary typed TypeScript
   * functions instead of strings nobody typechecks.
   */
  async evaluate<A, R>(
    fn: (arg: A) => R | Promise<R>,
    arg: A,
    timeoutMs?: number,
  ): Promise<R> {
    const response = await this.send<EvaluateResult>(
      "Runtime.evaluate",
      {
        expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
    );
    if (response.exceptionDetails !== undefined) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text;
      throw new Error(`in-page script threw: ${detail}`);
    }
    return response.result.value as R;
  }
}
