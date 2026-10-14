// Lakes, rivers and land cover from OpenStreetMap, via the public OpenFreeMap vector
// tiles (OpenMapTiles schema: polygons in "water", centre lines in "waterway",
// land cover polygons in "landcover" and "landuse", roads in "transportation").
import { mercX, mercY } from './elevation.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const MAX_ZOOM = 14;
const MAX_TILES = 40;
const MAX_TILES_LANDCOVER = 48; // about 350 kB each
const RIVER_CLASSES = new Set(['river', 'canal']);

/** Land cover categories, in drawing order: later ones win where they overlap. */
export const LANDCOVER = [
  { name: 'Open land', color: '#cdd59c' },
  { name: 'Farmland', color: '#e9dc98' },
  { name: 'Built-up', color: '#c4605a' },
  { name: 'Grass & meadow', color: '#9cc96b' },
  { name: 'Wetland', color: '#79ae9c' },
  { name: 'Forest', color: '#3d7537' },
  { name: 'Rock & sand', color: '#b5a790' },
  { name: 'Ice & glacier', color: '#f2f6f8' },
  { name: 'Major roads', color: '#46464a' },
];
const ROADS = LANDCOVER.length - 1;
const URBAN = 2;
const COVER_CLASS = { farmland: 1, grass: 3, wetland: 4, wood: 5, rock: 6, sand: 6, ice: 7 };
const URBAN_CLASS = new Set(['residential', 'commercial', 'industrial', 'retail', 'railway', 'garages']);
// whole districts: only a stand-in where low-zoom tiles carry no residential areas
const DISTRICT_CLASS = new Set(['suburb', 'neighbourhood', 'quarter']);
const DETAIL_ZOOM = 10;
const ROAD_CLASS = new Set(['motorway', 'trunk', 'primary']);

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

/**
 * @returns {{polys: object[], lines: object[], cover: object[][]}} paths in 0..1 tile
 *   units; cover[c] holds the polygons (lines for roads) of LANDCOVER category c
 */
export function decodeWaterTile(bytes, zoom = MAX_ZOOM) {
  const out = { polys: [], lines: [], cover: LANDCOVER.map(() => []) };
  const LAYERS = new Set(['water', 'waterway', 'landcover', 'landuse', 'transportation']);
  new Reader(bytes).fields((f, wire, r) => {
    if (f !== 3) return false;
    const layer = readLayer(r.sub());
    if (!LAYERS.has(layer.name)) return true;
    for (const fr of layer.features) {
      const { props, paths } = readFeature(fr, layer);
      if (layer.name === 'water') {
        if (props.class !== 'ocean') out.polys.push(...paths);
      } else if (layer.name === 'waterway') {
        if (RIVER_CLASSES.has(props.class) && props.brunnel !== 'tunnel') out.lines.push(...paths);
      } else if (layer.name === 'landcover') {
        const c = COVER_CLASS[props.class];
        if (c) out.cover[c].push(...paths);
      } else if (layer.name === 'landuse') {
        if (URBAN_CLASS.has(props.class) || (zoom < DETAIL_ZOOM && DISTRICT_CLASS.has(props.class))) {
          out.cover[URBAN].push(...paths);
        }
      } else if (ROAD_CLASS.has(props.class) && props.brunnel !== 'tunnel') {
        out.cover[ROADS].push(...paths);
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
    ? { polys: [], lines: [], cover: LANDCOVER.map(() => []) }
    : res.ok
      ? decodeWaterTile(new Uint8Array(await res.arrayBuffer()), z)
      : null;
  if (!data) throw new Error(`Map tile ${key} failed (HTTP ${res.status})`);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, data);
  return data;
}

/**
 * Download the water and land cover features covering the bounds.
 * With `landcover` the tiles are at least zoom 7, where land cover starts.
 */
export async function fetchWater(b, res, { signal, landcover = false } = {}) {
  if (!template) {
    const r = await fetch(TILEJSON, { signal });
    if (!r.ok) throw new Error(`Map data unavailable (HTTP ${r.status})`);
    template = (await r.json()).tiles[0];
  }
  const x0 = mercX(b.west), x1 = mercX(b.east), y0 = mercY(b.north), y1 = mercY(b.south);
  const maxTiles = landcover ? MAX_TILES_LANDCOVER : MAX_TILES;
  let zoom = Math.max(0, Math.ceil(Math.log2(res / (512 * Math.max(x1 - x0, y1 - y0)))));
  zoom = Math.min(MAX_ZOOM, landcover ? Math.max(zoom, 8) : zoom);
  let tx0, tx1, ty0, ty1;
  for (; ; zoom--) {
    const n = 2 ** zoom;
    tx0 = Math.floor(x0 * n); tx1 = Math.floor(x1 * n);
    ty0 = Math.max(0, Math.floor(y0 * n)); ty1 = Math.min(n - 1, Math.floor(y1 * n));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= maxTiles || zoom === 0) break;
  }
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(loadTile(zoom, tx, ty, signal).then((data) => ({ x: tx, y: ty, ...data })));
    }
  }
  return { zoom, tiles: await Promise.all(jobs) };
}

// Draws tile features onto a canvas whose pixel i is grid vertex i, row 0 = north.
function featureCanvas(water, b, nx, ny) {
  const x0 = mercX(b.west), y0 = mercY(b.north);
  const sx = (nx - 1) / (mercX(b.east) - x0), sy = (ny - 1) / (mercY(b.south) - y0);
  const n = 2 ** water.zoom;
  const canvas = new OffscreenCanvas(nx, ny);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineJoin = ctx.lineCap = 'round';

  /** Fills polys(tile) and strokes lines(tile) with the current style. */
  const draw = (polys, lines) => {
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
      trace(polys(t), true);
      ctx.fill();
      ctx.restore();
      trace(lines(t), false);
      ctx.stroke();
    }
  };
  const mask = (onto, value) => {
    const data = ctx.getImageData(0, 0, nx, ny).data;
    for (let k = 0; k < onto.length; k++) if (data[k * 4 + 3] > 110) onto[k] = value;
  };
  return { ctx, draw, mask };
}

/**
 * Rasterise the water features to a mask on the model grid (1 = water), row 0 = north.
 * @param {number} riverPx  width of river centre lines in grid cells
 */
export function rasterizeWater(water, b, nx, ny, riverPx) {
  const { ctx, draw, mask } = featureCanvas(water, b, nx, ny);
  ctx.lineWidth = Math.max(1.4, riverPx);
  draw((t) => t.polys, (t) => t.lines);
  const out = new Uint8Array(nx * ny);
  mask(out, 1);
  return out;
}

/**
 * Rasterise the land cover to LANDCOVER indices on the model grid, row 0 = north.
 * @param {number} roadPx  width of roads in grid cells, 0 to leave roads out
 */
export function rasterizeLandcover(water, b, nx, ny, roadPx) {
  const { ctx, draw, mask } = featureCanvas(water, b, nx, ny);
  const out = new Uint8Array(nx * ny);
  const none = () => [];
  for (let c = 1; c < LANDCOVER.length; c++) {
    ctx.clearRect(0, 0, nx, ny);
    if (c === ROADS) {
      if (!roadPx) continue;
      ctx.lineWidth = Math.max(1.2, roadPx);
      draw(none, (t) => t.cover[c]);
    } else {
      draw((t) => t.cover[c], none);
    }
    mask(out, c);
  }
  return out;
}
