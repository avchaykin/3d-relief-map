// Height curve: maps normalised map elevation (0 = lowest, 1 = highest) to
// normalised model height, like the Curves tool of an image editor.
// A curve is a list of [x, y] points sorted by x. Left of the first point and
// right of the last one the curve is flat, so moving the end points inwards
// works like the black/white sliders of Levels.

export const CURVE_PRESETS = {
  linear: { name: 'Linear', points: [[0, 0], [1, 1]] },
  lowlands: { name: 'Lift lowlands', points: [[0, 0], [0.25, 0.48], [1, 1]] },
  peaks: { name: 'Sharpen peaks', points: [[0, 0], [0.6, 0.32], [1, 1]] },
  contrast: { name: 'S-curve', points: [[0, 0], [0.25, 0.13], [0.75, 0.87], [1, 1]] },
  plateau: { name: 'Soften extremes', points: [[0, 0], [0.2, 0.3], [0.8, 0.7], [1, 1]] },
};

const LUT_SIZE = 1024;

/** Lookup table of the curve (monotone cubic through the points, clamped to 0..1). */
export function curveLUT(points) {
  const lut = new Float32Array(LUT_SIZE + 1);
  const pts = points?.length >= 2 ? points : CURVE_PRESETS.linear.points;
  const n = pts.length;
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / Math.max(1e-6, pts[i + 1][0] - pts[i][0]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  // Fritsch-Carlson limiter: no overshoot between points
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let k = 0; k <= LUT_SIZE; k++) {
    const x = k / LUT_SIZE;
    let y;
    if (x <= pts[0][0]) y = pts[0][1];
    else if (x >= pts[n - 1][0]) y = pts[n - 1][1];
    else {
      while (x > pts[seg + 1][0]) seg++;
      const h = pts[seg + 1][0] - pts[seg][0];
      const t = (x - pts[seg][0]) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * pts[seg][1] + (t3 - 2 * t2 + t) * h * m[seg] +
          (-2 * t3 + 3 * t2) * pts[seg + 1][1] + (t3 - t2) * h * m[seg + 1];
    }
    lut[k] = Math.min(1, Math.max(0, y));
  }
  return lut;
}

export function sampleLUT(lut, x) {
  const f = Math.min(1, Math.max(0, x)) * LUT_SIZE;
  const i = Math.min(LUT_SIZE - 1, Math.floor(f));
  return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}

/**
 * Interactive editor on a canvas. Drag points, click to add one, double-click
 * (or drag far outside) to remove one.
 * @param {HTMLCanvasElement} canvas
 * @param {{points:number[][], onChange:(points:number[][], final:boolean)=>void, onHover:(x:number|null, y:number|null)=>void}} opts
 */
export function createCurveEditor(canvas, { points, onChange, onHover }) {
  const PAD = 9, HIT = 11, MIN_GAP = 0.01;
  let pts = points.map((p) => [...p]);
  let histogram = null;
  let active = -1;
  const ctx = canvas.getContext('2d');

  const box = () => ({ w: canvas.clientWidth - PAD * 2, h: canvas.clientHeight - PAD * 2 });
  const toPx = (p) => {
    const { w, h } = box();
    return [PAD + p[0] * w, PAD + (1 - p[1]) * h];
  };
  const fromEvent = (e) => {
    const r = canvas.getBoundingClientRect();
    const { w, h } = box();
    return [(e.clientX - r.left - PAD) / w, 1 - (e.clientY - r.top - PAD) / h];
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    if (canvas.width !== Math.round(cw * dpr)) canvas.width = Math.round(cw * dpr);
    if (canvas.height !== Math.round(ch * dpr)) canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const { w, h } = box();

    if (histogram) {
      const max = Math.max(...histogram) || 1;
      const bw = w / histogram.length;
      ctx.fillStyle = '#39404c';
      histogram.forEach((v, i) => {
        const bh = Math.sqrt(v / max) * h; // sqrt keeps small bins visible
        ctx.fillRect(PAD + i * bw, PAD + h - bh, Math.ceil(bw), bh);
      });
    }

    ctx.strokeStyle = '#2e333d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k <= 4; k++) {
      const x = Math.round(PAD + (w * k) / 4) + 0.5, y = Math.round(PAD + (h * k) / 4) + 0.5;
      ctx.moveTo(x, PAD); ctx.lineTo(x, PAD + h);
      ctx.moveTo(PAD, y); ctx.lineTo(PAD + w, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#4a5261';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD, PAD + h); ctx.lineTo(PAD + w, PAD);
    ctx.stroke();
    ctx.setLineDash([]);

    const lut = curveLUT(pts);
    ctx.strokeStyle = '#f0883e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= w; px++) {
      const y = PAD + (1 - sampleLUT(lut, px / w)) * h;
      px ? ctx.lineTo(PAD + px, y) : ctx.moveTo(PAD, y);
    }
    ctx.stroke();

    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      ctx.beginPath();
      ctx.arc(x, y, i === active ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = i === active ? '#f0883e' : '#fff';
      ctx.fill();
      ctx.strokeStyle = '#f0883e';
      ctx.stroke();
    });
  }

  const nearest = (e) => {
    const r = canvas.getBoundingClientRect();
    let best = -1, bestD = HIT;
    pts.forEach((p, i) => {
      const [x, y] = toPx(p);
      const dist = Math.hypot(e.clientX - r.left - x, e.clientY - r.top - y);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  };
  const emit = (final) => onChange(pts.map((p) => [+p[0].toFixed(4), +p[1].toFixed(4)]), final);

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    let i = nearest(e);
    if (i < 0) {
      const [x, y] = fromEvent(e);
      if (x <= pts[0][0] + MIN_GAP || x >= pts[pts.length - 1][0] - MIN_GAP) return;
      i = pts.findIndex((p) => p[0] > x);
      if (x - pts[i - 1][0] < MIN_GAP || pts[i][0] - x < MIN_GAP) return;
      pts.splice(i, 0, [x, clamp01(y)]);
      emit(false);
    }
    active = i;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = fromEvent(e);
    if (active < 0) {
      canvas.style.cursor = nearest(e) >= 0 ? 'grab' : 'crosshair';
      onHover?.(clamp01(x), sampleLUT(curveLUT(pts), x));
      return;
    }
    const inner = active > 0 && active < pts.length - 1;
    // dragging an inner point well outside the box removes it
    if (inner && (y < -0.25 || y > 1.25)) {
      pts.splice(active, 1);
      active = -1;
      emit(true);
      draw();
      return;
    }
    const lo = active > 0 ? pts[active - 1][0] + MIN_GAP : 0;
    const hi = active < pts.length - 1 ? pts[active + 1][0] - MIN_GAP : 1;
    pts[active] = [Math.min(hi, Math.max(lo, x)), clamp01(y)];
    onHover?.(pts[active][0], pts[active][1]);
    emit(false);
    draw();
  });
  const release = () => {
    if (active < 0) return;
    active = -1;
    emit(true);
    draw();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => active < 0 && onHover?.(null, null));
  canvas.addEventListener('dblclick', (e) => {
    const i = nearest(e);
    if (i <= 0 || i >= pts.length - 1) return;
    pts.splice(i, 1);
    emit(true);
    draw();
  });

  new ResizeObserver(draw).observe(canvas);
  draw();

  return {
    setPoints(next) {
      pts = next.map((p) => [...p]);
      draw();
    },
    setHistogram(h) {
      histogram = h;
      draw();
    },
  };
}
