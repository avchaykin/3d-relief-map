// Mesh generation off the main thread.
import { buildBand, buildBands, buildFacets, buildInlay } from './mesher.js?v=2';

self.onmessage = (ev) => {
  const { id, z, zTop, nx, ny, dx, dy, bands, facets } = ev.data;
  let meshes;
  if (facets) {
    // steepness colours: one column solid per colour on top of the base plate
    const { floor, cls, nClasses, baseColor } = facets;
    meshes = buildFacets(floor, z, nx, ny, dx, dy, cls, nClasses);
    const plate = buildBand(floor, nx, ny, dx, dy, 0, Infinity);
    const both = new Float32Array(meshes[baseColor].length + plate.length);
    both.set(meshes[baseColor]);
    both.set(plate, meshes[baseColor].length);
    meshes[baseColor] = both;
  } else {
    meshes = buildBands(z, nx, ny, dx, dy, bands);
  }
  const inlay = zTop ? buildInlay(z, zTop, nx, ny, dx, dy) : null;
  self.postMessage({ id, meshes, inlay }, [...meshes, ...(inlay ? [inlay] : [])].map((m) => m.buffer));
};
