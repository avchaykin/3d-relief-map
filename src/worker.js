// Mesh generation off the main thread.
import { buildBands, buildInlay } from './mesher.js';

self.onmessage = (ev) => {
  const { id, z, zTop, nx, ny, dx, dy, bands } = ev.data;
  const meshes = buildBands(z, nx, ny, dx, dy, bands);
  const inlay = zTop ? buildInlay(z, zTop, nx, ny, dx, dy) : null;
  self.postMessage({ id, meshes, inlay }, [...meshes, ...(inlay ? [inlay] : [])].map((m) => m.buffer));
};
