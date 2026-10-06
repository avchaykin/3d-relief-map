// Elevation from the public "Terrarium" terrain tiles (Mapzen / AWS Open Data).
// height in metres = R * 256 + G + B / 256 - 32768
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TILE = 256;
const MAX_ZOOM = 14;
const MAX_TILES = 90;
const EARTH = 40075016.686;

const cache = new Map();

export const mercX = (lon) => (lon + 180) / 360;
export const mercY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** Real-world size of the selection in metres. */
export function groundSize(b) {
  const lat = ((b.north + b.south) / 2) * (Math.PI / 180);
  return {
    width: (mercX(b.east) - mercX(b.west)) * EARTH * Math.cos(lat),
    height: (mercY(b.south) - mercY(b.north)) * EARTH * Math.cos(lat),
  };
}

async function loadTile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return cache.get(key);
  const n = 2 ** z;
  const url = TILE_URL.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Elevation tile ${key} failed (HTTP ${res.status})`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const h = new Float32Array(TILE * TILE);
  for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  cache.set(key, h);
  return h;
}

/**
 * Sample a regular grid of elevations over the bounds.
 * @param {{north:number,south:number,east:number,west:number}} b
 * @param {number} res  samples along the longer side
 * @returns {Promise<{elev:Float32Array,nx:number,ny:number,zoom:number}>} row 0 = north
 */
export async function fetchElevation(b, res, { signal, onProgress } = {}) {
  const x0 = mercX(b.west), x1 = mercX(b.east);
  const y0 = mercY(b.north), y1 = mercY(b.south);
  const w = x1 - x0, h = y1 - y0;
  const nx = w >= h ? res : Math.max(2, Math.round((res * w) / h));
  const ny = w >= h ? Math.max(2, Math.round((res * h) / w)) : res;

  let zoom = Math.min(MAX_ZOOM, Math.max(0, Math.ceil(Math.log2(res / (TILE * Math.max(w, h))))));
  let tx0, tx1, ty0, ty1;
  for (; ; zoom--) {
    const n = 2 ** zoom;
    tx0 = Math.floor(x0 * n); tx1 = Math.floor(x1 * n);
    ty0 = Math.max(0, Math.floor(y0 * n)); ty1 = Math.min(n - 1, Math.floor(y1 * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES || zoom === 0) break;
  }

  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const mw = cols * TILE, mh = rows * TILE;
  const mosaic = new Float32Array(mw * mh);
  let done = 0;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(loadTile(zoom, tx, ty, signal).then((t) => {
        const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
        for (let r = 0; r < TILE; r++) mosaic.set(t.subarray(r * TILE, (r + 1) * TILE), (oy + r) * mw + ox);
        onProgress?.(++done, cols * rows);
      }));
    }
  }
  await Promise.all(jobs);

  const scale = TILE * 2 ** zoom;
  const elev = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const py = Math.min(mh - 1, Math.max(0, (y0 + (h * j) / (ny - 1)) * scale - ty0 * TILE - 0.5));
    const jy = Math.min(mh - 2, Math.floor(py)), fy = py - jy;
    for (let i = 0; i < nx; i++) {
      const px = Math.min(mw - 1, Math.max(0, (x0 + (w * i) / (nx - 1)) * scale - tx0 * TILE - 0.5));
      const ix = Math.min(mw - 2, Math.floor(px)), fx = px - ix;
      const k = jy * mw + ix;
      elev[j * nx + i] =
        (mosaic[k] * (1 - fx) + mosaic[k + 1] * fx) * (1 - fy) +
        (mosaic[k + mw] * (1 - fx) + mosaic[k + mw + 1] * fx) * fy;
    }
  }
  return { elev, nx, ny, zoom };
}
