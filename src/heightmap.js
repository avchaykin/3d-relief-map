// Elevation grid (metres) + print settings -> top-surface heights (mm) and colour bands.
// Everything is aligned to layer boundaries so each colour starts on a whole layer.

import { curveLUT, sampleLUT } from './curve.js';

function blur(src, nx, ny, passes) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < ny; j++) {
      const r = j * nx;
      for (let i = 0; i < nx; i++) {
        const l = a[r + Math.max(i - 1, 0)], c = a[r + i], rt = a[r + Math.min(i + 1, nx - 1)];
        b[r + i] = (l + 2 * c + rt) / 4;
      }
    }
    for (let j = 0; j < ny; j++) {
      const u = Math.max(j - 1, 0) * nx, r = j * nx, d = Math.min(j + 1, ny - 1) * nx;
      for (let i = 0; i < nx; i++) a[r + i] = (b[u + i] + 2 * b[r + i] + b[d + i]) / 4;
    }
  }
  return a;
}

/**
 * @param {Float32Array} elev  metres, row 0 = north
 * @param {object} p  { layerH, reliefLayers, baseMM, snap, seaMode, coastLayers,
 *                      smoothing, nColors, distribution, curve, waterMask, lakeLayers,
 *                      colorBy, groundDX, groundDY, imagery, landcover, landcoverDefs }
 *   seaMode: 'color' flat sea with its own colour | 'flat' flat sea | 'bathy' keep seabed
 *   waterMask: optional Uint8Array (1 = lake or river) on the same grid
 *   colorBy: 'height' (horizontal bands), or columns per grid triangle coloured by
 *            'slope' (needs groundDX/groundDY: metres per sample), 'satellite'
 *            (imagery: r, g, b per vertex) or 'landcover' (landcover: category per
 *            vertex, landcoverDefs: [{ name, color }])
 *
 * Returns z (top surface) and zLand: the surface the colour bands are cut from.
 * They differ only under lakes and rivers, where zLand is carved down by
 * lakeLayers so a water-coloured inlay (the volume in between) can sit in it.
 * With the per-triangle colourings it also returns cls (colour per grid triangle),
 * floor (top of the base plate, lowered under deep lakes) for buildFacets, and
 * autoColors (the palette, for satellite and land cover).
 */
