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
 * THREE PAINTERS, ONE GEOMETRY
 * ----------------------------
 * All three read the same screen-space `Float64Array` — `paths.ts` projects each car's
 * path once and hands the same buffer to whichever painters that car needs.
 *
 * `TailPainter` is the short wake every UNFOCUSED car wears, in its team colour.
 * Twenty full-lap speed trails on near-identical racing lines is visual mud and the
 * thermal ramp stops encoding anything legible (Slice 4b).
 *
 * The FOCUSED car's painter depends on `meta.loop`, and that is Slice 9b:
 *
 *  - `"closed"` — a lap: `TrailPainter`, the retained covered-portion trail. Its reset
 *    is the clock going backwards, which in a closed replay happens at the line every
 *    lap, because `meta.duration` IS one lap. That is what makes "covered portion" mean
 *    "this lap".
 *  - `"open"` — a session-time window: `CometPainter`, a bounded thermal comet. An open
 *    window's `duration` is the WHOLE window, so a covered-portion trail resets only at
 *    its end and every lap accumulates. On a ~7-lap file that paints the entire circuit
 *    and keeps repainting it, until the trail has visually replaced the ribbon, the S/F
 *    line and the corner badges and the cars cannot be seen at all.
 *
 * Slice 4b's ruling is EXTENDED here, not overturned. 4b rejected persistence because
 * "at steady pace lap-over-lap variation is minimal, so persistence preserves redundant
 * information" — and within an open window, a covered portion spanning several laps IS
 * persistence. Same rule, case 4b never had in front of it.
 *
 * Which painter a car gets is a per-car PROPERTY (focused or not) crossed with a
 * property of the DATA (`meta.loop`) — never a branch on how many cars there are. A
 * one-car open window gets the comet too, and correctly so.
 */
import { COMET_BUCKETS, SPEED_BUCKETS, bucketColor } from "../engine/color";

/**
 * What the FOCUSED car's painter has to be able to do, whichever one it is.
 *
 * `paths.ts` picks the implementation once, at build time, from `meta.loop`, so the
 * per-frame loop in `scene.ts` has no mode branch in it at all — it just paints.
 */
