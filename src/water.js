// Lakes and rivers from OpenStreetMap, via the public OpenFreeMap vector tiles
// (OpenMapTiles schema: polygons in "water", centre lines in "waterway").
import { mercX, mercY } from './elevation.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_ZOOM = 14;
const MAX_TILES = 40;
const RIVER_CLASSES = new Set(['river', 'canal']);

let template = null;
const cache = new Map();

const utf8 = new TextDecoder();

// ---- minimal protobuf / Mapbox Vector Tile reader

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  varint() {
    let v = 0, mul = 1, b;
    do {
      b = this.buf[this.pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }
  sub() {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error('Unsupported vector tile encoding');
  }
  /** Calls fn(field, wire, reader) for every field; fn returns true when it consumed the value. */
  fields(fn) {
    while (this.pos < this.end) {
      const tag = this.varint();
      if (!fn(tag >> 3, tag & 7, this)) this.skip(tag & 7);
    }
  }
  string() {
    const s = this.sub();
    return utf8.decode(s.buf.subarray(s.pos, s.end));
  }
}

function readLayer(r) {
  const layer = { name: '', extent: 4096, keys: [], values: [], features: [] };
  r.fields((f, wire) => {
    if (f === 1) layer.name = r.string();
    else if (f === 2) layer.features.push(r.sub());
    else if (f === 3) layer.keys.push(r.string());
    else if (f === 4) {
      // only string values matter here
      let val = null;
      r.sub().fields((vf, vw, vr) => {
        if (vf !== 1) return false;
        val = vr.string();
        return true;
      });
      layer.values.push(val);
    } else if (f === 5 && wire === 0) layer.extent = r.varint();
    else return false;
    return true;
  });
  return layer;
}

function readFeature(r, layer) {
  const props = {};
  let geom = null;
  r.fields((f) => {
    if (f === 2) {
      const s = r.sub();
      while (s.pos < s.end) {
        const k = s.varint(), v = s.varint();
        props[layer.keys[k]] = layer.values[v];
      }
    } else if (f === 4) geom = r.sub();
    else return false;
    return true;
  });
  // geometry -> list of rings/lines as flat [x, y, ...] in 0..1 tile units
  const paths = [];
  if (!geom) return { props, paths };
  let x = 0, y = 0, cur = null;
  const zz = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);
  while (geom.pos < geom.end) {
    const cmd = geom.varint();
    const id = cmd & 7;
    let count = cmd >> 3;
    if (id === 7) {
      if (cur) cur.closed = true;
      continue;
    }
    while (count-- > 0) {
      x += zz(geom.varint());
      y += zz(geom.varint());
      if (id === 1) paths.push((cur = { pts: [], closed: false }));
      cur.pts.push(x / layer.extent, y / layer.extent);
    }
  }
  return { props, paths };
}

/** @returns {{polys: object[], lines: object[]}} paths in 0..1 tile units */
export function decodeWaterTile(bytes) {
  const out = { polys: [], lines: [] };
  new Reader(bytes).fields((f, wire, r) => {
    if (f !== 3) return false;
    const layer = readLayer(r.sub());
    if (layer.name !== 'water' && layer.name !== 'waterway') return true;
    for (const fr of layer.features) {
      const { props, paths } = readFeature(fr, layer);
      if (layer.name === 'water') {
        if (props.class !== 'ocean') out.polys.push(...paths);
      } else if (RIVER_CLASSES.has(props.class) && props.brunnel !== 'tunnel') {
        out.lines.push(...paths);
      }
    }
    return true;
  });
  return out;
}

// ---- download

async function loadTile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  if (cache.has(key)) return cache.get(key);
  const n = 2 ** z;
  const url = template.replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
  const res = await fetch(url, { signal });
  // tiles without any data are simply missing
  const data = res.status === 404 || res.status === 204
    ? { polys: [], lines: [] }
    : res.ok
      ? decodeWaterTile(new Uint8Array(await res.arrayBuffer()))
      : null;
  if (!data) throw new Error(`Water tile ${key} failed (HTTP ${res.status})`);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, data);
  return data;
}

/** Download the water features covering the bounds. */
export async function fetchWater(b, res, { signal } = {}) {
  if (!template) {
    const r = await fetch(TILEJSON, { signal });
    if (!r.ok) throw new Error(`Water data unavailable (HTTP ${r.status})`);
    template = (await r.json()).tiles[0];
  }
  const x0 = mercX(b.west), x1 = mercX(b.east), y0 = mercY(b.north), y1 = mercY(b.south);
  let zoom = Math.min(MAX_ZOOM, Math.max(0, Math.ceil(Math.log2(res / (512 * Math.max(x1 - x0, y1 - y0))))));
  let tx0, tx1, ty0, ty1;
  for (; ; zoom--) {
    const n = 2 ** zoom;
    tx0 = Math.floor(x0 * n); tx1 = Math.floor(x1 * n);
    ty0 = Math.max(0, Math.floor(y0 * n)); ty1 = Math.min(n - 1, Math.floor(y1 * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= MAX_TILES || zoom === 0) break;
  }
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(loadTile(zoom, tx, ty, signal).then((data) => ({ x: tx, y: ty, ...data })));
    }
  }
  return { zoom, tiles: await Promise.all(jobs) };
}

/**
 * Rasterise the features to a mask on the model grid (1 = water), row 0 = north.
 * @param {number} riverPx  width of river centre lines in grid cells
 */
export function rasterizeWater(water, b, nx, ny, riverPx) {
  const x0 = mercX(b.west), y0 = mercY(b.north);
  const sx = (nx - 1) / (mercX(b.east) - x0), sy = (ny - 1) / (mercY(b.south) - y0);
  const n = 2 ** water.zoom;
  const canvas = new OffscreenCanvas(nx, ny);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.4, riverPx);

  for (const t of water.tiles) {
    // grid vertex i sits at the centre of mask pixel i
    const px = (u) => ((t.x + u) / n - x0) * sx + 0.5;
    const py = (v) => ((t.y + v) / n - y0) * sy + 0.5;
    const trace = (paths, close) => {
      ctx.beginPath();
      for (const p of paths) {
        for (let k = 0; k < p.pts.length; k += 2) {
          k ? ctx.lineTo(px(p.pts[k]), py(p.pts[k + 1])) : ctx.moveTo(px(p.pts[k]), py(p.pts[k + 1]));
        }
        if (close) ctx.closePath();
      }
    };
    // clip to the tile: features carry a buffer that overlaps the neighbours
    ctx.save();
    ctx.beginPath();
    ctx.rect(px(0), py(0), px(1) - px(0), py(1) - py(0));
    ctx.clip();
    trace(t.polys, true);
    ctx.fill();
    ctx.restore();
    trace(t.lines, false);
    ctx.stroke();
  }

  const data = ctx.getImageData(0, 0, nx, ny).data;
  const mask = new Uint8Array(nx * ny);
  for (let k = 0; k < mask.length; k++) mask[k] = data[k * 4 + 3] > 110 ? 1 : 0;
  return mask;
}
