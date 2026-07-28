import { ReplayError } from "./components/ReplayError";
import { SpeedLegend } from "./components/SpeedLegend";
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
      </header>
      <div className="relative min-h-0 flex-1">
        {bootstrapError !== null ? (
          <ReplayError message={bootstrapError} />
        ) : replay !== null ? (
          <>
            <TrackCanvas replay={replay} />
            <SpeedLegend />
          </>
        ) : (
          <p className="flex h-full items-center justify-center font-mono text-xs text-dim">
            No replay loaded.
          </p>
        )}
      </div>
    </main>
  );
}
