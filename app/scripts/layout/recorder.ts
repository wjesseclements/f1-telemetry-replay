/**
 * recorder.ts — what the page did that the table has to report: every request
 * it attempted off its own origin, and every uncaught exception.
 *
 * The offline rule's in-browser half. Chrome's `--host-resolver-rules` stops an
 * off-origin request reaching anything (`chrome.ts`); this makes sure the attempt
 * is SEEN. Blocked or not, an attempt is a FAIL: the app's one sanctioned network
 * peer is its own origin (CLAUDE.md, "The offline rule, and its single
 * exception"), and a request elsewhere is a defect even when the sandbox happens
 * to catch it.
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

/** How many offending URLs the measured column shows before eliding. */
const SHOWN = 3;

export class PageRecorder {
  readonly offOrigin: string[] = [];
  readonly exceptions: string[] = [];
  private readonly urlById = new Map<string, string>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly origin: string) {}

  /** Feed every CDP event of the page's session through here. */
  handle(event: CdpEvent): void {
    const p = event.params;
    switch (event.method) {
      case "Network.requestWillBeSent": {
        const url = (p.request as { url: string }).url;
        if (isOffOrigin(url, this.origin)) {
          this.offOrigin.push(url);
          this.urlById.set(p.requestId as string, url);
        }
        break;
      }
      case "Network.webSocketCreated": {
        const url = String(p.url);
        if (isOffOrigin(url, this.origin)) {
          this.offOrigin.push(url);
          this.urlById.set(p.requestId as string, url);
        }
        break;
      }
      case "Network.loadingFailed": {
        const url = this.urlById.get(p.requestId as string);
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
    const shown = this.offOrigin.slice(0, SHOWN).map((url) => {
      const why = this.failures.get(url);
      return why === undefined ? url : `${url} (${why})`;
    });
    const more =
      this.offOrigin.length > SHOWN
        ? `, +${this.offOrigin.length - SHOWN} more`
        : "";
    return `${this.offOrigin.length}: ${shown.join(", ")}${more}`;
  }
}
