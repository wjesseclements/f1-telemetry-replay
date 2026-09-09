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
 *  2. **`gap_m` is next**, if twenty rows get tight — and Slice 15's vs pill called
 *     this in: at the sidebar's fixed `md:w-56` the pill and the metres column never
 *     both fit, so `gap_m` is `md:hidden` there (it still renders in the sub-`md`
 *     full-width strip). Enforced by flex as well as promised: `gap_m` is the compact
 *     row's one shrinkable column, so at any unanticipated width it truncates away
 *     before anything else moves. Giving it back means a wider sidebar, knowingly.
 *  3. **`gap_s` never goes.** It is the unit the one-second DRS rule and every
 *     broadcast interval are quoted in.
 *
 * The compound mark in a compact row is a DOT, not a chip, for exactly this
 * reason: a dot claims ~8px without displacing anything on the surrender list,
 * while a lettered chip would compete with `gap_m`. It conveys nothing by colour
 * alone — an sr-only compound name sits beside it inside the button, so the
 * row's accessible name says "SOFT tyres" where sighted eyes see red.
 *
 * THE COMPARE CONTROL (Slice 15)
 * ------------------------------
 * A second, sibling button — a button cannot nest in a button — on every NON-focused
 * row, toggling this car onto the focused car's speed trace. The focused row has none
 * because self-comparison is meaningless, and that absence is what makes a single-car
 * file show no compare control at all: its one row is always focused, so requirement
 * "nothing to compare" falls out of the `focused` branch that already exists, with no
 * count branch anywhere (rule 2). It is a bordered pill in the DRS pill's shape —
 * the first cut was borderless grey text and the browser pass could not find it —
 * claiming ~30px of the row's right edge, ahead of nothing on the width-surrender
 * list. Its visible text "vs" is contained in its accessible name "vs {driver}"
 * (WCAG 2.5.3, same rule as the gap digits).
 */
import type { ReactNode } from "react";
import { SWATCH_MIN_LUMINANCE, floorLuminance } from "../engine/color";
import { carHasDrs, isDrsOpen } from "../engine/drs";
import {
  GAP_DNF,
  GAP_PIT,
  formatGap,
  formatGapMetres,
  formatGear,
  formatSpeed,
  formatTyreAge,
  pedalFraction,
} from "../engine/format";
import type { Gap } from "../engine/gaps";
import type { CarSnapshot } from "../engine/interpolate";
import type { Car, Compound } from "../engine/schema";
import { compoundLetter, type TyreState } from "../engine/tyres";
import { FOCUS_RING } from "./focus";

/**
 * Compound → colour classes. Presentation, so it lives here the way DrsPill owns
 * the DRS pill's styling; the engine deals only in compound strings. Full literal
 * class names (never assembled) so Tailwind's scanner keeps them. UNKNOWN renders
 * in the dim neutral — the same achromatic "we don't know" as the pipeline's
 * fallback team colour — never a guessed compound colour.
 */
const COMPOUND_DOT: Record<Compound, string> = {
  SOFT: "bg-tyre-soft",
  MEDIUM: "bg-tyre-medium",
  HARD: "bg-tyre-hard",
  INTERMEDIATE: "bg-tyre-inter",
  WET: "bg-tyre-wet",
  UNKNOWN: "bg-dim",
};

const COMPOUND_CHIP: Record<Compound, string> = {
  SOFT: "border-tyre-soft text-tyre-soft",
  MEDIUM: "border-tyre-medium text-tyre-medium",
  HARD: "border-tyre-hard text-tyre-hard",
  INTERMEDIATE: "border-tyre-inter text-tyre-inter",
  WET: "border-tyre-wet text-tyre-wet",
  UNKNOWN: "border-line text-dim",
};

export interface CarEntryProps {
  car: Car;
  snapshot: CarSnapshot;
  /** The car's gap to the focused car, or `null` when the data has no answer. */
  gap: Gap | null;
  /** The tyre the car is on, or `null` when the data has no answer (rule 8). */
  tyre: TyreState | null;
  /**
   * Out of the race (Slice 19): the row greys, the gap column says DNF, and the tower
   * has already sorted it to the bottom. Still a working row — a retired car can be
   * focused and compared; retirement is a fact about the car, not about the controls.
   */
  retired: boolean;
  /**
   * Off the racing line (Slice 19, second re-watch's copy ruling): the gap column
   * says PIT instead of a dash — the pit lane is what off-line almost always means,
   * and the caveat for the rare off-track excursion is recorded at `GAP_PIT`.
   */
  offline: boolean;
  focused: boolean;
  /**
   * The focused car's speed trace, rendered under the readout block (Slice 19 watch,
   * ruled: the trace describes the focused car and sits with it). A node built by the
   * tower, not a subscription of this row's — only the focused row receives one, and
   * it cannot live inside the readout's `<dl>` (a `<figure>` is invalid there — the
   * Slice 7 Lighthouse class), so it renders as the dl's sibling.
   */
  trace?: ReactNode;
  /** Whether this car is the one overlaid on the speed trace. */
  compared: boolean;
  onFocus: () => void;
  /** Toggle this car on/off the speed-trace overlay. */
  onCompare: () => void;
}

