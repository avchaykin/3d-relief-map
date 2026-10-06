// World map with an editable rectangle selection.
import * as L from 'leaflet';

const BASEMAPS = {
  topo: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)' },
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '© OpenStreetMap contributors' },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  },
};

const MAX_LAT = 84;
const clampLat = (v) => Math.min(MAX_LAT, Math.max(-MAX_LAT, v));
const clampLng = (v) => Math.min(180, Math.max(-180, v));

/**
 * @param {HTMLElement} el
 * @param {{bounds:object, basemap:string, onChange:(bounds:object, final:boolean)=>void}} opts
 */
export function createMap(el, { bounds, basemap, onChange }) {
  const map = L.map(el, { worldCopyJump: false, zoomSnap: 0.5, minZoom: 2 });
  map.attributionControl.setPrefix(false).addAttribution('Elevation: Mapzen · Water: OpenFreeMap');
  let tiles = null;

  const setBasemap = (key) => {
    const def = BASEMAPS[key] || BASEMAPS.topo;
    tiles?.remove();
    tiles = L.tileLayer(def.url, def.options).addTo(map);
  };
  setBasemap(basemap);

  let sw = L.latLng(bounds.south, bounds.west);
  let ne = L.latLng(bounds.north, bounds.east);
  const rect = L.rectangle([sw, ne], { className: 'sel-rect', weight: 2, interactive: false }).addTo(map);

  const handle = (cls) =>
    L.marker([0, 0], {
      draggable: true,
      icon: L.divIcon({ className: `sel-handle ${cls}`, iconSize: [16, 16] }),
      keyboard: false,
    }).addTo(map);
  // corners are named by the corner they sit on; each one moves against its opposite
  const corners = { sw: handle('corner'), se: handle('corner'), ne: handle('corner'), nw: handle('corner') };
  const mover = handle('mover');

  const current = () => ({ south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng });
  const place = (skip) => {
    rect.setBounds([sw, ne]);
    const pos = {
      sw: [sw.lat, sw.lng], se: [sw.lat, ne.lng], ne: [ne.lat, ne.lng], nw: [ne.lat, sw.lng],
    };
    for (const k in corners) if (corners[k] !== skip) corners[k].setLatLng(pos[k]);
    if (mover !== skip) mover.setLatLng([(sw.lat + ne.lat) / 2, (sw.lng + ne.lng) / 2]);
  };
  const setCorners = (a, b) => {
    sw = L.latLng(clampLat(Math.min(a.lat, b.lat)), clampLng(Math.min(a.lng, b.lng)));
    ne = L.latLng(clampLat(Math.max(a.lat, b.lat)), clampLng(Math.max(a.lng, b.lng)));
  };
  const valid = () => ne.lat - sw.lat > 1e-4 && ne.lng - sw.lng > 1e-4;

  const opposite = { sw: 'ne', se: 'nw', ne: 'sw', nw: 'se' };
  for (const k in corners) {
    let anchor;
    corners[k]
      .on('dragstart', () => (anchor = corners[opposite[k]].getLatLng()))
      .on('drag', (e) => {
        setCorners(anchor, e.target.getLatLng());
        place(e.target);
        onChange(current(), false);
      })
      .on('dragend', () => {
        place();
        onChange(current(), true);
      });
  }
  {
    let start, sw0, ne0;
    mover
      .on('dragstart', (e) => {
        start = e.target.getLatLng();
        sw0 = sw; ne0 = ne;
      })
      .on('drag', (e) => {
        const p = e.target.getLatLng();
        // keep the size: clamp the shift instead of the corners
        const dLat = Math.min(MAX_LAT - ne0.lat, Math.max(-MAX_LAT - sw0.lat, p.lat - start.lat));
        const dLng = Math.min(180 - ne0.lng, Math.max(-180 - sw0.lng, p.lng - start.lng));
        sw = L.latLng(sw0.lat + dLat, sw0.lng + dLng);
        ne = L.latLng(ne0.lat + dLat, ne0.lng + dLng);
        place(e.target);
        onChange(current(), false);
      })
      .on('dragend', () => {
        place();
        onChange(current(), true);
      });
  }

  // Draw mode: drag on the map to create a new rectangle.
  let drawing = false, drawStart = null, onDrawEnd = null;
  const stopDraw = () => {
    drawing = false;
    drawStart = null;
    map.dragging.enable();
    el.classList.remove('drawing');
    onDrawEnd?.();
  };
  map.on('mousedown', (e) => {
    if (!drawing) return;
    drawStart = e.latlng;
  });
  map.on('mousemove', (e) => {
    if (!drawStart) return;
    setCorners(drawStart, e.latlng);
    place();
    onChange(current(), false);
  });
  map.on('mouseup', () => {
    if (!drawStart) return;
    const ok = valid();
    stopDraw();
    if (ok) onChange(current(), true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawing) stopDraw();
  });

  place();
  map.fitBounds(rect.getBounds().pad(0.35));

  return {
    map,
    setBasemap,
    getBounds: current,
    startDraw(done) {
      drawing = true;
      onDrawEnd = done;
      map.dragging.disable();
      el.classList.add('drawing');
    },
    cancelDraw: () => drawing && stopDraw(),
    /** Put the selection in the middle of what is currently visible. */
    selectView() {
      const b = map.getBounds().pad(-0.2);
      setCorners(b.getSouthWest(), b.getNorthEast());
      place();
      onChange(current(), true);
    },
    focusSelection: () => map.fitBounds(rect.getBounds().pad(0.35)),
    flyTo(b) {
      map.fitBounds([[b.south, b.west], [b.north, b.east]]);
    },
    invalidate: () => map.invalidateSize(),
  };
}

/** Place search (OpenStreetMap Nominatim). Returns bounds or null. */
export async function searchPlace(query) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const [hit] = await res.json();
  if (!hit) return null;
  const [s, n, w, e] = hit.boundingbox.map(Number);
  return { south: s, north: n, west: w, east: e, name: hit.display_name };
}
