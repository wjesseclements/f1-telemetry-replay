"""
replay_transform — the pure half of the pipeline.

A package since Slice 9i Phase 0 (one module per concern; every symbol re-exported
here, so `from replay_transform import X` is unchanged for every caller and test):

* `contract`    — schema-mirror constants, errors, column/value hygiene
* `grid`        — the uniform emitted grid and per-channel resampling
* `placement`   — arc-length reparameterization: path, travel, anchors
* `repair`      — the two screens: frame displacements, impossible fixes
* `lap_context` — laps and stints (Slice 14)
* `assembly`    — the lap and window builders
* `reporting`   — per-run report lines, quality metrics, serialisation

Everything here is a function from arrays to arrays (or to plain Python data). No
network, no file I/O, no FastF1, no pandas — `numpy` and the standard library only.
That is deliberate and it is the Python mirror of CLAUDE.md architecture rule 4: the
app keeps its time/geometry/interpolation logic in a headless `src/engine/` so it can
be unit-tested, and the pipeline's resampling logic earns the same treatment. The
FastF1 fetch lives in `build_replay.py`, which is the only module that needs a
network connection, and therefore the only module that cannot be tested.

The requirements document for this file is `app/src/engine/schema.ts`. Every rule
below exists because the Zod schema enforces it at load:

* `meta.schemaVersion` must be exactly 1.
* Samples lie on a UNIFORM grid — each `t` within 2 ms of `k / sampleRateHz`. The
  app's O(1) lookup is `index = clock * sampleRateHz` and never reads `t` again, so
  an irregular grid would silently put the car in the wrong place.
* Every car's `len(samples)` must equal `round(duration * sampleRateHz)` to within
  one step, and `t` must be strictly increasing.
* `throttle` is 0-100. Real FastF1 throttle occasionally reads above 100; the
  PIPELINE clamps, because the app deliberately does not widen its contract to
  absorb dirty upstream data.
* `drs` is optional and all-or-nothing per car: present on every sample, or on none.
  It carries the RAW FastF1 code — `app/src/engine/drs.ts` owns the undocumented
  10/12/14 mapping, and decoding here as well would duplicate that guess across two
  languages (CLAUDE.md rule 8).
* `trackStatus` is a top-level, additive interval list in window seconds — sorted,
  non-overlapping, gaps meaning "no answer". `status.py` owns the FastF1 code map;
  unrecognised codes degrade to in-band "unknown" and are reported, never raised.

WHY POSITIONS ARE NOT INTERPOLATED IN TIME
------------------------------------------
Position and car telemetry are independent FastF1 channels, each around 4.2 Hz and
IRREGULARLY spaced (p10 160 ms, p90 400 ms). The position channel's shape is good and
its timestamps are not: interpolating x/y against time therefore placed each 10 Hz
sample at the wrong distance along an otherwise correct path, and the car marker
surged and eased on the straights, disagreeing with the speed the HUD showed. Measured
on 2024 Monza Q VER, the implied velocity `|dxy|/dt` correlated with the speed channel
at only r = 0.70, reaching 740 km/h against a true maximum of 348.

So the two channels are used for what each is good at: POSITION SUPPLIES THE PATH
SHAPE, SPEED SUPPLIES THE PROGRESS ALONG IT. `resample_positions_by_travel` places
grid sample k at the point on the recorded polyline that the cumulative speed integral
says the car had reached. See `PLAN.md` §Slice 6b for the full diagnosis.

WHY THE EMITTED GRID IS NOT THE SOURCE GRID
-------------------------------------------
`meta.duration` is `n / rate`, which rounds the lap UP to a whole grid step, and the
app closes the loop by wrapping the last sample round to the first across one full
step. Reading every channel at `k / rate` therefore left that wrap step covering only
the sub-step REMAINDER of real travel — the car crossed the start/finish line at
`r x` its true speed for a tenth of a second, where `r` is the fractional part of the
lap in grid steps and is uniform on [0, 1). Measured before the fix: Monza VER drew
r = 0.70 (6.17 m of chord where its neighbours are 8.8 m, 222 km/h against a true
319) and Monza LEC drew r = 0.85. A lap that draws r near 0 parks the car at the line.

The fix has two halves, because the wrap step was short for two independent reasons.

`source_times` is the first: emit `t = k / rate` exactly as the schema requires, but
READ each sample from source instant `k * lap / n`. The whole lap is then laid down
over the whole grid, so every step — the wrap step included — covers the same
`lap / n` seconds of real motion. The cost is a uniform time base stretch of
`duration / lap`, under 0.125% for a ~80 s lap at 10 Hz (Monza VER: 1.00039x), which
`build_replay.py` prints on every run so it is never a surprise.

`closing_time` is the second, and was found by measuring the first: a lap's recorded
fixes stop a metre or two SHORT of the fix they started from (Monza Q: 0.67 m for VER,
2.12 m for LEC), yet the app loops the last sample straight back to the first. That
ground is inside the wrap step too, so `lap` above is the recorded time PLUS the time
to cover it — otherwise the wrap step overshoots by exactly the shortfall, which on
LEC was a bigger error than the one being fixed.

Nothing about the CONTRACT moves: `t`, `meta.duration`, both schema refinements and
the whole of `app/src/engine/` are untouched. See `PLAN.md` §Slice 7.
"""

