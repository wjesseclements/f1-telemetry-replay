/**
 * Colour tests — the thermal ramp, and the two resolutions the wakes sample it at.
 *
 * The stop values are the contract with the prototype's look; asserting them exactly
 * is the point. Midpoints are hand-computed from the two bracketing stops.
 *
 * Since Slice 9c the bucketing is parameterised by a count, so the bucketing suites run
 * over BOTH resolutions rather than over the trail's — see `RESOLUTIONS`.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import {
  BUCKET_MAX_KMH,
  BUCKET_MIN_KMH,
  COMET_BUCKETS,
  SPEED_BUCKETS,
  THERMAL,
  bucketColor,
  bucketOf,
  speedColor,
  speedRgb,
  thermalGradientCss,
  thermalRangeKmh,
} from "./color";

describe("THERMAL", () => {
  it("is the prototype's five-stop ramp, cold to hot", () => {
    expect(THERMAL.map((s) => s.kmh)).toEqual([80, 150, 220, 280, 340]);
    expect(THERMAL.map((s) => s.rgb)).toEqual([
      [30, 80, 255],
      [24, 195, 255],
      [43, 224, 138],
      [244, 224, 77],
      [255, 86, 48],
    ]);
  });

  it("is strictly ascending in kmh, which speedRgb's bracket search assumes", () => {
    for (let i = 1; i < THERMAL.length; i++) {
      expect(THERMAL[i].kmh).toBeGreaterThan(THERMAL[i - 1].kmh);
    }
  });
});

describe("speedRgb", () => {
  it("returns each stop's colour exactly at that stop", () => {
    for (const stop of THERMAL) {
      expect(speedRgb(stop.kmh), `stop ${stop.kmh}`).toEqual(stop.rgb);
    }
  });

  it("lerps halfway between two stops", () => {
    // 115 km/h is halfway from 80 -> 150, so [30,80,255] -> [24,195,255].
    expect(speedRgb(115)).toEqual([27, 138, 255]);
    // 310 km/h is halfway from 280 -> 340: [244,224,77] -> [255,86,48].
    expect(speedRgb(310)).toEqual([250, 155, 63]);
  });

  it("lerps at an arbitrary fraction within a stop pair", () => {
    // 185 is halfway from 150 -> 220; 167.5 is a quarter of the way.
    const [r, g, b] = speedRgb(167.5);
    expect(r).toBe(Math.round(24 + (43 - 24) * 0.25));
    expect(g).toBe(Math.round(195 + (224 - 195) * 0.25));
    expect(b).toBe(Math.round(255 + (138 - 255) * 0.25));
  });

  it("clamps below the coldest stop and at or above the hottest", () => {
    expect(speedRgb(0)).toEqual([30, 80, 255]);
    expect(speedRgb(79.9)).toEqual([30, 80, 255]);
    expect(speedRgb(-50)).toEqual([30, 80, 255]);
    expect(speedRgb(340)).toEqual([255, 86, 48]);
    expect(speedRgb(400)).toEqual([255, 86, 48]);
  });

  it("paints a NaN reading cold rather than emitting NaN channels", () => {
    const rgb = speedRgb(NaN);
    expect(rgb).toEqual([30, 80, 255]);
    expect(rgb.every(Number.isFinite)).toBe(true);
  });

  it("returns whole numbers in 0-255 across the fixture's speed range", () => {
    const speeds = parseReplay(sampleLap).cars[0].samples.map((s) => s.speed);
    expect(Math.min(...speeds)).toBe(157);
    expect(Math.max(...speeds)).toBe(338);
    for (const v of speeds) {
      for (const channel of speedRgb(v)) {
        expect(Number.isInteger(channel), `channel for ${v}`).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it("is monotonic in red across the top of the ramp — faster reads hotter", () => {
    for (let v = 280; v < 340; v += 5) {
      expect(speedRgb(v + 5)[0], `red at ${v + 5}`).toBeGreaterThanOrEqual(
        speedRgb(v)[0],
      );
    }
  });
});

describe("speedColor", () => {
  it("formats the ramp as a canvas/CSS rgb() string", () => {
    expect(speedColor(80)).toBe("rgb(30,80,255)");
    expect(speedColor(340)).toBe("rgb(255,86,48)");
    expect(speedColor(115)).toBe("rgb(27,138,255)");
  });
});

/**
 * Both resolutions, run through the same assertions.
 *
 * The trail samples the ramp at `SPEED_BUCKETS` and the comet at `COMET_BUCKETS`
 * (Slice 9c), and the one failure mode worth designing against is two palettes that can
 * drift apart. Parameterising the tests by the count is the executable form of "one
 * definition of speed→colour": if a resolution ever stopped being the same ramp, it
 * would fail here rather than look slightly wrong on a canvas nobody is diffing.
 */
