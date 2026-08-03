/**
 * trail.ts — the speed-painted trail, and the reason it costs nothing per frame.
 *
 * The trail is the signature of the app and the first thing here with real per-frame
 * allocation pressure. The obvious implementation (the prototype's, at
 * `TelemetryReplay.jsx:355`) rebuilds `SPEED_BUCKETS` `Path2D`s every frame and walks
 * every covered sample into them — hundreds of `moveTo`/`lineTo` calls and nine fresh
 * objects, sixty times a second, growing with lap length and car count.
 *
 * This does it once. Segment k's colour bucket never changes (it comes from a fixed
 * sample speed) and neither do its screen coordinates (until the viewport resizes), so
 * the batched paths are RETAINED and only ever appended to:
 *
 *   - the clock moves forward a sample  → append 1 segment
 *   - the clock does not cross a sample → append nothing (the common case at 60fps
 *     on a 10 Hz grid: five frames in six do no work at all)
 *   - the clock goes backwards          → rebuild, which is the only allocation
 *
 * Drawing is then `SPEED_BUCKETS` `stroke(path)` calls regardless of how much of the
 * lap is covered. Rule 2 holds: one painter per car, no branching on how many.
 *
 * TWO PAINTERS, ONE GEOMETRY
 * --------------------------
 * `TrailPainter` is the full thermal trail and belongs to the FOCUSED car alone — a
 * decision made in Slice 4b, because twenty full-lap speed trails on near-identical
 * racing lines is visual mud and the thermal ramp stops encoding anything legible.
 * Every other car gets `TailPainter`: a short wake in the car's team colour.
 *
 * They share the same screen-space coordinates (`paths.ts` projects each car's path
 * once and hands the same `Float64Array` to both), and which one a car gets is a
 * per-car PROPERTY, never a count branch. A one-car replay has one focused car, one
 * trail, and no tails to draw.
 */
import { SPEED_BUCKETS, bucketColor } from "../engine/color";

/** Bucket colours, resolved once at module load — never per frame, never per car. */
const BUCKET_COLORS: readonly string[] = Array.from(
  { length: SPEED_BUCKETS },
  (_, b) => bucketColor(b),
);

/** Stroke width of the trail, in CSS pixels. */
export const TRAIL_WIDTH = 5;

const freshPaths = (): Path2D[] =>
  Array.from({ length: SPEED_BUCKETS }, () => new Path2D());

/**
 * Retained, incrementally-built trail for ONE car at ONE viewport size.
 *
 * Owns screen-space coordinates because it is the only thing that needs them per
 * frame; `paths.ts` builds it at measure time and throws it away on resize.
 */
export class TrailPainter {
  /** One retained path per speed bucket. Replaced only on reset. */
  private paths: Path2D[] = freshPaths();

  /**
   * How many segments have been appended — equivalently, the sample index the trail
   * currently reaches. The painter's entire mutable state is this one number, which
   * is what makes "rebuild it and it refills correctly" true rather than hopeful.
   */
  private head = 0;

  /**
   * @param screen  `[x0, y0, x1, y1, …]` in screen pixels, one pair per sample.
   *                Flat and typed so no point objects exist to be walked or boxed.
   * @param buckets `buckets[k]` is the speed bucket of the segment LEAVING sample k.
   */
  constructor(
    private readonly screen: Float64Array,
    private readonly buckets: Uint8Array,
  ) {}

  /** Segments currently drawn. Exposed for tests and for the head-segment maths. */
  get covered(): number {
    return this.head;
  }

  /**
   * Bring the trail up to `index`, the leading sample of the car's current segment.
   *
   * Forward is append-only. Backward — a lap wrap, or a seek to an earlier point —
   * is the one case that cannot be expressed by appending, because a `Path2D` has no
   * way to remove what is in it. So it rebuilds, then refills forward. That costs
   * `SPEED_BUCKETS` allocations once per lap, not once per frame.
   */
  syncTo(index: number): void {
    if (index < this.head) {
      this.paths = freshPaths();
      this.head = 0;
    }
    for (let k = this.head; k < index; k++) {
      const path = this.paths[this.buckets[k]];
      path.moveTo(this.screen[k * 2], this.screen[k * 2 + 1]);
      path.lineTo(this.screen[k * 2 + 2], this.screen[k * 2 + 3]);
    }
    this.head = index;
  }

  /** Paint the covered lap: one stroke per bucket, whatever the lap length. */
  stroke(ctx: CanvasRenderingContext2D): void {
    ctx.lineWidth = TRAIL_WIDTH;
    for (let b = 0; b < SPEED_BUCKETS; b++) {
      ctx.strokeStyle = BUCKET_COLORS[b];
      ctx.stroke(this.paths[b]);
    }
  }

