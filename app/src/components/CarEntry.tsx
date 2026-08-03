/**
 * CarEntry.tsx — one car's place in the timing tower.
 *
 * There is exactly ONE entry component, and whether it renders as the full readout or
 * as a compact row is a per-car property (`focused`), never a count branch. That is
 * what makes a one-car replay render as it always did: its single car is focused, so
 * the map produces one full readout and nothing else.
 *
 * WHY THE HEADER IS A BUTTON AND THE NUMBERS ARE NOT INSIDE IT
 * -----------------------------------------------------------
 * A `<button>`'s content model is phrasing content, and the readout is a `<dl>` — flow
 * content, invalid inside a button, and precisely the class of markup error Lighthouse
 * caught twice in Slice 7. So the button is the header (swatch, driver, team, gap) and
 * the `<dl>` is its sibling.
 *
 * It is a plain `aria-pressed` button rather than a `radio` in a `radiogroup`, and that
 * is deliberate: a radiogroup owes native arrow-key navigation in DOM order, and DOM
 * order here is the SORTED tower order. A resort landing between two keypresses would
 * silently change which car the second press selects. A button owes nothing, so
 * `useTransportKeys` stays the single definition of "the next car" — and it cycles in
 * `cars[]` order, which never moves.
 *
 * The gap digits are inside the button, so the button's accessible name changes as the
 * gap does. That is the correct trade: excluding them would leave visible text out of
 * the accessible name (WCAG 2.5.3, the `label-content-name-mismatch` Slice 7 fixed),
 * and nothing here is announced live — the HUD has no `aria-live` by design.
 *
 * WHAT THE TOWER GIVES UP FIRST, DECIDED RATHER THAN DEFAULTED
 * -----------------------------------------------------------
 * Width is the scarce resource here, and the order it is surrendered in is a decision,
 * not an accident of layout:
 *
 *  1. **The team NAME is already gone from a compact row** — it renders on the focused
 *     entry only. At the sidebar's real width (measured in a browser, not guessed) the
 *     two gap columns leave about six characters, and "Red Bull Racing" truncated to
 *     "R…" carries strictly less than the colour swatch beside it already does. This
 *     was ratified, so width work should treat it as a decision to revisit knowingly
 *     rather than a bug to fix: giving the name back means a wider sidebar, and the
 *     swatch is what identifies the team in a row.
 *  2. **`gap_m` is next**, if twenty rows get tight.
 *  3. **`gap_s` never goes.** It is the unit the one-second DRS rule and every
 *     broadcast interval are quoted in.
 */
import { carHasDrs, isDrsOpen } from "../engine/drs";
import {
  formatGapMetres,
  formatGapSeconds,
  formatGear,
  formatSpeed,
  pedalFraction,
} from "../engine/format";
import type { Gap } from "../engine/gaps";
import type { CarSnapshot } from "../engine/interpolate";
import type { Car } from "../engine/schema";
import { FOCUS_RING } from "./focus";

export interface CarEntryProps {
  car: Car;
  snapshot: CarSnapshot;
  /** The car's gap to the focused car, or `null` when the data has no answer. */
  gap: Gap | null;
  focused: boolean;
  onFocus: () => void;
}

export function CarEntry({
  car,
  snapshot,
  gap,
  focused,
  onFocus,
}: CarEntryProps) {
  return (
    <li className="m-0 w-full list-none">
      <button
        type="button"
        onClick={onFocus}
        aria-pressed={focused}
        aria-keyshortcuts="ArrowUp ArrowDown"
        className={`flex w-full items-center gap-2 rounded border px-2 py-1 text-left ${
          focused
            ? "border-line bg-panel2"
            : "border-transparent hover:border-line"
        } ${FOCUS_RING}`}
      >
        {/* The team colour, as the same mark the canvas uses for this car. */}
        <span
          aria-hidden="true"
          className="h-3.5 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: car.color }}
        />
        <span className="font-mono text-xs font-bold tracking-wider text-txt">
          {car.driver}
        </span>
        {/*
          The team NAME belongs to the focused entry, which has the width for it. In a
          compact row the two gap columns leave about six characters, and "Red Bull
          Racing" truncated to "R…" is worse than nothing — measured in the browser at
          the sidebar's real width, not guessed. What identifies the team in a row is
          the swatch above, which is the same mark the canvas paints that car with.

          Empty for a replay whose pipeline could not resolve the team; an empty string
          renders nothing, so there is no branch for that either.
        */}
        {focused ? (
          <>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-dim">
              {car.team}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
              Focus
            </span>
          </>
        ) : (
          <span className="ml-auto flex items-baseline gap-2">
            <span className="font-mono text-sm font-bold tabular-nums text-txt">
              {formatGapSeconds(gap === null ? null : gap.seconds)}
            </span>
            <span className="w-11 text-right font-mono text-[10px] tabular-nums text-dim">
              {formatGapMetres(gap === null ? null : gap.metres)}
            </span>
          </span>
        )}
      </button>

      {focused && <CarReadout car={car} snapshot={snapshot} />}
    </li>
  );
}

/** The focused car's numbers — unchanged from when there was only ever one car. */
function CarReadout({ car, snapshot }: { car: Car; snapshot: CarSnapshot }) {
  return (
    <dl className="m-0 mt-2 flex flex-1 flex-row flex-wrap items-center gap-x-5 gap-y-3 md:flex-col md:flex-nowrap md:items-stretch md:gap-3">
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
