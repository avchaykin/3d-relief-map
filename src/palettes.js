// Colour presets. `water` is used for the sea band, `land` is a ramp from low to high.
export const PRESETS = {
  natural: { name: 'Natural', water: '#3a78b5', land: ['#4f8a4b', '#a9b86a', '#e0cf94', '#b48a5c', '#86685a', '#f5f5f0'] },
  topo: { name: 'Topographic', water: '#4a8fcb', land: ['#2f7d3c', '#6fa84b', '#b9c46a', '#e2cf86', '#cf9e5c', '#a76a3c', '#7b4a2b'] },
  atlas: { name: 'Vintage atlas', water: '#a9cbd6', land: ['#c8d7a3', '#f1e3b2', '#e7bf85', '#c98d5d', '#9c6247', '#fbf7ee'] },
  gray: { name: 'Grayscale', water: '#2a2d33', land: ['#55585e', '#f4f4f4'] },
  ocean: { name: 'Blue depth', water: '#0d2a4d', land: ['#1f5f8b', '#59a5c8', '#bfe3ee', '#ffffff'] },
  steepness: { name: 'Steepness', water: '#3a78b5', land: ['#6f9e4c', '#c2b75e', '#c98a4b', '#8a6a58', '#4b4446'] },
  ember: { name: 'Ember', water: '#1d1b26', land: ['#4a1d3f', '#a3283c', '#e8642c', '#f7c653', '#fff6d6'] },
};

const hex = (v) => Math.round(v).toString(16).padStart(2, '0');

function sample(ramp, t) {
  const f = t * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(f));
  const k = f - i;
  const a = ramp[i], b = ramp[i + 1];
  const ch = (o) => {
    const x = parseInt(a.slice(o, o + 2), 16), y = parseInt(b.slice(o, o + 2), 16);
    return hex(x + (y - x) * k);
  };
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/** n colours, lowest first. With `withWater` the first one is the sea colour. */
export function makePalette(presetKey, n, withWater) {
  const p = PRESETS[presetKey] || PRESETS.natural;
  const out = [];
  const land = withWater && n >= 2 ? n - 1 : n;
  if (land < n) out.push(p.water);
  for (let i = 0; i < land; i++) out.push(sample(p.land, land === 1 ? 0.35 : i / (land - 1)));
  return out;
}
