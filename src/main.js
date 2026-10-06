import { createMap, searchPlace } from './map.js';
import { createPreview } from './preview.js';
import { fetchElevation, groundSize } from './elevation.js';
import { fetchWater, rasterizeWater } from './water.js';
import { computeModel } from './heightmap.js';
import { PRESETS, makePalette } from './palettes.js';
import { CURVE_PRESETS, createCurveEditor } from './curve.js';
import { toSTL, to3MF, toOBJZip, toZip, download } from './exporters.js';
import { strToU8 } from 'fflate';

const STORAGE_KEY = 'relief-map-settings-v1';
const DEFAULTS = {
  bounds: { south: 35.25, north: 35.47, west: 138.59, east: 138.87 }, // Mount Fuji
  basemap: 'topo',
  sizeMM: 150,
  resolution: 220,
  smoothing: 1,
  seaMode: 'color',
  coastLayers: 2,
  inlandWater: true,
  lakeLayers: 3,
  riverMM: 0.8,
  layerH: 0.2,
  reliefLayers: 60,
  baseMM: 1.2,
  snap: false,
  nColors: 4,
  preset: 'natural',
  distribution: 'height',
  colors: null, // set once the user edits a swatch
  curve: CURVE_PRESETS.linear.points,
};

const state = { ...DEFAULTS };
try {
  Object.assign(state, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
} catch { /* storage unavailable: defaults */ }
const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
};

const $ = (sel) => document.querySelector(sel);
const fmt = (v, d = 1) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------------------------------------------------------------- status

const statusEl = $('#status');
function setStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', isError);
}

// ---------------------------------------------------------------- mesh worker

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let jobId = 0;
worker.onmessage = (ev) => {
  pending.get(ev.data.id)?.resolve(ev.data);
  pending.delete(ev.data.id);
};
worker.onerror = (ev) => {
  for (const p of pending.values()) p.reject(new Error(ev.message || 'Mesh worker failed'));
  pending.clear();
};
/** Resolves to { meshes: one per band, inlay: solid between grid.z and zTop (or null) }. */
function buildMeshes(grid, bands, zTop = null) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...grid, zTop, bands: bands.map((b) => ({ lo: b.lo, hi: b.hi })) });
  });
}

// ---------------------------------------------------------------- pipeline

const preview = createPreview($('#preview'));
let elevation = null; // { elev, nx, ny, zoom }
let model = null;     // computeModel() result
let water = null;     // lake and river features for the current bounds
let waterNote = '';
let grid = null;      // { z, nx, ny, dx, dy } of the full top surface
let size = null;      // { width, depth, height } in mm
let parts = [];       // [{ color, label, tris }] one closed part per palette colour in use
let paletteHasWater = true;
let fetchAbort = null;
let buildSeq = 0;

function palette() {
  if (state.colors?.length === state.nColors) return state.colors;
  return makePalette(state.preset, state.nColors, paletteHasWater);
}

async function loadElevation() {
  fetchAbort?.abort();
  const abort = (fetchAbort = new AbortController());
  setStatus('Loading elevation…');
  try {
    // lakes and rivers are optional: without them the model is still built
    const waterJob = state.inlandWater
      ? fetchWater(state.bounds, state.resolution, { signal: abort.signal }).then(
        (w) => ((waterNote = ''), w),
        (err) => {
          if (!abort.signal.aborted) {
            console.error(err);
            waterNote = `Lakes and rivers could not be loaded (${err.message}).`;
          }
          return null;
        })
      : ((waterNote = ''), null);
    const elevationJob = fetchElevation(state.bounds, state.resolution, {
      signal: abort.signal,
      onProgress: (done, total) => setStatus(`Loading elevation… ${done}/${total} tiles`),
    });
    const [e, w] = await Promise.all([elevationJob, waterJob]);
    if (abort.signal.aborted) return;
    elevation = e;
    water = w;
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error(err);
    setStatus(`Could not load elevation data: ${err.message}`, true);
    return;
  }
  await rebuild();
}

