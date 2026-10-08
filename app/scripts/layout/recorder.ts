/**
 * recorder.ts — what the page did that the table has to report: every request
 * it, its workers or its out-of-process frames attempted off its own origin, and
 * every uncaught exception. Both are FAIL rows, per viewport.
 *
 * The offline rule's in-browser half. Chrome's `--host-resolver-rules` stops an
 * off-origin request reaching anything (`chrome.ts`); this makes sure the attempt
 * is SEEN. Blocked or not, an attempt is a FAIL: the app's one sanctioned network
 * peer is its own origin (CLAUDE.md, "The offline rule, and its single
 * exception"), and a request elsewhere is a defect even when the sandbox happens
 * to catch it.
 *
 * It sees what `targets.ts` routes to it: the page's session and every session
 * auto-attached under it. Chrome's OWN requests (component updates and the like)
 * belong to no page and never reach here; the resolver rule is what stops those.
 */
import type { CdpEvent } from "./cdp";

/**
 * Whether `url` leaves `origin`. `data:`, `blob:` and `about:` URLs never leave
 * the process. A WebSocket is compared as the HTTP origin it upgrades from, so a
 * same-origin socket is not mistaken for a foreign one.
 */
export function isOffOrigin(url: string, origin: string): boolean {
  if (/^(data|blob|about):/.test(url)) return false;
  try {
    const parsed = new URL(url.replace(/^ws(s?):/, "http$1:"));
    return parsed.origin !== origin;
  } catch {
    return true; // unparseable is not provably ours
  }
}

/** How many offending URLs / exceptions the measured column shows before eliding. */
const SHOWN = 3;

/** `a, b, c, +2 more` — the first few, then a count of the rest. */
function elide(items: string[]): string {
  const more = items.length > SHOWN ? `, +${items.length - SHOWN} more` : "";
  return `${items.length}: ${items.slice(0, SHOWN).join(", ")}${more}`;
}

export class PageRecorder {
  readonly offOrigin: string[] = [];
  readonly exceptions: string[] = [];
  /**
   * Keyed by session AND request id: a worker's request ids are its own, so two
   * sessions can reuse one, and a failure must land on the request it belongs to.
   */
  private readonly urlById = new Map<string, string>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly origin: string) {}

  /** Feed every CDP event of the page's sessions through here. */
  handle(event: CdpEvent): void {
    const p = event.params;
    const key = `${event.sessionId ?? ""}/${String(p.requestId)}`;
    switch (event.method) {
      case "Network.requestWillBeSent": {
        const url = (p.request as { url: string }).url;
        if (isOffOrigin(url, this.origin)) {
          this.offOrigin.push(url);
          this.urlById.set(key, url);
        }
        break;
      }
      case "Network.webSocketCreated": {
        const url = String(p.url);
        if (isOffOrigin(url, this.origin)) {
          this.offOrigin.push(url);
          this.urlById.set(key, url);
        }
        break;
      }
      case "Network.loadingFailed": {
        const url = this.urlById.get(key);
        if (url !== undefined) this.failures.set(url, String(p.errorText));
        break;
      }
      case "Runtime.exceptionThrown": {
        const details = p.exceptionDetails as {
          text: string;
          exception?: { description?: string };
        };
        this.exceptions.push(details.exception?.description ?? details.text);
        break;
      }
    }
  }

  /** For the measured column: the count, then the first few with how they failed. */
  summary(): string {
    if (this.offOrigin.length === 0) return `0 (origin ${this.origin})`;
    return elide(
      this.offOrigin.map((url) => {
        const why = this.failures.get(url);
        return why === undefined ? url : `${url} (${why})`;
      }),
    );
  }

  /** The count, then the first line (the message) of the first few. */
  exceptionSummary(): string {
    if (this.exceptions.length === 0) return "0";
    return elide(this.exceptions.map((text) => text.split("\n")[0]));
  }
}