export function CarEntry({
  car,
  snapshot,
  gap,
  tyre,
  retired,
  offline,
  focused,
  compared,
  onFocus,
  onCompare,
  trace,
}: CarEntryProps) {
  return (
    <li className="m-0 w-full list-none">
      {/* `gap-2`, not `gap-1`: the daylight between the row button and the vs pill is
          a hard floor — the button's content can truncate (see the gap columns) but
          can never close this gap. */}
      <div className="flex w-full items-stretch gap-2">
        <button
          type="button"
          onClick={onFocus}
          aria-pressed={focused}
          aria-keyshortcuts="ArrowUp ArrowDown"
          className={`flex min-w-0 flex-1 items-center gap-2 rounded border px-2 py-1 text-left ${
            focused
              ? "border-line bg-panel2"
              : "border-transparent hover:border-line"
            /* The broadcast retirement treatment: desaturated and dimmed, applied to
               the whole button so the swatch greys WITH the text — the row reads as
               "no longer in this fight" without hiding a single fact on it. */
          } ${retired ? "grayscale opacity-60" : ""} ${FOCUS_RING}`}
        >
          {/* The team colour, as the same mark the canvas uses for this car —
              floored to the tower's minimum luminance (Slice 17: Cadillac's
              #444444 was invisible here; bright liveries pass byte-for-byte). */}
          <span
            aria-hidden="true"
            className="h-3.5 w-1 shrink-0 rounded-full"
            style={{
              backgroundColor: floorLuminance(car.color, SWATCH_MIN_LUMINANCE),
            }}
          />
          <span className="font-mono text-xs font-bold tracking-wider text-txt">
            {car.driver}
          </span>
          {/* Rule 8 again: the dot exists only when the data carries a tyre answer.
            Inside the button, so the compound folds into the row's accessible
            name (the sr-only text is the information; the colour is a mark). */}
          {tyre && (
            <>
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${COMPOUND_DOT[tyre.compound]}`}
              />
              <span className="sr-only">{tyre.compound} tyres</span>
            </>
          )}
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
              {/* DNF/PIT on the focused row too: the state must survive focusing
                  the car, or the one row a viewer is reading loses the one fact the
                  tower is stating about it. */}
              {retired ? (
                <span className="font-mono text-sm font-bold tracking-wider text-dim">
                  {GAP_DNF}
                </span>
              ) : (
                offline && (
                  <span className="font-mono text-sm font-bold tracking-wider text-dim">
                    {GAP_PIT}
                  </span>
                )
              )}
              <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
                Focus
              </span>
            </>
          ) : retired || offline ? (
            /* The broadcast spelling, in the gap column's place: a word, not a
               number — DNF for a car out of the race, PIT for one off the racing
               line (Slice 19; copy ruled at the second re-watch). */
            <span className="ml-auto font-mono text-sm font-bold tracking-wider text-dim">
              {retired ? GAP_DNF : GAP_PIT}
            </span>
          ) : (
            /*
              The surrender order, enforced rather than promised, twice over:

               - `md:hidden` on `gap_m`: at the sidebar's fixed `md:w-56` the vs pill
                 and the metres column can NEVER both fit (measured — the leftover is
                 a "1…" stub that reads as broken data), so metres is dropped outright
                 there, per the header's list. Below `md` the tower is a full-width
                 strip with room for both, and metres comes back.
               - the flex belt: `gap_s` is `shrink-0` (it never goes) and `gap_m` is
                 the row's ONE shrinkable item (`min-w-0 shrink truncate` behind the
                 `min-w-0` chain), so at any width the maths didn't anticipate the
                 metres column gives way and nothing can overflow the button into
                 the pill.
            */
            <span className="ml-auto flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-mono text-sm font-bold tabular-nums text-txt">
                {formatGap(
                  gap === null ? null : gap.seconds,
                  gap === null ? 0 : gap.lapsDown,
                )}
              </span>
              <span className="w-11 min-w-0 shrink truncate text-right font-mono text-[10px] tabular-nums text-dim md:hidden">
                {formatGapMetres(gap === null ? null : gap.metres)}
              </span>
            </span>
          )}
        </button>
        {/* The DRS pill's shape (border always visible, state = border+text tone) —
            the browser pass found the borderless grey text unfindable. Pressed goes
            accent, the same "this one is live" tone as the Focus tag. */}
        {!focused && (
          <button
            type="button"
            onClick={onCompare}
            aria-pressed={compared}
            aria-label={`vs ${car.driver}`}
            className={`shrink-0 self-center rounded border px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-widest ${
              compared
                ? "border-accent bg-panel2 text-accent"
                : "border-line text-dim hover:border-dim hover:text-txt"
            } ${FOCUS_RING}`}
          >
            vs
          </button>
        )}
      </div>

      {focused && <CarReadout car={car} snapshot={snapshot} tyre={tyre} />}
      {/* `w-full` so the trace takes its own row in the sub-`md` strip, where the
          readout wraps horizontally; in the sidebar it fills the column. */}
      {focused && trace !== undefined && (
        <div className="mt-3 w-full">{trace}</div>
      )}
    </li>
  );
}

/** The focused car's numbers — unchanged from when there was only ever one car. */
function CarReadout({
  car,
  snapshot,
  tyre,
}: {
  car: Car;
  snapshot: CarSnapshot;
  tyre: TyreState | null;
}) {
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

      {/* Same contract as the DRS pill: rendered only when the data has a tyre
          answer for this clock. The letter is the mark; the sr-only text is the
          name; the age is omitted (not zeroed) when unknown. */}
      {tyre && <TyrePill tyre={tyre} />}
    </dl>
  );
}

function TyrePill({ tyre }: { tyre: TyreState }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="sr-only">Tyres</dt>
      <dd
        className={`m-0 rounded border px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest ${COMPOUND_CHIP[tyre.compound]}`}
      >
        <span aria-hidden="true">{compoundLetter(tyre.compound)}</span>
        <span className="sr-only">{tyre.compound}</span>
        {tyre.age !== null && (
          <span className="font-normal text-dim">
            {" "}
            · {formatTyreAge(tyre.age)}
          </span>
        )}
      </dd>
    </div>
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