export interface FocusPainter {
  /**
   * Paint this car's wake, ending at its interpolated position.
   *
   * @param index the leading whole sample — the car is up to one grid step past it.
   * @param toX   where the car actually is, in screen pixels.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    index: number,
    toX: number,
    toY: number,
  ): void;
}

/**
 * Bucket colours, resolved once at module load — never per frame, never per car.
 *
 * Two tables because the trail and the comet sample the ramp at different resolutions
 * (Slice 9c), not because there are two ramps: both come from the same `bucketColor`
 * over the same domain, so a change to `THERMAL` moves both or neither. 41 strings at
 * module load, once.
 */
const BUCKET_COLORS: readonly string[] = Array.from(
  { length: SPEED_BUCKETS },
  (_, b) => bucketColor(b, SPEED_BUCKETS),
);
const COMET_COLORS: readonly string[] = Array.from(
  { length: COMET_BUCKETS },
  (_, b) => bucketColor(b, COMET_BUCKETS),
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
export class TrailPainter implements FocusPainter {
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
   * `FocusPainter`: catch up, paint the covered portion, close the gap to the car.
   *
   * A thin wrapper over the three calls `scene.ts` used to make itself, in exactly that
   * order — the closed-mode draw sequence is a regression fixture (Slice 9b captured it
   * before this refactor and diffs against it), so the order here is not free to move.
   * The three methods stay public because their own tests drive them individually.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    index: number,
    toX: number,
    toY: number,
  ): void {
    this.syncTo(index);
    this.stroke(ctx);
    this.strokeHead(ctx, index, toX, toY);
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

/**
 * How much of the recent past an unfocused car's tail shows, in seconds.
 *
 * Tuned by eye on a full-field file (19 cars, Monza R laps 20-22), the same method
 * `COMET_SECONDS` was set by — and for the same reason, arrived at from the other
 * direction. At 1.5 s the tails were sized for the three-car window they were built
 * on; at nineteen they overlap into a band of team colour along the racing line and
 * the cars stop being separable from their own history.
 *
 * It also fixes the focus ratio Slice 9b closed with as an open flag. The focused
 * car's comet is `COMET_SECONDS` = 2 s; against a 1.5 s tail that is 1.3×, which is
 * not a legible difference in motion. At 0.5 s it is 4×, so which car is focused
 * reads from the canvas alone, without the tower.
 */
export const TAIL_SECONDS = 0.5;
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
 * The sample range band `b` of `bands` covers, within `[start, start + span]`.
 *
 * Shared by both wake painters so their geometry cannot drift apart. Consecutive bands
 * share their boundary sample, which is what makes them meet with no gap.
 */
function bandBounds(
  start: number,
  span: number,
  b: number,
  bands: number,
): { from: number; to: number } {
  return {
    from: start + Math.round((span * b) / bands),
    to: start + Math.round((span * (b + 1)) / bands),
  };
}

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
      const { from, to } = bandBounds(start, span, b, TAIL_BANDS);
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

/**
 * How much of the recent past the FOCUSED car's comet shows in an open window, in
 * seconds — measured in REPLAY time, so it covers the same ground at any playback rate.
 *
 * **Tuned by eye against a real file, and the spec was wrong about the range.** Slice
 * 9b reasoned its way to 6–10 s from the data; the answer is **2**. The gap is not a
 * mistake in the arithmetic, it is what the arithmetic was measuring: the spec reasoned
 * in DATA time, and what a viewer judges is PERCEIVED length, which runs about 4×
 * longer at the speeds a long window is actually watched at. At 2 s the comet reads as
 * recent history attached to the car — roughly one braking zone — and the circuit stays
 * legible nine minutes in. At 8 s it was already creeping back toward the wall of
 * colour this slice exists to remove.
 *
 * Edit it with `npm run dev` running; HMR applies it live.
 */
export const COMET_SECONDS = 2;
/** Stroke width of the comet — the focused car's wake, so as wide as a trail. */
export const COMET_WIDTH = TRAIL_WIDTH;
/**
 * How many alpha steps the comet's fade is quantised into.
 *
 * **This constant is the fade/hard-end decision**, and it is a constant so that
 * reversing that decision is one edit rather than a rework. Slice 9b left the choice to
 * the human's eye on a real file:
 *
 *  - `4` — the comet fades out behind the car.
 *  - `1` — one fully-opaque band: the hard-end fallback, at the cost of the comet
 *    ending abruptly rather than fading.
 *
 * Either way the stroke bound is `segments + 1` — see `CometPainter` — so this constant
 * does not trade cost against legibility; it only decides which of the two looks right.
 *
 * `COMET_ALPHA` below is written so that the newest band is 1.0 at ANY band count, so
 * setting this to 1 yields a single opaque comet with nothing else to change.
 */
export const COMET_BANDS = 4;
/** Alpha of the oldest band. The newest is always 1.0 — see `COMET_ALPHA`. */
const COMET_MIN_ALPHA = 0.15;

/**
 * Alpha of comet band `b`, oldest (0) to newest.
 *
 * The newest band is **exactly 1.0**, deliberately: a comet's colour is a speed bucket
 * multiplied by this alpha, and the thermal ramp's legibility is the one thing Slice 9b
 * may not trade away. At the head — where the eye actually reads the current speed — the
 * ramp is therefore undimmed, and the fade only touches the older segments where the
 * colour matters least.
 */
const COMET_ALPHA: readonly number[] = Array.from(
  { length: COMET_BANDS },
  (_, b) => COMET_MIN_ALPHA + ((1 - COMET_MIN_ALPHA) * (b + 1)) / COMET_BANDS,
);

/**
 * The FOCUSED car's wake in an OPEN window: a bounded comet, painted by speed.
 *
 * `TailPainter`'s bounded rebuild wearing the thermal ramp — the whole of Slice 9b is
 * that composition, at the finer `COMET_BUCKETS` sampling Slice 9c gave it. It exists because a covered-portion trail is defined
 * relative to a lap, and an open window is not a lap: `meta.duration` spans the whole
 * window, so the trail's reset never fires until the window ends and every lap in it
 * accumulates into one saturated static map. See the file header.
 *
 * TWO THINGS THE BOUNDED FORM GETS FOR FREE
 * -----------------------------------------
 *  - **A backwards seek needs no rebuild.** The comet is recomputed from
 *    `[index − length, index]` every frame, so it is simply correct wherever the clock
 *    lands. The `Path2D`-cannot-be-un-drawn problem that shapes `TrailPainter` — and
 *    costs it `SPEED_BUCKETS` allocations per wrap — does not arise here at all.
 *  - **Cost is independent of window length.** A 7-lap window costs exactly what a
 *    1-lap window costs, which is the property whose absence caused the defect.
 *
 * THE STROKE BOUND, and why it is not `bands × buckets`
 * -----------------------------------------------------
 * A band strokes once per bucket it actually CONTAINS, never once per bucket that
 * exists, so summed over the bands that is at most one stroke per segment plus the head:
 *
 *   strokes ≤ span + 1,  span = min(index, length)
 *
 * = **21** at `COMET_SECONDS = 2` on a 10 Hz grid. Independent of the bucket count and —
 * the property Slice 9b exists to protect — independent of window length. Slice 9c
 * raised the comet's resolution from 9 buckets to `COMET_BUCKETS`, and the bound did not
 * move: `bands × buckets` (128) was never what limited it, and quoting that number after
 * the raise would have been a guard in name only.
 */
export class CometPainter implements FocusPainter {
  /**
   * Which buckets the band being drawn contains.
   *
   * Allocated once and refilled per band, never per frame — the point of it is to skip
   * `beginPath`/`stroke` pairs for buckets that are not present, which is what makes the
   * bound above one-per-segment instead of one-per-bucket. It matters more at
   * `COMET_BUCKETS` than it did at nine: a comet on a straight touches one or two of the
   * 32 and still costs one or two strokes.
   */
  private readonly present = new Uint8Array(COMET_BUCKETS);

  /**
   * @param screen  the same flat `[x0, y0, x1, y1, …]` every painter for this car uses.
   * @param buckets `buckets[k]` is the speed bucket of the segment LEAVING sample k, at
   *                `COMET_BUCKETS` resolution — NOT the array `TrailPainter` colours
   *                itself from, which is the same ramp sampled at `SPEED_BUCKETS`
   *                (Slice 9c). `paths.ts` hands each painter its own key.
   * @param length  how many segments the comet spans (`COMET_SECONDS × sampleRateHz`),
   *                so it is a duration and looks the same at any grid rate.
   */
  constructor(
    private readonly screen: Float64Array,
    private readonly buckets: Uint8Array,
    private readonly length: number,
  ) {}

  /**
   * Paint the comet, ending at the car's interpolated position.
   *
   * Clamped at sample 0 rather than wrapping: an open window's samples do not continue
   * across the loop point (`meta.loop`, Slice 8), so a comet reaching backwards there
   * would draw a chord across the circuit that the car never travelled.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    index: number,
    toX: number,
    toY: number,
  ): void {
    const start = Math.max(0, index - this.length);
    const span = index - start;

    ctx.lineWidth = COMET_WIDTH;

    for (let b = 0; b < COMET_BANDS; b++) {
      const { from, to } = bandBounds(start, span, b, COMET_BANDS);
      const isNewest = b === COMET_BANDS - 1;
      // An empty band has nothing to draw — except the newest, which always carries the
      // segment between the last whole sample and the car itself.
      if (from === to && !isNewest) continue;

      this.present.fill(0);
      for (let k = from; k < to; k++) this.present[this.buckets[k]] = 1;
      // The head segment takes the bucket of the sample it leaves, exactly as
      // `TrailPainter.strokeHead` does.
      if (isNewest) this.present[this.buckets[index]] = 1;

      ctx.globalAlpha = COMET_ALPHA[b];
      for (let bucket = 0; bucket < COMET_BUCKETS; bucket++) {
        if (this.present[bucket] === 0) continue;

        ctx.strokeStyle = COMET_COLORS[bucket];
        ctx.beginPath();
        // One `moveTo`/`lineTo` pair per segment of this bucket: the segments a bucket
        // owns within a band are not necessarily contiguous, so this is a batch of
        // separate strokes in one path rather than a polyline.
        for (let k = from; k < to; k++) {
          if (this.buckets[k] !== bucket) continue;
          ctx.moveTo(this.screen[k * 2], this.screen[k * 2 + 1]);
          ctx.lineTo(this.screen[k * 2 + 2], this.screen[k * 2 + 3]);
        }
        if (isNewest && this.buckets[index] === bucket) {
          ctx.moveTo(this.screen[index * 2], this.screen[index * 2 + 1]);
          ctx.lineTo(toX, toY);
        }
        ctx.stroke();
      }
    }

    // Everything drawn after this — the chrome, the car markers — is opaque.
    //
    // DEFENSIVE here, not load-bearing, and worth saying so plainly: `COMET_ALPHA`'s
    // newest band is 1.0 by construction, so the loop above already leaves the context
    // opaque, and no test can tell this line from its absence — a mutation deleting it
    // passes the entire suite. It stays because "the head is opaque" is a property of
    // the ramp FORMULA rather than of this method: change the formula so the head is
    // 0.9 and the corner badges would start rendering translucent. `TailPainter`'s
    // identical line IS load-bearing, its brightest band being 0.8.
    ctx.globalAlpha = 1;
  }
}
