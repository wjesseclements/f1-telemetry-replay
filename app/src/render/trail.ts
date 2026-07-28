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
