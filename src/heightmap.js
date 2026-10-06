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
 *                      smoothing, nColors, distribution, curve, waterMask, lakeLayers }
 *   seaMode: 'color' flat sea with its own colour | 'flat' flat sea | 'bathy' keep seabed
 *   waterMask: optional Uint8Array (1 = lake or river) on the same grid
 *
 * Returns z (top surface) and zLand: the surface the colour bands are cut from.
 * They differ only under lakes and rivers, where zLand is carved down by
 * lakeLayers so a water-coloured inlay (the volume in between) can sit in it.
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

  return {
    z,
    zLand,
    bands,
    stats: {
      eMin, eMax, hasSea, seaBand: useSeaColor, waterColor,
      inlay: inland > 0, lakeMM,
      baseMM: base, baseLayers,
      reliefMM: R * layerH,
      totalMM: top * layerH, totalLayers: top,
      elevRange: range, landReliefMM: landH, e0, coastMM: coast * layerH, histogram,
    },
  };
}
