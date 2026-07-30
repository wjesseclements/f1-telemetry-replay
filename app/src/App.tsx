import { Hud } from "./components/Hud";
import { ReplayError } from "./components/ReplayError";
import { ReplayFilePicker } from "./components/ReplayFilePicker";
import { SpeedLegend } from "./components/SpeedLegend";
import { TransportBar } from "./components/TransportBar";
import { useTransportKeys } from "./keyboard/useTransportKeys";
import { TrackCanvas } from "./render/TrackCanvas";
import { useTransport } from "./store/transport";

export interface AppProps {
  /**
   * A bootstrap load failure, or `null`. A prop rather than store state: the
   * transport store holds discrete transport state and nothing else, and this is
   * decided once before the first render and never changes.
   */
  bootstrapError?: string | null;
}

export default function App({ bootstrapError = null }: AppProps) {
  // A discrete value: it changes when a replay is loaded, not per frame.
  const replay = useTransport((s) => s.replay);

  // App itself subscribes to NOTHING per-frame. `Hud` and `TransportBar` own their own
  // telemetry subscriptions, which is what keeps their 30 Hz re-renders away from
  // `TrackCanvas` — a subscription up here would re-render the canvas with them.
  useTransportKeys(replay);

  return (
    // `h-dvh`, not `h-screen`: `100vh` on mobile browsers is the viewport WITHOUT the
    // retracting address bar, so the transport bar sat under it until you scrolled.
    <main className="flex h-dvh flex-col bg-bg text-txt">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-2 px-4 py-3">
        <h1 className="font-mono text-sm font-bold tracking-[0.2em]">
          TELEMETRY REPLAY
        </h1>
        {replay !== null && (
          <p className="font-mono text-xs text-dim">
            {replay.meta.event} · {replay.meta.session} ·{" "}
            {replay.cars.map((car) => car.driver).join(" ")}
          </p>
        )}
        {/* The way a real lap from the pipeline gets in. The committed fixture stays
            the default, so the app still boots with zero network. */}
        <ReplayFilePicker />
      </header>

      {bootstrapError !== null ? (
        <div className="min-h-0 flex-1">
          <ReplayError message={bootstrapError} />
        </div>
      ) : replay !== null ? (
        <>
          {/* The track and the numbers sit side by side when there is width for it
              and stack when there is not. `min-h-0`/`min-w-0` on the canvas cell in
              BOTH directions: a flex item defaults to its content's minimum size, and
              the canvas would otherwise refuse to shrink and push the HUD off screen. */}
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="relative min-h-0 min-w-0 flex-1">
              <TrackCanvas replay={replay} />
              <SpeedLegend />
            </div>
            <Hud replay={replay} />
          </div>
          <TransportBar replay={replay} />
        </>
      ) : (
        // Defensive: `main.tsx` sets either a replay or a bootstrap error before the
        // first render, so this is the state that should not happen. It still says
        // what to do rather than just what is missing.
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p className="max-w-sm text-center font-mono text-xs leading-relaxed text-dim">
            No replay loaded. Open a lap with{" "}
            <span className="text-txt">Load replay JSON</span> above — any file
            the pipeline built.
          </p>
        </div>
      )}
    </main>
  );
}
