import React, { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Gauge } from "lucide-react";

/* ============================================================================
   F1 TELEMETRY REPLAY  —  single-car v1, built to scale to a full-grid replay
   ----------------------------------------------------------------------------
   ARCHITECTURE NOTES (read these — they're the contract):

   1. DATA CONTRACT.  Everything renders from `replay`, a plain JSON object:

        {
          meta:  { year, event, session, track, rotation, sampleRateHz,
                   duration, units:{ speed:"km/h" } },
          track: { startFinish:{x,y,angle}, corners:[{number,letter,x,y}] },
          cars:  [ { driver, team, color,
                     samples:[ {t,x,y,speed,throttle,brake,gear,drs}, ... ] } ]
        }

      `samples` are on a UNIFORM TIME GRID (sampleRateHz). That makes playback
      lookup O(1): index = clock * sampleRateHz. The FastF1 pipeline
      (build_replay.py) emits this exact shape. To go from 1 car -> 20 cars you
      add entries to cars[]; NOTHING in this component changes except the loop
      that already maps over replay.cars.

   2. RENDER LOOP is decoupled from React. One requestAnimationFrame loop reads
      refs and draws to <canvas>. React state is only touched for the HUD/scrub,
      throttled to ~30fps. Adding 19 more cars does not add React re-renders.

   3. The synthetic generator below stands in for real telemetry so the app
      runs with no data file. Replace `useSyntheticReplay()` with a fetch of
      your build_replay.py output and everything else is unchanged.
   ============================================================================ */

