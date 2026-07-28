import { TrackCanvas } from "./render/TrackCanvas";
import { useTransport } from "./store/transport";

export default function App() {
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
      <div className="min-h-0 flex-1">
        {/* Slice 4b renders an error/empty state here when loading fails. */}
        {replay !== null && <TrackCanvas replay={replay} />}
      </div>
    </main>
  );
}