const RESOLUTIONS: readonly [string, number][] = [
  ["SPEED_BUCKETS (trail)", SPEED_BUCKETS],
  ["COMET_BUCKETS (comet)", COMET_BUCKETS],
];

describe.each(RESOLUTIONS)("bucketOf at %s", (_label, buckets) => {
  it("clamps below and above the bucket domain", () => {
    expect(bucketOf(BUCKET_MIN_KMH - 100, buckets)).toBe(0);
    expect(bucketOf(BUCKET_MIN_KMH, buckets)).toBe(0);
    expect(bucketOf(BUCKET_MAX_KMH, buckets)).toBe(buckets - 1);
    expect(bucketOf(BUCKET_MAX_KMH + 100, buckets)).toBe(buckets - 1);
  });

  it("partitions the domain into contiguous, non-decreasing buckets", () => {
    const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / buckets;
    let previous = 0;
    for (let b = 0; b < buckets; b++) {
      const mid = BUCKET_MIN_KMH + (b + 0.5) * width;
      expect(bucketOf(mid, buckets), `midpoint of bucket ${b}`).toBe(b);
      expect(bucketOf(mid, buckets)).toBeGreaterThanOrEqual(previous);
      previous = bucketOf(mid, buckets);
    }
  });

  it("steps up exactly at a bucket boundary", () => {
    const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / buckets;
    const boundary = BUCKET_MIN_KMH + width * 3;
    expect(bucketOf(boundary - 0.001, buckets)).toBe(2);
    expect(bucketOf(boundary, buckets)).toBe(3);
  });

  it("returns a valid index for every fixture speed", () => {
    for (const s of parseReplay(sampleLap).cars[0].samples) {
      const b = bucketOf(s.speed, buckets);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(buckets);
    }
  });
});

describe.each(RESOLUTIONS)("bucketColor at %s", (_label, buckets) => {
  it("is the ramp colour at the bucket's midpoint", () => {
    const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / buckets;
    for (let b = 0; b < buckets; b++) {
      expect(bucketColor(b, buckets), `bucket ${b}`).toBe(
        speedColor(BUCKET_MIN_KMH + (b + 0.5) * width),
      );
    }
  });

  it("gives every bucket a distinct colour — the wake reads as a gradient", () => {
    const colors = new Set(
      Array.from({ length: buckets }, (_, b) => bucketColor(b, buckets)),
    );
    expect(colors.size).toBe(buckets);
  });
});