/* ---- design tokens -------------------------------------------------------- */
const C = {
  bg: "#0A0D12", panel: "#11151C", panel2: "#161B24", line: "#232A34",
  txt: "#E6EAF0", dim: "#8A94A6", accent: "#FFD02E",
  throttle: "#29E07A", brake: "#FF3B47", drs: "#2EC8FF",
};
// thermal speed gradient: cold/slow -> hot/fast
const THERMAL = [
  [80, [30, 80, 255]], [150, [24, 195, 255]], [220, [43, 224, 138]],
  [280, [244, 224, 77]], [340, [255, 86, 48]],
];
function speedColor(v) {
  const s = THERMAL;
  if (v <= s[0][0]) return `rgb(${s[0][1].join(",")})`;
  if (v >= s[s.length - 1][0]) return `rgb(${s[s.length - 1][1].join(",")})`;
  for (let i = 0; i < s.length - 1; i++) {
    const [a, ca] = s[i], [b, cb] = s[i + 1];
    if (v >= a && v <= b) {
      const f = (v - a) / (b - a);
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(",")})`;
    }
  }
  return "#888";
}
const SPEED_BUCKETS = 9; // for batched trail stroking
const bucketOf = (v) =>
  Math.max(0, Math.min(SPEED_BUCKETS - 1,
    Math.floor(((v - 70) / (345 - 70)) * SPEED_BUCKETS)));
const bucketColor = (i) => speedColor(70 + ((i + 0.5) / SPEED_BUCKETS) * (345 - 70));

/* ---- geometry helpers ----------------------------------------------------- */
function catmullRom(pts, perSeg = 40) {
  const out = [];
  const N = pts.length;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i],
          p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    for (let t = 0; t < perSeg; t++) {
      const s = t / perSeg, s2 = s * s, s3 = s2 * s;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * s +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * s +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3),
      });
    }
  }
  return out;
}
function resampleByArcLength(pts, step) {
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    let prev = pts[i - 1];
    while (acc + d >= step) {
      const need = step - acc;
      const f = need / d;
      const np = { x: prev.x + (pts[i].x - prev.x) * f,
                   y: prev.y + (pts[i].y - prev.y) * f };
      out.push(np);
      prev = np;
      d = Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y);
      acc = 0;
    }
    acc += d;
  }
  return out;
}

/* ---- synthetic telemetry: stands in for real FastF1 output ---------------- */
function useSyntheticReplay() {
  return useMemo(() => {
    // hand-authored circuit: long straight, T1 hairpin, esses, sweeper, chicane
    const waypoints = [
      { x: 12, y: 86 }, { x: 78, y: 90 }, { x: 90, y: 78 }, { x: 80, y: 66 },
      { x: 60, y: 70 }, { x: 50, y: 58 }, { x: 64, y: 48 }, { x: 84, y: 44 },
      { x: 90, y: 28 }, { x: 72, y: 16 }, { x: 46, y: 20 }, { x: 40, y: 36 },
      { x: 26, y: 40 }, { x: 14, y: 30 }, { x: 10, y: 52 }, { x: 22, y: 64 },
      { x: 16, y: 76 },
    ];
    const dense = catmullRom(waypoints, 36);
    const SCALE = 46;                         // world units -> metres (lap ~4.6km)
    const arc = resampleByArcLength(dense, 0.9);
    const P = arc.map((p) => ({ x: p.x * SCALE, y: p.y * SCALE }));
    const M = P.length;

    // arc length + heading + curvature
    const ds = [], heading = [];
    for (let i = 0; i < M; i++) {
      const a = P[i], b = P[(i + 1) % M];
      ds.push(Math.hypot(b.x - a.x, b.y - a.y));
      heading.push(Math.atan2(b.y - a.y, b.x - a.x));
    }
    const curv = [];
    for (let i = 0; i < M; i++) {
      let dh = heading[i] - heading[(i - 1 + M) % M];
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      curv.push(Math.abs(dh) / Math.max(ds[i], 0.5));
    }
    // smooth curvature
    const cs = curv.map((_, i) => {
      let s = 0, n = 0;
      for (let k = -4; k <= 4; k++) { s += curv[(i + k + M) % M]; n++; }
      return s / n;
    });

    // physical target speed: v = sqrt(a_lat / kappa), clamped
    const A_LAT = 42, V_MAX = 94, V_MIN = 22; // m/s  (~338 / ~79 km/h)
    let v = cs.map((k) => Math.max(V_MIN, Math.min(V_MAX, Math.sqrt(A_LAT / Math.max(k, 1e-4)))));
    // accel/brake limiting passes (circular, a few iterations)
    const A_BRK = 48, A_ACC = 14;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = M - 1; i >= 0; i--) {           // braking (backward)
        const nx = (i + 1) % M;
        v[i] = Math.min(v[i], Math.sqrt(v[nx] ** 2 + 2 * A_BRK * ds[i]));
      }
      for (let i = 0; i < M; i++) {                // accel (forward)
        const pv = (i - 1 + M) % M;
        v[i] = Math.min(v[i], Math.sqrt(v[pv] ** 2 + 2 * A_ACC * ds[i]));
      }
    }

    // per-point time, throttle/brake/gear/drs
    const tAt = [0];
    for (let i = 0; i < M; i++) {
      const vavg = Math.max((v[i] + v[(i + 1) % M]) / 2, 1);
      tAt.push(tAt[i] + ds[i] / vavg);
    }
    const lapTime = tAt[M];
    const longStraightStart = 0; // main straight begins at start/finish
    const point = (i) => {
      const nx = (i + 1) % M;
      const dv = v[nx] - v[i];
      let throttle, brake;
      if (dv > 0.05) { throttle = Math.min(100, 60 + dv * 30); brake = 0; }
      else if (dv < -0.15) { throttle = 0; brake = 1; }
      else { throttle = v[i] > 60 ? 100 : 70; brake = 0; }
      const kmh = v[i] * 3.6;
      const gear = Math.max(1, Math.min(8, Math.round((kmh / 338) * 8)));
      const onStraight = cs[i] < 0.004;
      const drs = onStraight && kmh > 250 && dv >= 0 ? 1 : 0;
      return { throttle: Math.round(throttle), brake, gear, drs, kmh };
    };

    // resample to UNIFORM TIME GRID — this is the schema's `samples`
    const RATE = 20; // Hz
    const nSamples = Math.floor(lapTime * RATE);
    const samples = [];
    let cursor = 0;
    for (let s = 0; s < nSamples; s++) {
      const tt = s / RATE;
      while (cursor < M - 1 && tAt[cursor + 1] < tt) cursor++;
      const seg = Math.max(tAt[cursor + 1] - tAt[cursor], 1e-6);
      const f = Math.min(1, Math.max(0, (tt - tAt[cursor]) / seg));
      const a = P[cursor], b = P[(cursor + 1) % M];
      const pm = point(cursor);
      samples.push({
        t: tt,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        speed: Math.round(v[cursor] * 3.6),
        throttle: pm.throttle, brake: pm.brake, gear: pm.gear, drs: pm.drs,
      });
    }

    // corners = local curvature maxima, numbered along the lap
    const corners = [];
    for (let i = 0; i < M; i++) {
      const isMax = cs[i] > 0.015 &&
        cs[i] >= cs[(i - 6 + M) % M] && cs[i] >= cs[(i + 6) % M];
      if (isMax) {
        const last = corners[corners.length - 1];
        if (!last || Math.hypot(P[i].x - last.x, P[i].y - last.y) > 220) {
          corners.push({ number: corners.length + 1, letter: "", x: P[i].x, y: P[i].y });
        }
      }
    }

    return {
      meta: {
        year: 2024, event: "Silverpine GP", session: "Q",
        track: "Synthetic Circuit", rotation: -14, sampleRateHz: RATE,
        duration: nSamples / RATE, units: { speed: "km/h" },
      },
      track: {
        startFinish: { x: P[0].x, y: P[0].y, angle: heading[0] },
        corners,
      },
      cars: [{ driver: "VER", team: "Demo", color: "#3671C6", samples }],
    };
  }, []);
}

/* ---- format helpers ------------------------------------------------------- */
const fmtClock = (s) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${m}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
};

/* ============================================================================ */
export default function TelemetryReplay() {
  const replay = useSyntheticReplay();
  const car = replay.cars[0];
  const { samples } = car;
  const { sampleRateHz, duration, rotation } = replay.meta;

  // rotate world points once (real data uses circuit_info rotation the same way)
  const geo = useMemo(() => {
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const pts = samples.map((s) => ({
      x: s.x * cos - s.y * sin,
      y: s.x * sin + s.y * cos,
      speed: s.speed,
    }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const corners = replay.track.corners.map((c) => ({
      ...c,
      rx: c.x * cos - c.y * sin,
      ry: c.x * sin + c.y * cos,
    }));
    return { pts, minX, minY, maxX, maxY, corners };
  }, [samples, rotation, replay.track.corners]);

  // refs that drive the animation (no re-render)
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const xformRef = useRef({ scale: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 });
  const clockRef = useRef(0);
  const rafRef = useRef(0);
  const lastRef = useRef(null);
  const hudThrottle = useRef(0);

  // react state: chrome only
  const [isPlaying, setIsPlaying] = useState(true);
  const [speedMult, setSpeedMult] = useState(1);
  const [hud, setHud] = useState({ speed: 0, gear: 1, throttle: 0, brake: 0, drs: 0 });
  const [clockUi, setClockUi] = useState(0);

  const playingRef = useRef(isPlaying);
  const multRef = useRef(speedMult);
  useEffect(() => { playingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { multRef.current = speedMult; }, [speedMult]);

  // respect reduced motion: start paused
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setIsPlaying(false);
    }
  }, []);

  const sampleAt = (t) => {
    const idx = t * sampleRateHz;
    const i = Math.min(samples.length - 1, Math.floor(idx));
    const j = Math.min(samples.length - 1, i + 1);
    const f = idx - i;
    const a = geo.pts[i], b = geo.pts[j], sa = samples[i], sb = samples[j];
    return {
      i,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      heading: Math.atan2(b.y - a.y, b.x - a.x),
      speed: Math.round(sa.speed + (sb.speed - sa.speed) * f),
      throttle: sa.throttle, brake: sa.brake, gear: sa.gear, drs: sa.drs,
    };
  };

  const computeXform = () => {
    const cv = canvasRef.current, wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
    const pad = 46;
    const spanX = geo.maxX - geo.minX, spanY = geo.maxY - geo.minY;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = (w - spanX * scale) / 2 - geo.minX * scale;
    const oy = (h - spanY * scale) / 2 - geo.minY * scale;
    xformRef.current = { scale, ox, oy, w, h, dpr };
  };

  useEffect(() => {
    computeXform();
    const ro = new ResizeObserver(() => computeXform());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo]);

  const draw = () => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const { scale, ox, oy, w, h, dpr } = xformRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sx = (x) => x * scale + ox;
    const sy = (y) => y * scale + oy;

    // track ribbon (full outline, faint road)
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.strokeStyle = C.line; ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(sx(geo.pts[0].x), sy(geo.pts[0].y));
    for (let i = 1; i < geo.pts.length; i++) ctx.lineTo(sx(geo.pts[i].x), sy(geo.pts[i].y));
    ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = "#0E1218"; ctx.lineWidth = 9; ctx.stroke();

    const cur = sampleAt(clockRef.current);

    // speed-gradient TRAIL (the signature) — covered portion this lap, bucketed
    const paths = Array.from({ length: SPEED_BUCKETS }, () => new Path2D());
    for (let k = 0; k < cur.i; k++) {
      const p = paths[bucketOf(samples[k].speed)];
      p.moveTo(sx(geo.pts[k].x), sy(geo.pts[k].y));
      p.lineTo(sx(geo.pts[k + 1].x), sy(geo.pts[k + 1].y));
    }
    ctx.lineWidth = 5;
    for (let b = 0; b < SPEED_BUCKETS; b++) {
      ctx.strokeStyle = bucketColor(b);
      ctx.stroke(paths[b]);
    }

    // start/finish line
    const sf = geo.pts[0];
    const a = Math.atan2(geo.pts[1].y - sf.y, geo.pts[1].x - sf.x) + Math.PI / 2;
    ctx.strokeStyle = "#E6EAF0"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx(sf.x) + Math.cos(a) * 10, sy(sf.y) + Math.sin(a) * 10);
    ctx.lineTo(sx(sf.x) - Math.cos(a) * 10, sy(sf.y) - Math.sin(a) * 10);
    ctx.stroke();

    // corner numbers
    ctx.font = "600 11px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const c of geo.corners) {
      const cx = sx(c.rx), cy = sy(c.ry);
      ctx.fillStyle = C.panel2;
      ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = C.dim; ctx.fillText(String(c.number), cx, cy + 0.5);
    }

    // car marker (glow + body + direction)
    const cx = sx(cur.x), cy = sy(cur.y);
    const col = speedColor(cur.speed);
    ctx.shadowColor = col; ctx.shadowBlur = 18;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(cx, cy, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#0A0D12";
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    // heading tick
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(cur.heading) * 12, cy + Math.sin(cur.heading) * 12);
    ctx.stroke();
  };

  // single rAF loop
  useEffect(() => {
    const loop = (now) => {
      if (lastRef.current == null) lastRef.current = now;
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      if (playingRef.current) {
        clockRef.current += dt * multRef.current;
        if (clockRef.current >= duration) clockRef.current %= duration;
      }
      draw();
      if (now - hudThrottle.current > 33) {
        hudThrottle.current = now;
        const s = sampleAt(clockRef.current);
        setHud({ speed: s.speed, gear: s.gear, throttle: s.throttle, brake: s.brake, drs: s.drs });
        setClockUi(clockRef.current);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, duration]);

  const seek = (t) => {
    clockRef.current = Math.max(0, Math.min(duration - 0.001, t));
    const s = sampleAt(clockRef.current);
    setHud({ speed: s.speed, gear: s.gear, throttle: s.throttle, brake: s.brake, drs: s.drs });
    setClockUi(clockRef.current);
  };

  // sparkline (speed over the lap) — static path computed once
  const spark = useMemo(() => {
    const W = 240, H = 46, step = Math.max(1, Math.floor(samples.length / 240));
    let vmax = 1;
    for (const s of samples) vmax = Math.max(vmax, s.speed);
    let d = "";
    for (let i = 0; i < samples.length; i += step) {
      const x = (i / (samples.length - 1)) * W;
      const y = H - (samples[i].speed / vmax) * (H - 4) - 2;
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    return { d, W, H };
  }, [samples]);
  const playheadX = (clockUi / duration) * spark.W;

  const MULTS = [0.5, 1, 2, 4];

  return (
    <div style={S.app}>
      <style>{CSS}</style>

      {/* header */}
      <div style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Gauge size={18} color={C.accent} />
          <div>
            <div style={S.title}>TELEMETRY REPLAY</div>
            <div style={S.sub}>{replay.meta.track}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={S.badge}>{replay.meta.year}</span>
          <span style={S.badge}>{replay.meta.event}</span>
          <span style={{ ...S.badge, color: C.accent, borderColor: "#3a3413" }}>
            {replay.meta.session === "Q" ? "QUALIFYING" : replay.meta.session}
          </span>
          <span style={{ ...S.chip, borderColor: car.color }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: car.color }} />
            {car.driver}
          </span>
        </div>
      </div>

      {/* main grid */}
      <div style={S.grid}>
        <div ref={wrapRef} style={S.canvasWrap}>
          <canvas ref={canvasRef} />
          <div style={S.legend}>
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: 1 }}>SLOW</span>
            <div style={S.legendBar} />
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: 1 }}>FAST</span>
          </div>
        </div>

        <div style={S.telemetry}>
          <div style={S.speedBlock}>
            <div style={S.speedVal}>{String(hud.speed).padStart(3, " ")}</div>
            <div style={S.unit}>km/h</div>
          </div>

          <div style={S.gearRow}>
            <div>
              <div style={S.lbl}>GEAR</div>
              <div style={S.gearVal}>{hud.gear}</div>
            </div>
            <div style={{
              ...S.drsPill,
              background: hud.drs ? C.drs : "transparent",
              color: hud.drs ? "#04121A" : C.dim,
              borderColor: hud.drs ? C.drs : C.line,
            }}>DRS</div>
          </div>

          <div style={S.barGroup}>
            <Bar label="THROTTLE" value={hud.throttle} color={C.throttle} />
            <Bar label="BRAKE" value={hud.brake ? 100 : 0} color={C.brake} />
          </div>

          <div style={S.sparkWrap}>
            <div style={S.lbl}>SPEED · LAP</div>
            <svg width="100%" viewBox={`0 0 ${spark.W} ${spark.H}`} preserveAspectRatio="none"
                 style={{ display: "block", height: 46 }}>
              <path d={spark.d} fill="none" stroke={C.dim} strokeWidth="1" opacity="0.6" />
              <line x1={playheadX} y1="0" x2={playheadX} y2={spark.H}
                    stroke={C.accent} strokeWidth="1.5" />
            </svg>
          </div>
        </div>
      </div>

      {/* transport */}
      <div style={S.transport}>
        <button style={S.iconBtn} onClick={() => seek(0)} title="Restart">
          <RotateCcw size={16} />
        </button>
        <button style={{ ...S.iconBtn, ...S.playBtn }} onClick={() => setIsPlaying((p) => !p)}>
          {isPlaying ? <Pause size={17} /> : <Play size={17} style={{ marginLeft: 2 }} />}
        </button>
        <div style={S.mults}>
          {MULTS.map((m) => (
            <button key={m} onClick={() => setSpeedMult(m)}
              style={{ ...S.multBtn, ...(speedMult === m ? S.multOn : {}) }}>
              {m}×
            </button>
          ))}
        </div>
        <input className="scrub" type="range" min={0} max={duration} step={0.01}
          value={clockUi} onChange={(e) => seek(parseFloat(e.target.value))}
          style={{ flex: 1 }} />
        <div style={S.time}>
          <span style={{ color: C.txt }}>{fmtClock(clockUi)}</span>
          <span style={{ color: C.dim }}> / {fmtClock(duration)}</span>
        </div>
      </div>
    </div>
  );
}

function Bar({ label, value, color }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={S.lbl}>{label}</span>
        <span style={{ ...S.lbl, color: C.txt }}>{Math.round(value)}%</span>
      </div>
      <div style={S.barTrack}>
        <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: 3,
                      transition: "width 60ms linear" }} />
      </div>
    </div>
  );
}

/* ---- styles --------------------------------------------------------------- */
const mono = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const sans = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const S = {
  app: { background: C.bg, color: C.txt, fontFamily: sans, borderRadius: 14,
    border: `1px solid ${C.line}`, overflow: "hidden", display: "flex",
    flexDirection: "column", height: 640, maxWidth: 1000, margin: "0 auto" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 18px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap", gap: 10 },
  title: { fontSize: 13, fontWeight: 700, letterSpacing: 2, color: C.txt },
  sub: { fontSize: 11, color: C.dim, letterSpacing: 0.5 },
  badge: { fontFamily: mono, fontSize: 10, letterSpacing: 1, color: C.dim,
    border: `1px solid ${C.line}`, borderRadius: 5, padding: "3px 7px" },
  chip: { display: "inline-flex", alignItems: "center", gap: 6, fontFamily: mono,
    fontSize: 11, fontWeight: 600, border: "1px solid", borderRadius: 5, padding: "3px 9px" },
  grid: { display: "flex", flex: 1, minHeight: 0 },
  canvasWrap: { position: "relative", flex: 1, minWidth: 0, background:
    "radial-gradient(120% 120% at 50% 0%, #0E141C 0%, #0A0D12 70%)" },
  legend: { position: "absolute", bottom: 14, left: 14, display: "flex",
    alignItems: "center", gap: 8 },
  legendBar: { width: 90, height: 6, borderRadius: 3, background:
    "linear-gradient(90deg, rgb(30,80,255), rgb(24,195,255), rgb(43,224,138), rgb(244,224,77), rgb(255,86,48))" },
  telemetry: { width: 232, flexShrink: 0, borderLeft: `1px solid ${C.line}`,
    background: C.panel, padding: 18, display: "flex", flexDirection: "column", gap: 18 },
  speedBlock: { display: "flex", alignItems: "baseline", gap: 8 },
  speedVal: { fontFamily: mono, fontSize: 56, fontWeight: 700, lineHeight: 1,
    letterSpacing: -2, color: C.txt, fontVariantNumeric: "tabular-nums" },
  unit: { fontSize: 13, color: C.dim, fontFamily: mono },
  gearRow: { display: "flex", alignItems: "flex-end", justifyContent: "space-between" },
  gearVal: { fontFamily: mono, fontSize: 34, fontWeight: 700, lineHeight: 1, color: C.accent },
  drsPill: { fontFamily: mono, fontSize: 12, fontWeight: 700, letterSpacing: 1,
    border: "1px solid", borderRadius: 5, padding: "5px 10px" },
  barGroup: { display: "flex", flexDirection: "column", gap: 12 },
  barTrack: { height: 8, background: C.panel2, borderRadius: 4, overflow: "hidden" },
  lbl: { fontFamily: mono, fontSize: 10, letterSpacing: 1.5, color: C.dim },
  sparkWrap: { marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 },
  transport: { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px",
    borderTop: `1px solid ${C.line}`, background: C.panel },
  iconBtn: { display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: 8,
    border: `1px solid ${C.line}`, background: C.panel2, color: C.txt, cursor: "pointer" },
  playBtn: { background: C.accent, color: "#0A0D12", border: "none", width: 38, height: 38 },
  mults: { display: "flex", gap: 2, background: C.panel2, borderRadius: 8, padding: 2 },
  multBtn: { fontFamily: mono, fontSize: 12, color: C.dim, background: "transparent",
    border: "none", borderRadius: 6, padding: "5px 9px", cursor: "pointer" },
  multOn: { background: C.line, color: C.txt },
  time: { fontFamily: mono, fontSize: 12, whiteSpace: "nowrap", minWidth: 132, textAlign: "right" },
};
const CSS = `
  .scrub { -webkit-appearance:none; appearance:none; height:4px; border-radius:3px;
    background:${C.line}; outline:none; cursor:pointer; }
  .scrub::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px;
    border-radius:50%; background:${C.accent}; cursor:pointer; border:2px solid ${C.bg}; }
  .scrub::-moz-range-thumb { width:14px; height:14px; border-radius:50%;
    background:${C.accent}; cursor:pointer; border:2px solid ${C.bg}; }
  @media (max-width: 720px){
    .scrub { }
  }
`;