from .assembly import (
    AnchorPlan,
    SessionMeta,
    WindowCar,
    build_corners,
    build_replay_dict,
    build_samples,
    build_window_replay_dict,
    parse_lap_range,
    window_anchor_plan,
    window_grid,
)
from .contract import (
    DEFAULT_COLOR,
    LOOP_CLOSED,
    LOOP_OPEN,
    OPTIONAL_COLUMNS,
    REQUIRED_COLUMNS,
    SAMPLE_RATE_HZ,
    SCHEMA_VERSION,
    SPEED_UNIT,
    MissingColumnsError,
    ReplayMeta,
    TelemetryShapeError,
    check_columns,
    clamp_throttle,
    color_lookup_warning,
    count_out_of_range_gears,
    gear_anomaly_warning,
    normalise_brake,
    normalise_color,
    normalise_gear,
)
from .grid import (
    forward_fill,
    has_drs,
    interp_continuous,
    resample_channels,
    source_times,
    time_base_stretch,
    uniform_grid,
)
from .lap_context import (
    KNOWN_COMPOUNDS,
    UNKNOWN_COMPOUND,
    lap_context,
    normalise_compound,
)
from .placement import (
    KMH_S_PER_METRE,
    lap_start_anchors,
    PARKED_TRAVEL_M,
    closing_time,
    covers_ground,
    cumulative_arclength,
    cumulative_travel,
    hold_positions,
    resample_positions_by_travel,
    slow_span_anchors,
)
from .repair import (
    DISPLACEMENT_TOLERANCE,
    REVERSAL_MIN_SPEED,
    ReversalRejection,
    reject_reversals,
    IMPOSSIBLE_MAX_RUN,
    IMPOSSIBLE_MIN_SPEED,
    IMPOSSIBLE_MIN_STEP_M,
    IMPOSSIBLE_RATIO,
    FixRejection,
    FrameDisplacement,
    reject_impossible_fixes,
    repair_frame_displacements,
)
from .dead_feed import (
    ALIVE,
    DEAD_FEED_MAX_DRIFT,
    DEAD_FEED_MIN_SPEED,
    DEAD_FEED_THROTTLE,
    DEAD_FEED_WINDOW_S,
    DeadFeedResult,
    detect_dead_feed,
    freeze_telemetry,
)
from .reporting import (
    anchor_report,
    dead_feed_report,
    dump_json,
    reversal_report,
    fix_rejection_report,
    frame_repair_report,
    motion_fidelity,
    status_report,
    stint_report,
    window_car_report,
)
from .status import (
    STATUS_BY_CODE,
    STATUS_UNKNOWN,
    StatusIntervals,
    map_status_code,
    window_status_intervals,
)
