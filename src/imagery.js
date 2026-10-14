// Satellite colours from the Esri World Imagery tiles, averaged onto the model grid.
import { mercX, mercY } from './elevation.js';

const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE = 256;
const MAX_ZOOM = 17;
const MAX_TILES = 64;

const cache = new Map();

async function loadTile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return cache.get(key);
  const n = 2 ** z;
  const url = TILE_URL.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Imagery tile ${key} failed (HTTP ${res.status})`);
  const bmp = await createImageBitmap(await res.blob());
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, bmp);
  return bmp;
}

/**
 * Mean satellite colour around every grid vertex.
 * @returns {Promise<Uint8Array>} r, g, b per vertex, row 0 = north
 */
export async function fetchImagery(b, nx, ny, { signal } = {}) {
  const x0 = mercX(b.west), x1 = mercX(b.east);
  const y0 = mercY(b.north), y1 = mercY(b.south);
  const w = x1 - x0, h = y1 - y0;
  // about two imagery pixels per grid sample
  let zoom = Math.min(MAX_ZOOM, Math.max(0, Math.ceil(Math.log2((2 * Math.max(nx, ny)) / (TILE * Math.max(w, h))))));
  let tx0, tx1, ty0, ty1;
  for (; ; zoom--) {
    const n = 2 ** zoom;
    tx0 = Math.floor(x0 * n); tx1 = Math.floor(x1 * n);
    ty0 = Math.max(0, Math.floor(y0 * n)); ty1 = Math.min(n - 1, Math.floor(y1 * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES || zoom === 0) break;
  }

  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const mw = cols * TILE, mh = rows * TILE;
  const canvas = new OffscreenCanvas(mw, mh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(loadTile(zoom, tx, ty, signal).then((bmp) => ctx.drawImage(bmp, (tx - tx0) * TILE, (ty - ty0) * TILE)));
    }
  }
  await Promise.all(jobs);
  const px = ctx.getImageData(0, 0, mw, mh).data;

  // every mosaic pixel adds to its nearest grid vertex
  const scale = TILE * 2 ** zoom;
  const sum = new Float64Array(nx * ny * 3);
  const count = new Uint32Array(nx * ny);
  const gi = (mx) => Math.round(((mx + tx0 * TILE + 0.5) / scale - x0) / w * (nx - 1));
  const gj = (my) => Math.round(((my + ty0 * TILE + 0.5) / scale - y0) / h * (ny - 1));
  const colOf = Int32Array.from({ length: mw }, (_, mx) => gi(mx));
  for (let my = 0; my < mh; my++) {
    const j = gj(my);
    if (j < 0 || j >= ny) continue;
    for (let mx = 0; mx < mw; mx++) {
      const i = colOf[mx];
      if (i < 0 || i >= nx) continue;
      const k = j * nx + i, p = (my * mw + mx) * 4;
      sum[k * 3] += px[p]; sum[k * 3 + 1] += px[p + 1]; sum[k * 3 + 2] += px[p + 2];
      count[k]++;
    }
  }

  // vertices without a pixel of their own (very small areas) take the nearest pixel
  const rgb = new Uint8Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (count[k]) {
        for (let c = 0; c < 3; c++) rgb[k * 3 + c] = Math.round(sum[k * 3 + c] / count[k]);
        continue;
      }
      const mx = Math.min(mw - 1, Math.max(0, Math.floor((x0 + (w * i) / (nx - 1)) * scale - tx0 * TILE)));
      const my = Math.min(mh - 1, Math.max(0, Math.floor((y0 + (h * j) / (ny - 1)) * scale - ty0 * TILE)));
      const p = (my * mw + mx) * 4;
      rgb[k * 3] = px[p]; rgb[k * 3 + 1] = px[p + 1]; rgb[k * 3 + 2] = px[p + 2];
    }
  }
  return rgb;
}
