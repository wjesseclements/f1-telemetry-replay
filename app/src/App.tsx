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
    <main className="flex h-screen flex-col bg-bg text-txt">
      <header className="flex items-baseline gap-3 px-4 py-3">
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
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <TrackCanvas replay={replay} />
              <SpeedLegend />
            </div>
            <Hud replay={replay} />
          </div>
          <TransportBar replay={replay} />
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="font-mono text-xs text-dim">No replay loaded.</p>
        </div>
      )}
    </main>
  );
}