export function computeModel(elev, nx, ny, p) {
  const n = nx * ny;
  const e = p.smoothing > 0 ? blur(elev, nx, ny, p.smoothing) : Float32Array.from(elev);
  const flatSea = p.seaMode !== 'bathy';

  let eMin = Infinity, eMax = -Infinity, seaCount = 0;
  for (let k = 0; k < n; k++) {
    if (flatSea && e[k] <= 0) {
      e[k] = 0;
      seaCount++;
    }
    if (e[k] < eMin) eMin = e[k];
    if (e[k] > eMax) eMax = e[k];
  }
  const hasSea = seaCount > 0 && eMax > 0;
  const seaBand = p.seaMode === 'color' && hasSea;

  const layerH = p.layerH;
  const R = Math.max(1, Math.round(p.reliefLayers));
  const baseLayers = Math.max(1, Math.round(p.baseMM / layerH));
  const base = baseLayers * layerH;
  const coast = seaBand ? Math.min(Math.max(1, Math.round(p.coastLayers)), R) : 0;
  const landH = (R - coast) * layerH;
  const e0 = hasSea ? 0 : eMin;
  const range = eMax - e0;

  // elevation -> 0..1 -> height curve -> model height
  const lut = curveLUT(p.curve);
  const histogram = new Array(64).fill(0);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let v;
    if (seaBand && e[k] <= 0) v = base;
    else {
      const t = range > 0 ? (e[k] - e0) / range : 0;
      if (!(hasSea && e[k] <= 0)) histogram[Math.min(63, Math.floor(t * 64))]++;
      v = base + coast * layerH + sampleLUT(lut, t) * landH;
    }
    z[k] = p.snap ? Math.round(v / layerH) * layerH : v;
  }

  // Colour bands, as layer indices. The first land band always includes the base plate.
  const top = baseLayers + R;
  const nColors = Math.max(1, Math.round(p.nColors));
  const isSea = (k) => seaBand && e[k] <= 0;
  let inland = 0;
  if (p.waterMask && nColors >= 2) {
    for (let k = 0; k < n; k++) if (p.waterMask[k] && !isSea(k)) inland++;
  }
  // colour 0 is water as soon as there is sea or inland water to show
  const waterColor = nColors >= 2 && (seaBand || inland > 0);
  const useSeaColor = seaBand && waterColor;
  const landColors = waterColor ? nColors - 1 : nColors;
  const landStart = baseLayers + coast;

  let zLand = z;
  const lakeMM = Math.max(1, Math.round(p.lakeLayers || 1)) * layerH;
  if (inland > 0) {
    zLand = Float64Array.from(z);
    for (let k = 0; k < n; k++) {
      if (!p.waterMask[k] || isSea(k)) continue;
      const v = Math.max(z[k] - lakeMM, layerH);
      zLand[k] = Math.min(z[k], p.snap ? Math.round(v / layerH) * layerH : v);
    }
  }

  const stats = {
    eMin, eMax, hasSea, seaBand: useSeaColor, waterColor,
    inlay: inland > 0, lakeMM,
    baseMM: base, baseLayers,
    reliefMM: R * layerH,
    totalMM: top * layerH, totalLayers: top,
    elevRange: range, landReliefMM: landH, e0, coastMM: coast * layerH, histogram,
    colorBy: CLASSIFY[p.colorBy] ? p.colorBy : 'height',
  };
  if (stats.colorBy !== 'height') {
    const { cls, bands, autoColors } = facetBands(
      CLASSIFY[stats.colorBy], e, nx, ny, p, isSea, useSeaColor, waterColor, landColors, nColors);
    // colour columns stand on the base plate, which takes the first band's colour
    const floor = new Float64Array(n);
    for (let k = 0; k < n; k++) floor[k] = Math.min(base, zLand[k]);
    return { z, zLand, bands, cls, floor, autoColors, stats };
  }

  let sorted = null;
  if (p.distribution === 'area' && landColors > 1) {
    const vals = [];
    for (let k = 0; k < n; k++) if (!useSeaColor || z[k] > base) vals.push(z[k]);
    sorted = Float64Array.from(vals).sort();
  }

  const starts = [useSeaColor ? baseLayers : 0];
  for (let c = 1; c < landColors; c++) {
    let b;
    if (sorted && sorted.length) {
      b = Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * c) / landColors))] / layerH);
    } else {
      b = landStart + Math.round(((top - landStart) * c) / landColors);
    }
    b = Math.max(b, starts[starts.length - 1] + 1, baseLayers + 1);
    if (b >= top) break;
    starts.push(b);
  }

  const bands = [];
  if (useSeaColor) bands.push({ color: 0, fromLayer: 0, toLayer: baseLayers });
  starts.forEach((s, i) => {
    bands.push({
      color: (waterColor ? 1 : 0) + i,
      fromLayer: i === 0 && !useSeaColor ? 0 : s,
      toLayer: i + 1 < starts.length ? starts[i + 1] : top,
    });
  });
  bands.forEach((b, i) => {
    b.lo = b.fromLayer * layerH;
    b.hi = i === bands.length - 1 ? Infinity : b.toLayer * layerH;
  });

  return { z, zLand, bands, stats };
}

// ---- colour per grid triangle (steepness, satellite, land cover)
// Triangle t of cell (i, j) is (j * (nx - 1) + i) * 2 + s, with corners
// s = 0: BL, BR, TR and s = 1: BL, TR, TL, as in buildFacets.

function forTriangles(nx, ny, fn) {
  const cw = nx - 1;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < cw; i++) {
      const tl = j * nx + i, tr = tl + 1, bl = tl + nx, br = bl + 1;
      const t = (j * cw + i) * 2;
      fn(t, bl, br, tr);
      fn(t + 1, bl, tr, tl);
    }
  }
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * Shared frame for the per-triangle colourings: sea triangles get the water colour,
 * classify() sorts the land triangles into at most `landColors` groups.
 * classify(ctx) returns { group: Int32Array per triangle, groups: [{ color?, ...meta }],
 * waterColor? } where ctx = { e, nx, ny, p, nt, land: Uint8Array (1 = land), landColors }.
 */
