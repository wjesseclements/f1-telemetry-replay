/**
 * Hud.tsx — the numbers.
 *
 * Subscribes to the telemetry channel, so it re-renders at up to `HUD_HZ` and never at
 * frame rate. It is a SIBLING of `TrackCanvas`: its re-renders must never reach the
 * canvas (CLAUDE.md rule 1), which is a fact about where it sits in `App`, not about
 * anything it does.
 *
 * Deliberately NO `aria-live`. These values change 30 times a second; announcing them
 * would make the page unusable with a screen reader. The readout is a labelled `<dl>` a
 * user reads on demand, and the transport controls are what get announced when acted on.
 *
 * One readout per car, by mapping `cars` (rule 2). v1 has exactly one; nothing here
 * branches on the count.
 */
import { carHasDrs, isDrsOpen } from "../engine/drs";
import { formatGear, formatSpeed, pedalFraction } from "../engine/format";
import type { Car } from "../engine/schema";
import type { CarSnapshot } from "../engine/interpolate";
import { useTelemetry } from "../telemetry/useTelemetry";
import type { Replay } from "../engine/schema";
import { SpeedTrace } from "./SpeedTrace";

export interface HudProps {
  replay: Replay;
}

export function Hud({ replay }: HudProps) {
  const { clock, cars } = useTelemetry();

  return (
    <aside
      aria-label="Telemetry"
      className="flex w-56 shrink-0 flex-col gap-4 border-l border-line bg-panel p-4"
    >
      {cars.map((snapshot, i) => (
        <CarReadout
          key={replay.cars[i].driver}
          car={replay.cars[i]}
          snapshot={snapshot}
        />
      ))}
      {/*
        The speed trace shows the focused car — currently `cars[0]` (single-car);
        Slice 9 binds this to the selection mechanism, same as the thermal trail.
      */}
      <SpeedTrace
        car={replay.cars[0]}
        clock={clock}
        duration={replay.meta.duration}
      />
    </aside>
  );
}

function CarReadout({ car, snapshot }: { car: Car; snapshot: CarSnapshot }) {
  return (
    <dl className="m-0 flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <dt className="sr-only">Speed</dt>
        <dd className="m-0 font-mono text-5xl font-bold leading-none tabular-nums tracking-tighter text-txt">
          {formatSpeed(snapshot.speed)}
        </dd>
        <span className="font-mono text-xs text-dim">km/h</span>
      </div>

      <div className="flex items-baseline gap-2">
        <dt className="font-mono text-[10px] uppercase tracking-widest text-dim">
          Gear
        </dt>
        <dd className="m-0 font-mono text-2xl font-bold leading-none tabular-nums text-txt">
          {formatGear(snapshot.gear)}
        </dd>
      </div>

      <Pedal
        label="Throttle"
        fraction={pedalFraction(snapshot.throttle)}
        tone="throttle"
      />
      {/* Brake is a 0/1 channel (schema), so it reads as fully on or fully off. */}
      <Pedal label="Brake" fraction={snapshot.brake} tone="brake" />

      {/*
        Rule 8: the indicator exists only when the DATA carries a DRS channel. No year
        branching — a 2026+ replay simply has no `drs`, and this renders nothing.
      */}
      {carHasDrs(car) && <DrsPill open={isDrsOpen(snapshot.drs)} />}
    </dl>
  );
}

function Pedal({
  label,
  fraction,
  tone,
}: {
  label: string;
  fraction: number;
  tone: "throttle" | "brake";
}) {
  const percent = Math.round(fraction * 100);
  return (
    <div>
      <dt className="mb-1 font-mono text-[10px] uppercase tracking-widest text-dim">
        {label}
      </dt>
      <dd
        className="m-0 h-1.5 w-full overflow-hidden rounded-full bg-line"
        role="meter"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${tone === "throttle" ? "bg-throttle" : "bg-brake"}`}
          style={{ width: `${percent}%` }}
        />
      </dd>
    </div>
  );
}

function DrsPill({ open }: { open: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="sr-only">DRS</dt>
      <dd
        className={`m-0 rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest ${
          open ? "border-drs text-drs" : "border-line text-dim"
        }`}
      >
        DRS {open ? "OPEN" : "CLOSED"}
      </dd>
    </div>
  );
}
