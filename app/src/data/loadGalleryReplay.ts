/**
 * loadGalleryReplay.ts — the one place the app is allowed to touch the network.
 *
 * CLAUDE.md's offline rule has exactly one exception, and this file is it: fetching
 * the repo's OWN committed gallery assets from its OWN origin. Not a backend, not an
 * on-demand session fetch, not a user-supplied URL — three curated JSON files that
 * shipped in the same deploy as this code.
 *
 * Why that exception does not erode the rule: the rule exists so the app cannot
 * depend on a service that can be down, rate-limited or withdrawn, and so tests and
 * CI stay hermetic. A same-origin static asset from the same deploy has none of
 * those failure modes — if it is missing, the build is broken, which is a different
 * category of problem. The app still BOOTS on the committed fixture with zero
 * network; this runs only when a human clicks a scenario.
 *
 * The URL is not free-form. `engine/gallery.ts` validates `file` as a bare lowercase
 * filename, so a manifest entry cannot name a host, a scheme or a parent directory.
 * The narrowness is enforced in the contract, not left to review.
 *
 * Validation is NOT re-implemented here. Like `loadReplayFile.ts`, this delegates to
 * `bootstrapReplay`, so a gallery payload crosses the same `parseReplay` and gets the
 * same error shaping as the committed fixture and a picked file. One door for replay
 * data, as architecture rule 7 asks.
 */
import type { GalleryScenario } from "../engine/gallery";
import { scenarioUrl } from "../engine/gallery";
import { type BootstrapResult, bootstrapReplay } from "./bootstrap";

/**
 * Fetch, parse and validate a featured scenario's replay.
 *
 * Returns the failure rather than throwing it — the caller renders the message and
 * keeps whatever replay is already on screen. Every branch below is a degradation
 * path a visitor can actually reach, and each says what went wrong in its own terms
 * rather than collapsing into one "could not load".
 */
export async function loadGalleryReplay(
  scenario: GalleryScenario,
  base: string = import.meta.env.BASE_URL,
): Promise<BootstrapResult> {
  const url = scenarioUrl(scenario, base);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    // Offline, DNS, connection reset. The one failure the visitor might fix by
    // trying again, so it is the one that says so.
    return {
      replay: null,
      error: `Could not reach ${url}: ${messageOf(err)}\nCheck your connection and try again, or load a file with "Load replay JSON".`,
    };
  }

  if (!response.ok) {
    // A deployed asset that 404s is a broken BUILD, not a broken visitor. Say the
    // status so the report is actionable to whoever has to fix it.
    return {
      replay: null,
      error: `${url} returned ${response.status} ${response.statusText}.\nThis featured replay is missing from the deployment.`,
    };
  }

  // A MISSING asset usually does not 404. Measured against `vite preview` — and
  // true of any SPA host, Vercel included — a request for an absent path returns
  // the index document: **200, `text/html`**. So the check above never fires for
  // the failure it was written for, and without this the visitor gets
  // "not valid JSON: Unexpected token '<'" for a file that simply is not there.
  //
  // Found in the browser, not in jsdom, because it is a property of the SERVER.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return {
      replay: null,
      error: `${url} did not return JSON (got ${contentType || "no content-type"}).\nThis featured replay is missing from the deployment.`,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    // A connection dropped mid-body: the request succeeded, the payload did not.
    return {
      replay: null,
      error: `Could not read ${url}: ${messageOf(err)}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // A truncated or half-deployed file is a SYNTAX error, and saying so is more
    // use than the several hundred schema violations it would otherwise produce —
    // the same distinction `loadReplayFile` and the pipeline's CLI validator draw.
    return {
      replay: null,
      error: `${scenario.file} is not valid JSON.\n${messageOf(err)}`,
    };
  }

  return bootstrapReplay(json, scenario.file);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