function facetBands(classify, e, nx, ny, p, isSea, useSeaColor, waterColor, landColors, nColors) {
  const nt = (nx - 1) * (ny - 1) * 2;
  const land = new Uint8Array(nt).fill(1);
  if (useSeaColor) {
    forTriangles(nx, ny, (t, a, b, c) => {
      if (isSea(a) && isSea(b) && isSea(c)) land[t] = 0;
    });
  }
  const res = classify({ e, nx, ny, p, nt, land, landColors });

  const first = waterColor ? 1 : 0;
  const cls = new Uint8Array(nt);
  const count = new Array(res.groups.length).fill(0);
  let seaCount = 0;
  for (let t = 0; t < nt; t++) {
    if (!land[t]) seaCount++;
    else {
      cls[t] = first + res.group[t];
      count[res.group[t]]++;
    }
  }

  const bands = [];
  if (seaCount) bands.push({ color: 0, sea: true, share: seaCount / nt });
  res.groups.forEach((g, i) => {
    if (count[i]) bands.push({ ...g, color: first + i, share: count[i] / nt });
  });

  // colourings that bring their own colours (satellite, land cover) fill the palette
  let autoColors = null;
  if (res.groups.every((g) => g.color)) {
    autoColors = [];
    if (waterColor) autoColors.push(res.waterColor || '#3a78b5');
    for (const g of res.groups) autoColors.push(g.color);
    while (autoColors.length < nColors) autoColors.push('#9a9a9a');
  }
  return { cls, bands, autoColors };
}

/** Real terrain slope (degrees), flattest first. */
function slopeClasses({ e, nx, ny, p, nt, land, landColors }) {
  const gdx = p.groundDX || 1, gdy = p.groundDY || 1; // metres per sample
  const slope = new Float32Array(nt);
  const cw = nx - 1;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < cw; i++) {
      const tl = j * nx + i, tr = tl + 1, bl = tl + nx, br = bl + 1;
      const t = (j * cw + i) * 2;
      slope[t] = Math.atan(Math.hypot((e[br] - e[bl]) / gdx, (e[tr] - e[br]) / gdy));
      slope[t + 1] = Math.atan(Math.hypot((e[tr] - e[tl]) / gdx, (e[tl] - e[bl]) / gdy));
    }
  }

  const vals = [];
  for (let t = 0; t < nt; t++) if (land[t]) vals.push(slope[t]);
  const sorted = Float32Array.from(vals).sort();
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
  // equal steps up to the 98th percentile, so a few cliffs do not squash the scale
  const top = at(0.98);
  const limits = [];
  for (let c = 1; c < landColors; c++) {
    const v = p.distribution === 'area' ? at(c / landColors) : (top * c) / landColors;
    if (v > (limits.length ? limits[limits.length - 1] : 0)) limits.push(v);
  }

  const group = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    let c = 0;
    while (c < limits.length && slope[t] >= limits[c]) c++;
    group[t] = c;
  }
  const deg = 180 / Math.PI;
  const groups = [];
  for (let c = 0; c <= limits.length; c++) {
    groups.push({ loDeg: c ? limits[c - 1] * deg : 0, hiDeg: c < limits.length ? limits[c] * deg : 90 });
  }
  return { group, groups };
}

// sRGB 0..255 -> CIE Lab, so that k-means groups colours the way the eye does
function toLab(r, g, b, out, o) {
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[o] = 116 * y - 16;
  out[o + 1] = 500 * (x - y);
  out[o + 2] = 200 * (y - z);
}

