/**
 * useTelemetry.ts — the React half of the channel.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: it is the API built for
 * exactly this shape (an external mutable source React does not own), it tears
 * correctly under concurrent rendering, and it re-reads only when the channel says so.
 *
 * Any component calling this re-renders at up to `HUD_HZ`. That is fine for the HUD and
 * the transport bar, which are small. It must never be called from a component that
 * contains `TrackCanvas` — the canvas subscribes to nothing, and a subscribing ancestor
 * would drag it back into React's render path (rule 1).
 */
import { useSyncExternalStore } from "react";
import { telemetry, type TelemetryFrame } from "./channel";

/** The latest published telemetry frame, at up to `HUD_HZ`. */
export function useTelemetry(): TelemetryFrame {
  return useSyncExternalStore(
    telemetry.subscribe,
    telemetry.getSnapshot,
    // Server snapshot: same source. The app never server-renders, but omitting it makes
    // `useSyncExternalStore` throw under any SSR-shaped test environment.
    telemetry.getSnapshot,
  );
}