async function rebuild() {
  if (!elevation) return;
  const seq = ++buildSeq;
  const { elev, nx, ny } = elevation;
  const ground = groundSize(state.bounds);
  const ratio = ground.width / ground.height;
  const width = ratio >= 1 ? state.sizeMM : state.sizeMM * ratio;
  const depth = ratio >= 1 ? state.sizeMM / ratio : state.sizeMM;
  const dx = width / (nx - 1), dy = depth / (ny - 1);

  const waterMask = state.inlandWater && water
    ? rasterizeWater(water, state.bounds, nx, ny, state.riverMM / dx)
    : null;
  model = computeModel(elev, nx, ny, { ...state, waterMask });
  paletteHasWater = model.stats.waterColor;
  const nextGrid = { z: model.z, nx, ny, dx, dy };
  const nextSize = { width, depth, height: model.stats.totalMM };

  renderFacts(ground, nextSize);
  renderBands();
  curveEditor.setHistogram(model.stats.histogram);
  $('#curve-min').textContent = `${fmt(model.stats.e0, 0)} m`;
  $('#curve-max').textContent = `${fmt(model.stats.eMax, 0)} m`;
  setStatus('Building model…');
  let built;
  try {
    // colour bands are cut from the carved surface, the inlay fills the carving
    built = await buildMeshes({ ...nextGrid, z: model.zLand }, model.bands, model.stats.inlay ? model.z : null);
  } catch (err) {
    console.error(err);
    setStatus(`Could not build the model: ${err.message}`, true);
    return;
  }
  if (seq !== buildSeq) return;
  grid = nextGrid;
  size = nextSize;
  const next = model.bands.map((b, i) => ({ color: b.color, label: bandLabel(b), tris: built.meshes[i] }));
  if (built.inlay) {
    const sea = next.find((p) => p.color === 0);
    if (sea) {
      const both = new Float32Array(sea.tris.length + built.inlay.length);
      both.set(sea.tris);
      both.set(built.inlay, sea.tris.length);
      sea.tris = both;
    } else next.unshift({ color: 0, label: 'Water', tris: built.inlay });
  }
  parts = next.filter((p) => p.tris.length);
  const colors = palette();
  preview.setModel(parts.map((p) => ({ tris: p.tris, color: colors[p.color] })), size);
  const tris = parts.reduce((sum, p) => sum + p.tris.length / 9, 0);
  $('#export-hint').textContent =
    `${tris.toLocaleString('en-US')} triangles in ${parts.length} part${parts.length > 1 ? 's' : ''}. ` +
    'Every part is a closed solid.';
  setStatus('');
}

let rebuildTimer = 0;
const scheduleRebuild = () => {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
};

// ---------------------------------------------------------------- readouts

const facts = (el, rows) => {
  el.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    return [dt, dd];
  }));
};

function renderAreaFacts(bounds = state.bounds) {
  const g = groundSize(bounds);
  const lat = (v) => `${fmt(Math.abs(v), 3)}°${v >= 0 ? 'N' : 'S'}`;
  const lng = (v) => `${fmt(Math.abs(v), 3)}°${v >= 0 ? 'E' : 'W'}`;
  const rows = [
    ['Corner SW', `${lat(bounds.south)}, ${lng(bounds.west)}`],
    ['Corner NE', `${lat(bounds.north)}, ${lng(bounds.east)}`],
    ['Ground size', `${fmt(g.width / 1000)} × ${fmt(g.height / 1000)} km`],
  ];
  if (model && bounds === state.bounds) {
    rows.push(['Elevation', `${fmt(model.stats.eMin, 0)} to ${fmt(model.stats.eMax, 0)} m`]);
  }
  facts($('#area-facts'), rows);
}

function renderFacts(ground, sz) {
  renderAreaFacts();
  const s = model.stats;
  const hScale = (ground.width * 1000) / sz.width;
  const rows = [
    ['Print size', `${fmt(sz.width)} × ${fmt(sz.depth)} × ${fmt(sz.height, 2)} mm`],
    ['Layers', `${s.baseLayers} base + ${s.totalLayers - s.baseLayers} relief`],
    ['Map scale', `1 : ${Math.round(hScale).toLocaleString('en-US')}`],
  ];
  if (s.elevRange > 0 && s.landReliefMM > 0) {
    rows.push(['Vertical exaggeration', `× ${fmt((s.landReliefMM / (s.elevRange * 1000)) * hScale, 1)}`]);
  }
  rows.push(['Ground per sample', `${fmt(ground.width / (elevation.nx - 1), 0)} m`]);
  facts($('#print-facts'), rows);
  $('#coast-row').hidden = state.seaMode !== 'color';
  for (const el of document.querySelectorAll('.lake-row')) el.hidden = !state.inlandWater;
}

function bandLabel(band) {
  if (model.stats.seaBand && band.color === 0) return model.stats.inlay ? 'Water + base' : 'Sea + base';
  return `Color ${band.color + 1}`;
}

