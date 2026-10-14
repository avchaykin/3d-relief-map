// Run with: node test/mesher.test.mjs
// Checks that every generated band is a closed, outward-facing solid and that the
// bands together fill exactly the same volume as the one-piece model.
import assert from 'node:assert/strict';
import { buildBand, buildFacets, buildInlay } from '../src/mesher.js';
import { computeModel } from '../src/heightmap.js';
import { weld } from '../src/exporters.js';

function volume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    v += t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7])
       - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6])
       + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6]);
  }
  return v / 6;
}

// Every directed edge must be matched by the same number of opposite edges.
function openEdges(t) {
  const { vertices, indices } = weld(t);
  const count = new Map();
  const nv = vertices.length / 3;
  for (let i = 0; i < indices.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[i + e], b = indices[i + ((e + 1) % 3)];
      const fwd = a * nv + b, rev = b * nv + a;
      if (count.get(rev) > 0) count.set(rev, count.get(rev) - 1);
      else count.set(fwd, (count.get(fwd) || 0) + 1);
    }
  }
  let open = 0;
  for (const c of count.values()) open += c;
  return open;
}

function terrain(nx, ny, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ph = [rnd() * 6, rnd() * 6, rnd() * 6];
  const e = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      e[j * nx + i] =
        900 * Math.sin(i * 0.21 + ph[0]) * Math.cos(j * 0.17 + ph[1]) +
        500 * Math.sin((i + j) * 0.09 + ph[2]) + 120 * rnd() + 300;
    }
  }
  return e;
}

let cases = 0;
for (const snap of [false, true]) {
  for (const seaMode of ['color', 'flat', 'bathy']) {
    for (const distribution of ['height', 'area']) {
      for (const nColors of [1, 2, 5, 8]) {
        const nx = 47, ny = 33;
        const elev = terrain(nx, ny, 7 + cases);
        // every other case gets lakes and a river crossing the border
        let waterMask = null;
        if (cases % 2) {
          waterMask = new Uint8Array(nx * ny);
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              const lake = Math.hypot(i - 12, j - 10) < 5 || Math.hypot(i - 34, j - 22) < 3.5;
              waterMask[j * nx + i] = lake || Math.abs(i - j - 8) < 1 ? 1 : 0;
            }
          }
        }
        const model = computeModel(elev, nx, ny, {
          waterMask, lakeLayers: 3,
          layerH: 0.2, reliefLayers: 40, baseMM: 1.2, snap, seaMode, coastLayers: 2,
          smoothing: 1, nColors, distribution,
          curve: snap ? [[0.1, 0], [0.4, 0.7], [0.6, 0.5], [0.9, 1]] : undefined,
        });
        const dx = 0.5, dy = 0.5;
        const whole = buildBand(model.z, nx, ny, dx, dy, 0, Infinity);
        assert.equal(openEdges(whole), 0, 'one-piece model is closed');
        const vWhole = volume(whole);
        assert.ok(vWhole > 0);
        let sum = 0;
        assert.equal(model.stats.inlay, !!waterMask && nColors > 1);
        if (model.stats.inlay) {
          const inlay = buildInlay(model.zLand, model.z, nx, ny, dx, dy);
          assert.equal(openEdges(inlay), 0, 'water inlay is closed');
          sum = volume(inlay);
          assert.ok(sum > 0, 'water inlay has volume');
        }
        for (const b of model.bands) {
          const t = buildBand(model.zLand, nx, ny, dx, dy, b.lo, b.hi);
          assert.equal(openEdges(t), 0, `band ${b.color} closed (${seaMode}, snap=${snap}, n=${nColors})`);
          const v = volume(t);
          assert.ok(v > 0, 'band has positive volume');
          sum += v;
        }
        assert.ok(Math.abs(sum - vWhole) / vWhole < 1e-5, `bands fill the model: ${sum} vs ${vWhole}`);

        // the same terrain coloured per triangle: base plate + one column solid per colour
        const imagery = new Uint8Array(nx * ny * 3).map((_, k) => (k * 37 + (k % 3) * 90) % 256);
        const landcover = new Uint8Array(nx * ny).map((_, k) => (k % nx < 10 ? 4 : (k * 7) % 9));
        const landcoverDefs = Array.from({ length: 9 }, (_, c) => ({ name: `c${c}`, color: `#${String(c).repeat(6)}` }));
        for (const colorBy of ['slope', 'satellite', 'landcover']) {
          const sm = computeModel(elev, nx, ny, {
            waterMask, lakeLayers: 3,
            layerH: 0.2, reliefLayers: 40, baseMM: 1.2, snap, seaMode, coastLayers: 2,
            smoothing: 1, nColors, distribution, colorBy, groundDX: 90, groundDY: 90,
            imagery, landcover, landcoverDefs,
          });
          const what = `${colorBy} (${seaMode}, snap=${snap}, n=${nColors})`;
          assert.ok(sm.bands.length >= 1 && sm.bands.length <= nColors, `band count ${what}`);
          assert.ok(sm.cls.every((c) => c < nColors), `colour index in range ${what}`);
          if (colorBy !== 'slope') assert.equal(sm.autoColors.length, nColors, `palette size ${what}`);
          const solidS = buildBand(sm.z, nx, ny, dx, dy, 0, Infinity);
          const plate = buildBand(sm.floor, nx, ny, dx, dy, 0, Infinity);
          assert.equal(openEdges(plate), 0, 'base plate closed');
          let sumS = volume(plate);
          if (sm.stats.inlay) sumS += volume(buildInlay(sm.zLand, sm.z, nx, ny, dx, dy));
          const cols = buildFacets(sm.floor, sm.zLand, nx, ny, dx, dy, sm.cls, nColors);
          for (const b of sm.bands) {
            const t = cols[b.color];
            assert.equal(openEdges(t), 0, `colour ${b.color} closed ${what}`);
            // the base plate is merged into the first colour (flat sea has no column of its own)
            assert.ok(volume(t) > 0 || (b === sm.bands[0] && b.sea), `colour ${b.color} has volume ${what}`);
          }
          for (const t of cols) sumS += volume(t);
          assert.ok(Math.abs(sumS - volume(solidS)) / volume(solidS) < 1e-5, `colours fill the model ${what}`);
        }
        cases++;
      }
    }
  }
}
console.log(`ok - ${cases} configurations, all bands watertight and volume-exact`);
