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
    // A sidebar when there is width for one, a strip under the track when there is
    // not. The border follows the edge it is actually on, so the panel never looks
    // detached from the canvas it belongs to.
    <aside
      aria-label="Telemetry"
      className="flex shrink-0 flex-row flex-wrap items-start gap-x-5 gap-y-3 border-t border-line bg-panel p-3 md:w-56 md:flex-col md:flex-nowrap md:gap-4 md:border-l md:border-t-0 md:p-4"
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
      {/* `w-full` so the trace takes its own row once the readout has wrapped: it is
          the one element here that reads by its width rather than its digits. */}
      <div className="w-full">
        <SpeedTrace
          car={replay.cars[0]}
          clock={clock}
          duration={replay.meta.duration}
        />
      </div>
    </aside>
  );
}

function CarReadout({ car, snapshot }: { car: Car; snapshot: CarSnapshot }) {
  return (
    <dl className="m-0 flex flex-1 flex-row flex-wrap items-center gap-x-5 gap-y-3 md:flex-col md:flex-nowrap md:items-stretch md:gap-3">
      {/* The unit lives INSIDE the `<dd>`. A `<dl>` may only contain `dt`/`dd` groups
          and wrapper `<div>`s, and a wrapper may only hold `dt`/`dd` — a loose
          `<span>` made this an invalid definition list (Lighthouse `definition-list`,
          Slice 7). It also reads better: the value is "192 km/h", not "192". */}
      <div className="flex items-baseline gap-2">
        <dt className="sr-only">Speed</dt>
        <dd className="m-0 flex items-baseline gap-2 font-mono text-5xl font-bold leading-none tabular-nums tracking-tighter text-txt">
          {formatSpeed(snapshot.speed)}
          <span className="text-xs font-normal tracking-normal text-dim">
            km/h
          </span>
        </dd>
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
    // A bar needs width to mean anything, so it claims a minimum and grows into what
    // is left. In the stacked sidebar `md:w-full` puts it back to full width.
    <div className="min-w-[6rem] flex-1 md:w-full md:flex-none">
      <dt className="mb-1 font-mono text-[10px] uppercase tracking-widest text-dim">
        {label}
      </dt>
      {/* `role="meter"` sits on an inner element, not on the `<dd>`. Overriding a
          `<dd>`'s role makes it stop counting as a `<dd>`, which is invalid ARIA on
          that element AND breaks the enclosing `<dl>` (Lighthouse `aria-allowed-role`
          + `definition-list`, Slice 7). The `<dd>` stays a `<dd>`; the bar inside it
          is the meter. */}
      <dd className="m-0">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-line"
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
        </div>
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