function renderBands() {
  const colors = palette();
  const used = new Map(model.bands.map((b) => [b.color, b]));
  const list = $('#bands');
  list.replaceChildren(...colors.map((c, i) => {
    const li = document.createElement('li');
    const band = used.get(i);
    const input = document.createElement('input');
    input.type = 'color';
    input.value = c;
    input.setAttribute('aria-label', `Color ${i + 1}`);
    input.addEventListener('input', () => {
      state.colors = palette().slice();
      state.colors[i] = input.value;
      preview.setColors(parts.map((p) => state.colors[p.color]));
      save();
    });
    const name = document.createElement('span');
    const where = document.createElement('span');
    where.className = 'where';
    if (band) {
      name.textContent = bandLabel(band);
      where.textContent = `layers ${band.fromLayer + 1}–${band.toLayer} · z ${fmt(band.lo, 2)} mm`;
    } else if (i === 0 && model.stats.inlay) {
      name.textContent = 'Water';
      where.textContent = `lakes, rivers · inlaid ${fmt(model.stats.lakeMM, 2)} mm`;
    } else {
      li.className = 'unused';
      name.textContent = `Color ${i + 1}`;
      where.textContent = 'not used';
    }
    li.append(input, name, where);
    return li;
  }));
  const hint = [];
  const usedColors = model.bands.length + (model.stats.inlay && !model.stats.seaBand ? 1 : 0);
  if (usedColors < colors.length) hint.push('Not enough relief layers for every color — add layers or use fewer colors.');
  if (model.bands.length > 1) {
    hint.push('Single-nozzle printer: export the STL and change filament at the first layer of each color.');
  }
  if (model.stats.inlay) {
    hint.push('Lakes and rivers are inlaid at their own height, so they need a multi-material printer (3MF or STL per color); the single-body STL has no separate water.');
  }
  if (waterNote) hint.push(waterNote);
  $('#bands-hint').textContent = hint.join(' ');
}

// ---------------------------------------------------------------- settings

const presetSelect = $('#preset');
for (const [key, p] of Object.entries(PRESETS)) presetSelect.add(new Option(p.name, key));

const AFFECTS_ELEVATION = new Set(['resolution', 'inlandWater']);
const RESETS_COLORS = new Set(['nColors', 'preset']);

for (const input of document.querySelectorAll('[data-param]')) {
  const key = input.dataset.param;
  const output = document.querySelector(`output[data-for="${key}"]`);
  const show = () => output && (output.textContent = input.value);
  if (input.type === 'checkbox') input.checked = state[key];
  else input.value = state[key];
  show();

  const read = () => {
    if (input.type === 'checkbox') return input.checked;
    if (input.type !== 'number' && input.type !== 'range') return input.value;
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) return null;
    v = Math.min(+input.max, Math.max(+input.min, v));
    return v;
  };
  const apply = (final) => {
    const v = read();
    show();
    if (v === null || v === state[key]) return;
    state[key] = v;
    if (RESETS_COLORS.has(key)) state.colors = null;
    save();
    if (key === 'basemap') mapView.setBasemap(v);
    else if (AFFECTS_ELEVATION.has(key)) final && loadElevation();
    else scheduleRebuild();
  };
  // sliders update live, except those that trigger a download
  input.addEventListener('input', () => {
    if (input.type === 'range') AFFECTS_ELEVATION.has(key) ? show() : apply(false);
  });
  input.addEventListener('change', () => {
    apply(true);
    if (input.type === 'number' && read() !== null) input.value = state[key];
  });
}

// ---------------------------------------------------------------- height curve

const curvePreset = $('#curve-preset');
for (const [key, p] of Object.entries(CURVE_PRESETS)) curvePreset.add(new Option(p.name, key));
curvePreset.add(new Option('Custom', 'custom'));
const syncCurvePreset = () => {
  const cur = JSON.stringify(state.curve);
  const hit = Object.entries(CURVE_PRESETS).find(([, p]) => JSON.stringify(p.points) === cur);
  curvePreset.value = hit ? hit[0] : 'custom';
};
syncCurvePreset();

const curveEditor = createCurveEditor($('#curve'), {
  points: state.curve,
  onChange(points) {
    state.curve = points;
    syncCurvePreset();
    save();
    scheduleRebuild();
  },
  onHover(x, y) {
    const out = $('#curve-readout');
    if (x === null || !model) return void (out.textContent = '');
    const s = model.stats;
    out.textContent = `${fmt(s.e0 + x * s.elevRange, 0)} m → ${fmt(s.baseMM + s.coastMM + y * s.landReliefMM, 2)} mm`;
  },
});
const setCurve = (key) => {
  state.curve = CURVE_PRESETS[key].points.map((p) => [...p]);
  curveEditor.setPoints(state.curve);
  syncCurvePreset();
  save();
  scheduleRebuild();
};
curvePreset.addEventListener('change', () => (curvePreset.value === 'custom' ? syncCurvePreset() : setCurve(curvePreset.value)));
$('#curve-reset').addEventListener('click', () => setCurve('linear'));