  /**
   * Paint the partial segment between the last whole sample and the car itself.
   *
   * Without it the trail ends at sample `index` while the car is up to one grid step
   * ahead — 0.1 s, about 9 m at 340 km/h — so the trail visibly detaches from the car
   * on every straight. It is drawn separately rather than appended because it changes
   * every frame; appending it would smear a fan of stale stubs into the retained path.
   */
  strokeHead(
    ctx: CanvasRenderingContext2D,
    index: number,
    toX: number,
    toY: number,
  ): void {
    ctx.lineWidth = TRAIL_WIDTH;
    ctx.strokeStyle = BUCKET_COLORS[this.buckets[index]];
    ctx.beginPath();
    ctx.moveTo(this.screen[index * 2], this.screen[index * 2 + 1]);
    ctx.lineTo(toX, toY);
    ctx.stroke();
  }
}

/** How much of the recent past an unfocused car's tail shows, in seconds. */
export const TAIL_SECONDS = 1.5;
/** Stroke width of a tail, in CSS pixels — thinner than the focused car's trail. */
export const TAIL_WIDTH = 3.5;
/** How many alpha steps the fade is quantised into. See `TailPainter`. */
export const TAIL_BANDS = 4;
const TAIL_MIN_ALPHA = 0.12;
const TAIL_MAX_ALPHA = 0.8;

/** Alpha of band `b`, oldest (0) to newest. Precomputed: nine values, never per frame. */
const BAND_ALPHA: readonly number[] = Array.from(
  { length: TAIL_BANDS },
  (_, b) =>
    TAIL_MIN_ALPHA +
    ((TAIL_MAX_ALPHA - TAIL_MIN_ALPHA) * b) / Math.max(1, TAIL_BANDS - 1),
);

/**
 * A short fading wake behind ONE unfocused car, at ONE viewport size.
 *
 * Unlike `TrailPainter` this is rebuilt every frame, and it has to be: a tail's BACK
 * end moves forward with its front, and a retained `Path2D` cannot have segments
 * removed from it. What makes that affordable is that the rebuild is bounded — the
 * last `TAIL_SECONDS` of travel, never the whole window — so its cost is a constant
 * per car and does not grow with a three-lap replay the way the trail's would.
 *
 * The fade is quantised into `TAIL_BANDS` alpha steps rather than drawn per segment,
 * mirroring the way the trail quantises speed into buckets. That fixes the stroke
 * count at `cars × TAIL_BANDS` per frame instead of `cars × segments`, which is the
 * difference between 80 strokes and 380 at twenty cars.
 */
export class TailPainter {
  /**
   * @param screen  the same flat `[x0, y0, x1, y1, …]` the car's `TrailPainter` uses.
   * @param length  how many segments the tail spans — `TAIL_SECONDS × sampleRateHz`,
   *                so the tail is a duration rather than a sample count and looks the
   *                same at any grid rate.
   */
  constructor(
    private readonly screen: Float64Array,
    private readonly length: number,
  ) {}

  /**
   * Paint the wake ending at the car's current position.
   *
   * Clamped at sample 0 rather than wrapping round the end of the data: the trail
   * resets at the line (Slice 4b's covered-portion semantics) and a tail that reached
   * backwards across the loop point would be the only thing on the canvas claiming
   * the replay is continuous there.
   */
  stroke(
    ctx: CanvasRenderingContext2D,
    index: number,
    toX: number,
    toY: number,
    color: string,
  ): void {
    const start = Math.max(0, index - this.length);
    const span = index - start;

    ctx.lineWidth = TAIL_WIDTH;
    ctx.strokeStyle = color;

    for (let b = 0; b < TAIL_BANDS; b++) {
      const from = start + Math.round((span * b) / TAIL_BANDS);
      const to = start + Math.round((span * (b + 1)) / TAIL_BANDS);
      const isNewest = b === TAIL_BANDS - 1;
      // An empty band has nothing to draw — except the newest one, which always
      // carries the segment between the last sample and the car itself.
      if (from === to && !isNewest) continue;

      ctx.globalAlpha = BAND_ALPHA[b];
      ctx.beginPath();
      ctx.moveTo(this.screen[from * 2], this.screen[from * 2 + 1]);
      // Bands share their boundary sample, so consecutive bands meet with no gap.
      for (let k = from + 1; k <= to; k++) {
        ctx.lineTo(this.screen[k * 2], this.screen[k * 2 + 1]);
      }
      if (isNewest) ctx.lineTo(toX, toY);
      ctx.stroke();
    }

    // Everything drawn after this — the chrome, the car markers — is opaque.
    ctx.globalAlpha = 1;
  }
}
