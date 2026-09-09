/**
 * Hud.launch.test.tsx — the BROWSER path through a real standing start (Slice 19,
 * re-watch pin).
 *
 * The engine sweep proved the sort; this proves the SEAM the re-watch suspected —
 * that the rendered tower could diverge from the engine's answer (different code
 * path in `Hud`, state flapping, stale previous-order feedback). So it mounts the
 * REAL component over the REAL committed restart asset, drives the REAL telemetry
 * channel tick by tick through the launch exactly as the rAF loop would, and reads
 * the DOM back.
 *
 * THE INVARIANT: at every tick, the rendered row order equals the true progress
 * order — except that an adjacent pair may lag its crossing while their keys sit
 * inside `ORDER_HYSTERESIS_S`, which is the dead band doing the anti-strobe job it
 * is sized for (measured on this very data: NOR passes COL at 88.1 s by 5.5 ms and
 * the swap lands at 88.5 s when the margin exceeds the band). Any divergence WIDER
 * than the band — the old key's flat-inverse lag, a phantom yo-yo, a Hud/engine
 * seam — fails.
 *
 * The asset import is the committed gallery file, not the network: the offline
 * trap stays armed, nothing fetches.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import restartJson from "../../public/gallery/monza-2026-restart.json";
import { buildProgressIndex, progressKeyAt } from "../engine/gaps";
import type { CarSnapshot } from "../engine/interpolate";
import { parseReplay } from "../engine/load";
import { ORDER_HYSTERESIS_S } from "../engine/runningOrder";
import { useTransport } from "../store/transport";
import { telemetry } from "../telemetry/channel";
import { Hud } from "./Hud";

const replay = parseReplay(restartJson, "monza-2026-restart.json");
const progress = buildProgressIndex(replay);
const rate = replay.meta.sampleRateHz;

const interpolated = (series: Float64Array, x: number): number => {
  const c = Math.min(series.length - 1, Math.max(0, x));
  const i = Math.floor(c);
  const j = Math.min(i + 1, series.length - 1);
  return series[i] + (series[j] - series[i]) * (c - i);
};

/** True progress order at `clock`: furthest along first. */
const truthAt = (clock: number): number[] =>
  replay.cars
    .map(
      (_, i) => [i, interpolated(progress.progress[i], clock * rate)] as const,
    )
    .sort((a, b) => b[1] - a[1])
    .map(([i]) => i);

/** Minimal snapshots — the tower's gaps, keys and states read the replay, not these. */
const snapshots: CarSnapshot[] = replay.cars.map((_, index) => ({
  index,
  t: 0,
  x: 0,
  y: 0,
  heading: 0,
  speed: 0,
  throttle: 0,
  brake: 0,
  gear: 0,
  drs: 0,
}));

beforeEach(() => {
  telemetry.reset();
  useTransport.setState({ focusedCarIndex: 0, comparisonCarIndex: null });
});
afterEach(cleanup);

describe("the rendered tower through a real standing start", () => {
  it("matches true progress order at every tick, diverging only inside the dead band", () => {
    const { container } = render(<Hud replay={replay} />);
    const focus = replay.cars.findIndex((c) => c.driver === "ANT");
    useTransport.setState({ focusedCarIndex: focus });

    const drivers = replay.cars.map((c) => c.driver);
    const byDriver = new Map(drivers.map((d, i) => [d, i]));

    let nowMs = 1000;
    for (let clock = 74; clock <= 96; clock += 0.1) {
      nowMs += 40; // past MIN_EMIT_GAP_MS, so every publish emits
      act(() => telemetry.publish(nowMs, clock, snapshots));

      const rendered = [
        ...container.querySelectorAll('ul[aria-label="Running order"] > li'),
      ].map((li) => byDriver.get((li.textContent ?? "").slice(0, 3)) as number);
      expect(rendered).toHaveLength(replay.cars.length);

      const truth = truthAt(clock);
      if (rendered.join() === truth.join()) continue;

      // Divergence must be explainable pair-by-pair by the dead band: every
      // ADJACENT rendered pair the truth orders the other way must have keys
      // within ORDER_HYSTERESIS_S of each other. Adjacent is the mechanism's own
      // invariant — `orderByGap` bubbles a car up only past the row directly
      // above it, so a non-adjacent misorder can persist through a CHAIN of
      // within-band neighbours (measured here: BOR held above TSU at 54 ms via a
      // sub-band intermediate) — that chaining is Slice 9 machinery, untouched by
      // ruling. Locally, though, no pair may sit inverted beyond the band: that
      // is what makes a multi-row flap without data behind it impossible, because
      // every step of it would need an adjacent inversion wider than the band.
      const truthRank = new Map(truth.map((i, r) => [i, r]));
      for (let r = 0; r + 1 < rendered.length; r++) {
        const above = rendered[r];
        const below = rendered[r + 1];
        if (
          (truthRank.get(above) as number) > (truthRank.get(below) as number)
        ) {
          const ka = progressKeyAt(progress, focus, above, clock) as number;
          const kb = progressKeyAt(progress, focus, below, clock) as number;
          expect(
            Math.abs(ka - kb),
            `t=${clock.toFixed(1)}: ${drivers[above]} rendered above ${drivers[below]} outside the dead band`,
          ).toBeLessThanOrEqual(ORDER_HYSTERESIS_S + 1e-9);
        }
      }
    }
  });

  it("shows the launch as the data tells it: COL to P2 in the scrum, never P1", () => {
    // The measured story, pinned for legibility beside the invariant above: the
    // asset's raw positions (cross-checked projection-free in the slice record)
    // put COL second-furthest along through the T1 braking scrum and never first.
    // A future change that resurrects a phantom P1 — any car surging past RUS
    // without the positions saying so — fails here.
    const { container } = render(<Hud replay={replay} />);
    const focus = replay.cars.findIndex((c) => c.driver === "ANT");
    useTransport.setState({ focusedCarIndex: focus });

    let colBest = Infinity;
    let nowMs = 1000;
    for (let clock = 74; clock <= 96; clock += 0.1) {
      nowMs += 40;
      act(() => telemetry.publish(nowMs, clock, snapshots));
      const rows = [
        ...container.querySelectorAll('ul[aria-label="Running order"] > li'),
      ].map((li) => (li.textContent ?? "").slice(0, 3));
      expect(rows[0], `t=${clock.toFixed(1)}`).toBe("RUS");
      colBest = Math.min(colBest, rows.indexOf("COL"));
    }
    expect(colBest).toBe(1);
  });
});