// ---------------------------------------------------------------- map

const mapView = createMap($('#map'), {
  bounds: state.bounds,
  basemap: state.basemap,
  onChange(bounds, final) {
    if (!final) return renderAreaFacts(bounds);
    state.bounds = bounds;
    save();
    renderAreaFacts();
    loadElevation();
  },
});

const drawBtn = $('#draw');
drawBtn.addEventListener('click', () => {
  if (drawBtn.classList.contains('active')) return mapView.cancelDraw();
  drawBtn.classList.add('active');
  drawBtn.textContent = 'Drag on the map…';
  mapView.startDraw(() => {
    drawBtn.classList.remove('active');
    drawBtn.textContent = 'Draw area';
  });
});
$('#select-view').addEventListener('click', () => mapView.selectView());
$('#focus').addEventListener('click', () => mapView.focusSelection());
$('#reset-view').addEventListener('click', () => size && preview.resetView(size));

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const hit = await searchPlace(q);
    if (hit) mapView.flyTo(hit);
    else $('#search-input').setCustomValidity('No place found');
  } catch (err) {
    $('#search-input').setCustomValidity(err.message);
  }
  $('#search-input').reportValidity();
  btn.disabled = false;
});
$('#search-input').addEventListener('input', (e) => e.target.setCustomValidity(''));

// ---------------------------------------------------------------- export

function fileBase() {
  const b = state.bounds;
  const c = (v, pos, neg) => `${Math.abs(v).toFixed(2)}${v >= 0 ? pos : neg}`;
  return `relief_${c((b.north + b.south) / 2, 'N', 'S')}_${c((b.east + b.west) / 2, 'E', 'W')}`;
}

function namedParts() {
  const colors = palette();
  return parts.map((p) => ({ name: `${p.label} ${colors[p.color]}`, color: colors[p.color], tris: p.tris }));
}

function changeList() {
  const colors = palette();
  const lines = [
    '3D Relief Map - filament plan',
    `Layer height ${state.layerH} mm, ${model.stats.totalLayers} layers, total height ${model.stats.totalMM.toFixed(2)} mm`,
    `Print size ${size.width.toFixed(1)} x ${size.depth.toFixed(1)} mm`,
    '',
  ];
  model.bands.forEach((b) => {
    lines.push(
      `${bandLabel(b)} (${colors[b.color]}): layers ${b.fromLayer + 1}-${b.toLayer}, ` +
      `starts at z = ${b.lo.toFixed(2)} mm`,
    );
  });
  if (model.stats.inlay) {
    lines.push(
      `Water (${colors[0]}) also fills lakes and rivers: the top ${model.stats.lakeMM.toFixed(2)} mm of the surface there, ` +
      'at any height. This needs a multi-material printer.',
    );
  }
  lines.push('', 'Layer numbers assume every layer, including the first, uses the layer height above.');
  return lines.join('\n') + '\n';
}

const exporters = {
  async stl() {
    const solid = (await buildMeshes(grid, [{ lo: 0, hi: Infinity }])).meshes;
    download(toSTL(solid), `${fileBase()}.stl`, 'model/stl');
  },
  async 'stl-zip'() {
    const files = { 'filament-plan.txt': strToU8(changeList()) };
    namedParts().forEach((p, i) => {
      files[`${fileBase()}_${i + 1}_${p.color.slice(1)}.stl`] = toSTL([p.tris], p.name);
    });
    download(toZip(files), `${fileBase()}_stl.zip`, 'application/zip');
  },
  async '3mf'() {
    download(to3MF(namedParts(), fileBase()), `${fileBase()}.3mf`, 'model/3mf');
  },
  async obj() {
    download(toOBJZip(namedParts(), fileBase()), `${fileBase()}_obj.zip`, 'application/zip');
  },
};

const exportButtons = [...document.querySelectorAll('[data-export]')];
for (const btn of exportButtons) {
  btn.addEventListener('click', async () => {
    if (!parts.length) return;
    exportButtons.forEach((b) => (b.disabled = true));
    setStatus('Preparing file…');
    await new Promise((r) => setTimeout(r, 30)); // let the status paint
    try {
      await exporters[btn.dataset.export]();
      setStatus('');
    } catch (err) {
      console.error(err);
      setStatus(`Export failed: ${err.message}`, true);
    }
    exportButtons.forEach((b) => (b.disabled = false));
  });
}

// ---------------------------------------------------------------- start

renderAreaFacts();
loadElevation();