/** Satellite colours (p.imagery: r, g, b per vertex), reduced to landColors by k-means. */
function imageryClasses({ nx, ny, p, nt, land, landColors }) {
  const rgb = p.imagery;
  const group = new Int32Array(nt);
  if (!rgb) return { group, groups: [{ color: '#8f8f7f' }] };

  // mean colour per triangle, in sRGB and Lab
  const col = new Float32Array(nt * 3), lab = new Float32Array(nt * 3);
  let sea = [0, 0, 0], nSea = 0;
  forTriangles(nx, ny, (t, a, b, c) => {
    for (let ch = 0; ch < 3; ch++) col[t * 3 + ch] = (rgb[a * 3 + ch] + rgb[b * 3 + ch] + rgb[c * 3 + ch]) / 3;
    toLab(col[t * 3], col[t * 3 + 1], col[t * 3 + 2], lab, t * 3);
    if (!land[t]) {
      for (let ch = 0; ch < 3; ch++) sea[ch] += col[t * 3 + ch];
      nSea++;
    }
  });

  const landIdx = [];
  for (let t = 0; t < nt; t++) if (land[t]) landIdx.push(t);
  // fit on a sample, then assign every triangle
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const step = Math.max(1, Math.floor(landIdx.length / 30000));
  const sample = landIdx.filter((_, i) => i % step === 0);
  const k = Math.max(1, Math.min(landColors, sample.length));
  const dist = (t, c, C) => {
    const d0 = lab[t * 3] - C[c * 3], d1 = lab[t * 3 + 1] - C[c * 3 + 1], d2 = lab[t * 3 + 2] - C[c * 3 + 2];
    return d0 * d0 + d1 * d1 + d2 * d2;
  };
  const nearest = (t, C, kk) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < kk; c++) {
      const d = dist(t, c, C);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  // k-means++ start
  const C = new Float64Array(k * 3);
  if (sample.length) {
    const t0 = sample[Math.floor(rnd() * sample.length)];
    C.set(lab.subarray(t0 * 3, t0 * 3 + 3), 0);
    const d = new Float64Array(sample.length).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let total = 0;
      sample.forEach((t, i) => {
        d[i] = Math.min(d[i], dist(t, c - 1, C));
        total += d[i];
      });
      let r = rnd() * total, pick = sample[sample.length - 1];
      for (let i = 0; i < sample.length; i++) {
        if ((r -= d[i]) <= 0) { pick = sample[i]; break; }
      }
      C.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
    }
  }
  for (let iter = 0; iter < 20; iter++) {
    const acc = new Float64Array(k * 4);
    for (const t of sample) {
      const c = nearest(t, C, k);
      acc[c * 4] += lab[t * 3]; acc[c * 4 + 1] += lab[t * 3 + 1]; acc[c * 4 + 2] += lab[t * 3 + 2]; acc[c * 4 + 3]++;
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (!acc[c * 4 + 3]) continue;
      for (let ch = 0; ch < 3; ch++) {
        const v = acc[c * 4 + ch] / acc[c * 4 + 3];
        moved += Math.abs(v - C[c * 3 + ch]);
        C[c * 3 + ch] = v;
      }
    }
    if (moved < 0.01) break;
  }

  // assign, average the real colours, drop empty clusters, order dark to light
  const raw = new Int32Array(nt);
  const acc = new Float64Array(k * 4);
  for (const t of landIdx) {
    const c = nearest(t, C, k);
    raw[t] = c;
    for (let ch = 0; ch < 3; ch++) acc[c * 4 + ch] += col[t * 3 + ch];
    acc[c * 4 + 3]++;
  }
  const order = [...Array(k).keys()].filter((c) => acc[c * 4 + 3]).sort((a, b) => C[a * 3] - C[b * 3]);
  const slot = new Int32Array(k);
  order.forEach((c, i) => (slot[c] = i));
  for (const t of landIdx) group[t] = slot[raw[t]];
  const groups = order.map((c) => ({ color: hex(acc[c * 4] / acc[c * 4 + 3], acc[c * 4 + 1] / acc[c * 4 + 3], acc[c * 4 + 2] / acc[c * 4 + 3]) }));
  if (!groups.length) groups.push({ color: '#8f8f7f' });
  return { group, groups, waterColor: nSea ? hex(sea[0] / nSea, sea[1] / nSea, sea[2] / nSea) : null };
}

/**
 * Land cover categories (p.landcover: category per vertex, p.landcoverDefs: [{ name,
 * color }], 0 = open land). With more categories than colours, the rarest ones
 * become open land.
 */
function landcoverClasses({ nx, ny, p, nt, land, landColors }) {
  const defs = p.landcoverDefs || [{ name: 'Land', color: '#cdd59c' }];
  const cover = p.landcover;
  const cat = new Uint8Array(nt);
  const count = new Array(defs.length).fill(0);
  forTriangles(nx, ny, (t, a, b, c) => {
    if (!cover) return;
    const ca = cover[a], cb = cover[b], cc = cover[c];
    // majority of the corners; with three different ones the later category wins
    cat[t] = ca === cb || ca === cc ? ca : cb === cc ? cb : Math.max(ca, cb, cc);
    if (land[t]) count[cat[t]]++;
  });
  const present = [...count.keys()].filter((c) => count[c]);
  let kept = present;
  if (present.length > landColors) {
    const others = present.filter((c) => c !== 0).sort((a, b) => count[b] - count[a]).slice(0, landColors - 1);
    kept = [0, ...others].sort((a, b) => a - b);
  }
  if (!kept.length) kept = [0];
  const slot = new Int32Array(defs.length).fill(kept.includes(0) ? kept.indexOf(0) : 0);
  kept.forEach((c, i) => (slot[c] = i));
  const group = new Int32Array(nt);
  for (let t = 0; t < nt; t++) group[t] = slot[cat[t]];
  return { group, groups: kept.map((c) => ({ name: defs[c].name, color: defs[c].color })), waterColor: '#5d9bd1' };
}

const CLASSIFY = { slope: slopeClasses, satellite: imageryClasses, landcover: landcoverClasses };
