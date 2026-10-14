// Heightfield -> watertight solids, one per colour band.
//
// The terrain is a regular grid of top-surface heights z (mm). A band is the part
// of the solid between two horizontal planes [lo, hi]. Every band is produced as a
// closed mesh by clipping each terrain triangle against the two planes, so the
// bands tile the full model exactly and can be printed as separate parts/filaments.
// A single band [0, Infinity] gives the plain one-piece model.
//
// All crossing points are interpolated from the original grid edge with a canonical
// endpoint order, so neighbouring triangles and walls produce bit-identical vertices.

class TriBuffer {
  constructor() {
    this.a = new Float32Array(1 << 16);
    this.n = 0;
  }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (this.n + 9 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    const a = this.a;
    let n = this.n;
    a[n++] = ax; a[n++] = ay; a[n++] = az;
    a[n++] = bx; a[n++] = by; a[n++] = bz;
    a[n++] = cx; a[n++] = cy; a[n++] = cz;
    this.n = n;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

// Point where the segment p-q (x, y, h triples in `src`) crosses height `level`.
function cross(src, p, q, level, out, o) {
  let ax = src[p], ay = src[p + 1], ah = src[p + 2];
  let bx = src[q], by = src[q + 1], bh = src[q + 2];
  if (bx < ax || (bx === ax && by < ay)) {
    let t = ax; ax = bx; bx = t;
    t = ay; ay = by; by = t;
    t = ah; ah = bh; bh = t;
  }
  const t = (level - ah) / (bh - ah);
  out[o] = ax + (bx - ax) * t;
  out[o + 1] = ay + (by - ay) * t;
  out[o + 2] = level;
}

// Points along the edge p->q that lie in [lo, incl], plus strict crossings of lo and hi.
function edgePoints(src, p, q, lo, hi, incl, out, n) {
  const hp = src[p + 2], hq = src[q + 2];
  if (hp >= lo && hp <= incl) {
    out[n * 3] = src[p]; out[n * 3 + 1] = src[p + 1]; out[n * 3 + 2] = hp;
    n++;
  }
  const xlo = (hp - lo) * (hq - lo) < 0;
  const xhi = (hp - hi) * (hq - hi) < 0;
  if (hp < hq) {
    if (xlo) cross(src, p, q, lo, out, n++ * 3);
    if (xhi) cross(src, p, q, hi, out, n++ * 3);
  } else {
    if (xhi) cross(src, p, q, hi, out, n++ * 3);
    if (xlo) cross(src, p, q, lo, out, n++ * 3);
  }
  return n;
}

// Convex polygon of the triangle T restricted to lo <= h <= hi.
function bandPoly(T, lo, hi, out) {
  let n = 0;
  n = edgePoints(T, 0, 3, lo, hi, hi, out, n);
  n = edgePoints(T, 3, 6, lo, hi, hi, out, n);
  n = edgePoints(T, 6, 0, lo, hi, hi, out, n);
  return n;
}

/**
 * @param {Float64Array} z   top surface heights, row 0 = north, length nx*ny
 * @param {number} dx,dy     grid spacing in mm
 * @param {number} lo,hi     band limits in mm (hi may be Infinity)
 * @returns {Float32Array}   triangle soup, 9 floats per triangle, CCW = outward
 */
export function buildBand(z, nx, ny, dx, dy, lo, hi) {
  const buf = new TriBuffer();
  const T = new Float64Array(9);
  const P = new Float64Array(24);
  const W = new Float64Array(30);

  let zmin = Infinity;
  for (let k = 0; k < z.length; k++) if (z[k] < zmin) zmin = z[k];
  const fullBottom = zmin > lo;

  const fanTop = (n) => {
    for (let k = 1; k < n - 1; k++) {
      buf.tri(P[0], P[1], P[2], P[k * 3], P[k * 3 + 1], P[k * 3 + 2], P[k * 3 + 3], P[k * 3 + 4], P[k * 3 + 5]);
    }
  };
  const fanFlat = (n, level, up) => {
    for (let k = 1; k < n - 1; k++) {
      const b = up ? k : k + 1, c = up ? k + 1 : k;
      buf.tri(P[0], P[1], level, P[b * 3], P[b * 3 + 1], level, P[c * 3], P[c * 3 + 1], level);
    }
  };

  const triangle = () => {
    const h0 = T[2], h1 = T[5], h2 = T[8];
    const mn = Math.min(h0, h1, h2), mx = Math.max(h0, h1, h2);
    if (mx <= lo) return;
    if (mn >= lo) {
      if (!fullBottom) buf.tri(T[0], T[1], lo, T[6], T[7], lo, T[3], T[4], lo);
      if (mn >= hi) {
        buf.tri(T[0], T[1], hi, T[3], T[4], hi, T[6], T[7], hi);
        return;
      }
      if (mx <= hi) {
        buf.tri(T[0], T[1], h0, T[3], T[4], h1, T[6], T[7], h2);
        return;
      }
    } else {
      const n = bandPoly(T, lo, Infinity, P);
      if (n >= 3) fanFlat(n, lo, false);
    }
    let n = bandPoly(T, lo, hi, P);
    if (n >= 3) fanTop(n);
    if (mx > hi) {
      n = bandPoly(T, hi, Infinity, P);
      if (n >= 3) fanFlat(n, hi, true);
    }
  };

  const setV = (o, i, j) => {
    T[o] = i * dx;
    T[o + 1] = (ny - 1 - j) * dy;
    T[o + 2] = z[j * nx + i];
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      // bottom-left, bottom-right, top-right / bottom-left, top-right, top-left
      setV(0, i, j + 1); setV(3, i + 1, j + 1); setV(6, i + 1, j);
      triangle();
      setV(3, i + 1, j); setV(6, i, j);
      triangle();
    }
  }

  // Outer wall for one perimeter edge a->b (perimeter walked counter-clockwise).
  const wall = (ia, ja, ib, jb) => {
    setV(0, ia, ja); setV(3, ib, jb);
    if (Math.max(T[2], T[5]) <= lo) return;
    let n = edgePoints(T, 0, 3, lo, hi, Infinity, P, 0);
    if (T[5] >= lo) {
      P[n * 3] = T[3]; P[n * 3 + 1] = T[4]; P[n * 3 + 2] = T[5];
      n++;
    }
    if (n < 2) return;
    // polygon: first@lo, last@lo, then the top profile back to first
    let m = 0;
    const push = (k, zz) => {
      const x = P[k * 3], y = P[k * 3 + 1];
      if (m && W[m * 3 - 3] === x && W[m * 3 - 2] === y && W[m * 3 - 1] === zz) return;
      W[m * 3] = x; W[m * 3 + 1] = y; W[m * 3 + 2] = zz;
      m++;
    };
    push(0, lo);
    push(n - 1, lo);
    for (let k = n - 1; k >= 0; k--) push(k, Math.min(P[k * 3 + 2], hi));
    if (W[m * 3 - 3] === W[0] && W[m * 3 - 2] === W[1] && W[m * 3 - 1] === W[2]) m--;
    for (let k = 1; k < m - 1; k++) {
      buf.tri(W[0], W[1], W[2], W[k * 3], W[k * 3 + 1], W[k * 3 + 2], W[k * 3 + 3], W[k * 3 + 4], W[k * 3 + 5]);
    }
  };

  const cx = ((nx - 1) * dx) / 2, cy = ((ny - 1) * dy) / 2;
  const edge = (ia, ja, ib, jb) => {
    wall(ia, ja, ib, jb);
    if (fullBottom) {
      buf.tri(cx, cy, lo, ib * dx, (ny - 1 - jb) * dy, lo, ia * dx, (ny - 1 - ja) * dy, lo);
    }
  };
  for (let i = 0; i < nx - 1; i++) edge(i, ny - 1, i + 1, ny - 1); // south
  for (let j = ny - 1; j > 0; j--) edge(nx - 1, j, nx - 1, j - 1); // east
  for (let i = nx - 1; i > 0; i--) edge(i, 0, i - 1, 0); // north
  for (let j = 0; j < ny - 1; j++) edge(0, j, 0, j + 1); // west

  return buf.done();
}

export function buildBands(z, nx, ny, dx, dy, bands) {
  return bands.map((b) => buildBand(z, nx, ny, dx, dy, b.lo, b.hi));
}

/**
 * Closed solid between two heightfields on the same grid (zLow <= zHigh), e.g. a
 * water inlay sitting in a carved surface. Where both are equal there is nothing.
 * Uses the same triangulation as buildBand, so it fits the carved model exactly.
 */
export function buildInlay(zLow, zHigh, nx, ny, dx, dy) {
  const buf = new TriBuffer();
  const X = (i) => i * dx, Y = (j) => (ny - 1 - j) * dy;

  const triangle = (i0, j0, i1, j1, i2, j2) => {
    const k0 = j0 * nx + i0, k1 = j1 * nx + i1, k2 = j2 * nx + i2;
    if (zLow[k0] === zHigh[k0] && zLow[k1] === zHigh[k1] && zLow[k2] === zHigh[k2]) return;
    buf.tri(X(i0), Y(j0), zHigh[k0], X(i1), Y(j1), zHigh[k1], X(i2), Y(j2), zHigh[k2]);
    buf.tri(X(i0), Y(j0), zLow[k0], X(i2), Y(j2), zLow[k2], X(i1), Y(j1), zLow[k1]);
  };
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      triangle(i, j + 1, i + 1, j + 1, i + 1, j);
      triangle(i, j + 1, i + 1, j, i, j);
    }
  }

  const wall = (ia, ja, ib, jb) => {
    const a = ja * nx + ia, b = jb * nx + ib;
    const da = zLow[a] !== zHigh[a], db = zLow[b] !== zHigh[b];
    if (!da && !db) return;
    const ax = X(ia), ay = Y(ja), bx = X(ib), by = Y(jb);
    if (db) buf.tri(ax, ay, zLow[a], bx, by, zLow[b], bx, by, zHigh[b]);
    if (da) buf.tri(ax, ay, zLow[a], bx, by, zHigh[b], ax, ay, zHigh[a]);
  };
  for (let i = 0; i < nx - 1; i++) wall(i, ny - 1, i + 1, ny - 1);
  for (let j = ny - 1; j > 0; j--) wall(nx - 1, j, nx - 1, j - 1);
  for (let i = nx - 1; i > 0; i--) wall(i, 0, i - 1, 0);
  for (let j = 0; j < ny - 1; j++) wall(0, j, 0, j + 1);

  return buf.done();
}