describe("the two resolutions are one ramp, not two palettes", () => {
  it("is finer, not different: every comet colour is a THERMAL colour", () => {
    // The comet's colours must be points ON the ramp the trail samples, not a second
    // set of stops. Both come from `speedColor`, so this holds by construction — and
    // asserting it is what would catch anyone reintroducing a hard-coded table.
    for (let b = 0; b < COMET_BUCKETS; b++) {
      const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / COMET_BUCKETS;
      const mid = BUCKET_MIN_KMH + (b + 0.5) * width;
      expect(bucketColor(b, COMET_BUCKETS)).toBe(speedColor(mid));
    }
  });

  it("agrees with the trail everywhere, to half a band each side", () => {
    // The strong form of "no drift": at any speed the two resolutions land on nearby
    // points of the SAME ramp. Both midpoints are within half their own band of the
    // speed itself, so they cannot be further apart than half of each — that sum is
    // the exact bound, not a tolerance chosen to pass. A palette that diverged would
    // break it immediately.
    const coarseWidth = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / SPEED_BUCKETS;
    const fineWidth = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / COMET_BUCKETS;
    for (let kmh = BUCKET_MIN_KMH; kmh <= BUCKET_MAX_KMH; kmh += 2.5) {
      const fineMid = midpointOf(bucketOf(kmh, COMET_BUCKETS), COMET_BUCKETS);
      const coarseMid = midpointOf(bucketOf(kmh, SPEED_BUCKETS), SPEED_BUCKETS);
      expect(
        Math.abs(fineMid - coarseMid),
        `at ${kmh} km/h`,
      ).toBeLessThanOrEqual((coarseWidth + fineWidth) / 2);
    }
  });

  it("covers the same domain at both resolutions", () => {
    expect(bucketOf(BUCKET_MIN_KMH, SPEED_BUCKETS)).toBe(0);
    expect(bucketOf(BUCKET_MIN_KMH, COMET_BUCKETS)).toBe(0);
    expect(bucketColor(0, SPEED_BUCKETS)).not.toBe(
      bucketColor(0, COMET_BUCKETS),
    );
    // …but both are the ramp's cold end, not two different colds.
    expect(speedRgb(BUCKET_MIN_KMH)).toEqual(THERMAL[0].rgb);
  });
});

/** The speed at the centre of bucket `b` of `buckets` — the colour it is stroked in. */
function midpointOf(b: number, buckets: number): number {
  const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / buckets;
  return BUCKET_MIN_KMH + (b + 0.5) * width;
}

describe("thermalRangeKmh", () => {
  it("is the span of the ramp, read from the stops", () => {
    expect(thermalRangeKmh()).toEqual([
      THERMAL[0].kmh,
      THERMAL[THERMAL.length - 1].kmh,
    ]);
  });
});

describe("thermalGradientCss", () => {
  const css = thermalGradientCss();

  it("carries every THERMAL stop, in order, with no re-typed hex", () => {
    // Built from the stops themselves: retuning THERMAL retunes the legend, which
    // is the whole reason this is generated rather than written out in CSS.
    const colors = [...css.matchAll(/rgb\(\d+,\d+,\d+\)/g)].map((m) => m[0]);
    expect(colors).toEqual(
      THERMAL.map((s) => `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})`),
    );
    expect(css).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("spans 0% to 100% left to right", () => {
    expect(css.startsWith("linear-gradient(90deg, ")).toBe(true);
    expect(css).toContain(`rgb(${THERMAL[0].rgb.join(",")}) 0%`);
    expect(css).toMatch(/100%\)$/);
  });

  it("positions stops by speed, not evenly by index", () => {
    const pcts = [...css.matchAll(/ ([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(pcts).toHaveLength(THERMAL.length);
    expect(pcts[0]).toBe(0);
    expect(pcts[pcts.length - 1]).toBe(100);

    const [coldest, hottest] = thermalRangeKmh();
    THERMAL.forEach((stop, i) => {
      const want = ((stop.kmh - coldest) / (hottest - coldest)) * 100;
      expect(pcts[i], `stop ${stop.kmh}`).toBeCloseTo(want, 1);
    });

    // The ramp is deliberately non-uniform, so an evenly-spread gradient — the
    // thing you get by ignoring `kmh` — must not pass.
    const even = THERMAL.map((_, i) => (i / (THERMAL.length - 1)) * 100);
    expect(pcts).not.toEqual(even);
  });

  it("stays monotonically ascending", () => {
    const pcts = [...css.matchAll(/ ([\d.]+)%/g)].map((m) => Number(m[1]));
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThan(pcts[i - 1]);
    }
  });
});
