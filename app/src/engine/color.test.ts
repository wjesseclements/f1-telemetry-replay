/**
 * Colour tests — the thermal ramp and the trail's bucketing.
 *
 * The stop values are the contract with the prototype's look; asserting them exactly
 * is the point. Midpoints are hand-computed from the two bracketing stops.
 */
import { describe, it, expect } from "vitest";
import sampleLap from "./__fixtures__/sample-lap.json";
import { parseReplay } from "./load";
import {
  BUCKET_MAX_KMH,
  BUCKET_MIN_KMH,
  SPEED_BUCKETS,
  THERMAL,
  bucketColor,
  bucketOf,
  speedColor,
  speedRgb,
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

describe("bucketOf", () => {
  it("clamps below and above the bucket domain", () => {
    expect(bucketOf(BUCKET_MIN_KMH - 100)).toBe(0);
    expect(bucketOf(BUCKET_MIN_KMH)).toBe(0);
    expect(bucketOf(BUCKET_MAX_KMH)).toBe(SPEED_BUCKETS - 1);
    expect(bucketOf(BUCKET_MAX_KMH + 100)).toBe(SPEED_BUCKETS - 1);
  });

  it("partitions the domain into contiguous, non-decreasing buckets", () => {
    const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / SPEED_BUCKETS;
    let previous = 0;
    for (let b = 0; b < SPEED_BUCKETS; b++) {
      const mid = BUCKET_MIN_KMH + (b + 0.5) * width;
      expect(bucketOf(mid), `midpoint of bucket ${b}`).toBe(b);
      expect(bucketOf(mid)).toBeGreaterThanOrEqual(previous);
      previous = bucketOf(mid);
    }
  });

  it("steps up exactly at a bucket boundary", () => {
    const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / SPEED_BUCKETS;
    const boundary = BUCKET_MIN_KMH + width * 3;
    expect(bucketOf(boundary - 0.001)).toBe(2);
    expect(bucketOf(boundary)).toBe(3);
  });

  it("returns a valid index for every fixture speed", () => {
    for (const s of parseReplay(sampleLap).cars[0].samples) {
      const b = bucketOf(s.speed);
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(SPEED_BUCKETS);
    }
  });
});

describe("bucketColor", () => {
  it("is the ramp colour at the bucket's midpoint", () => {
    const width = (BUCKET_MAX_KMH - BUCKET_MIN_KMH) / SPEED_BUCKETS;
    for (let b = 0; b < SPEED_BUCKETS; b++) {
      expect(bucketColor(b), `bucket ${b}`).toBe(
        speedColor(BUCKET_MIN_KMH + (b + 0.5) * width),
      );
    }
  });

  it("gives every bucket a distinct colour — the trail actually reads as a gradient", () => {
    const colors = new Set(
      Array.from({ length: SPEED_BUCKETS }, (_, b) => bucketColor(b)),
    );
    expect(colors.size).toBe(SPEED_BUCKETS);
  });
});