/**
 * Closed solids between two heightfields (zLow <= zHigh), split by a class per grid
 * triangle: one solid per class, walled off where the neighbouring triangle has
 * another class. Triangle t of cell (i, j) is cls[(j * (nx - 1) + i) * 2 + s] with
 * s = 0 for (BL, BR, TR) and s = 1 for (BL, TR, TL), the triangulation of buildBand.
 * Shared walls have identical vertices, so the solids tile the volume exactly.
 * @returns {Float32Array[]} one triangle soup per class 0..nClasses-1
 */
export function buildFacets(zLow, zHigh, nx, ny, dx, dy, cls, nClasses) {
  const bufs = Array.from({ length: nClasses }, () => new TriBuffer());
  const X = (i) => i * dx, Y = (j) => (ny - 1 - j) * dy;
  const cw = nx - 1;
  const clsAt = (i, j, s) => (i < 0 || j < 0 || i >= cw || j >= ny - 1 ? -1 : cls[(j * cw + i) * 2 + s]);

  // wall on edge a->b (counter-clockwise around the triangle, so outward is to the right)
  const wall = (buf, ia, ja, ib, jb) => {
    const a = ja * nx + ia, b = jb * nx + ib;
    const da = zLow[a] !== zHigh[a], db = zLow[b] !== zHigh[b];
    const ax = X(ia), ay = Y(ja), bx = X(ib), by = Y(jb);
    if (db) buf.tri(ax, ay, zLow[a], bx, by, zLow[b], bx, by, zHigh[b]);
    if (da) buf.tri(ax, ay, zLow[a], bx, by, zHigh[b], ax, ay, zHigh[a]);
  };
  const prism = (buf, i0, j0, i1, j1, i2, j2) => {
    const k0 = j0 * nx + i0, k1 = j1 * nx + i1, k2 = j2 * nx + i2;
    if (zLow[k0] === zHigh[k0] && zLow[k1] === zHigh[k1] && zLow[k2] === zHigh[k2]) return;
    buf.tri(X(i0), Y(j0), zHigh[k0], X(i1), Y(j1), zHigh[k1], X(i2), Y(j2), zHigh[k2]);
    buf.tri(X(i0), Y(j0), zLow[k0], X(i2), Y(j2), zLow[k2], X(i1), Y(j1), zLow[k1]);
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < cw; i++) {
      const cA = clsAt(i, j, 0), cB = clsAt(i, j, 1);
      // A: BL, BR, TR. Neighbours: south = cell below's B, east = cell right's B, diagonal = B
      let buf = bufs[cA];
      prism(buf, i, j + 1, i + 1, j + 1, i + 1, j);
      if (clsAt(i, j + 1, 1) !== cA) wall(buf, i, j + 1, i + 1, j + 1);
      if (clsAt(i + 1, j, 1) !== cA) wall(buf, i + 1, j + 1, i + 1, j);
      if (cB !== cA) wall(buf, i + 1, j, i, j + 1);
      // B: BL, TR, TL. Neighbours: north = cell above's A, west = cell left's A, diagonal = A
      buf = bufs[cB];
      prism(buf, i, j + 1, i + 1, j, i, j);
      if (cA !== cB) wall(buf, i, j + 1, i + 1, j);
      if (clsAt(i, j - 1, 0) !== cB) wall(buf, i + 1, j, i, j);
      if (clsAt(i - 1, j, 0) !== cB) wall(buf, i, j, i, j + 1);
    }
  }
  return bufs.map((b) => b.done());
}
