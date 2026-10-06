// Export of triangle soups (Float32Array, 9 floats per triangle, mm) to printer formats.
import { zipSync, strToU8 } from 'fflate';

/** Merge identical positions into an indexed mesh; triangles that collapse are dropped. */
export function weld(tris) {
  const map = new Map();
  const vertices = [];
  const indices = new Uint32Array(tris.length / 3);
  const id = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < tris.length; i += 9) {
    for (let v = 0; v < 3; v++) {
      const x = tris[i + v * 3], y = tris[i + v * 3 + 1], z = tris[i + v * 3 + 2];
      // 2.5 micron cells; fits 53 bits for models up to 650 x 650 x 160 mm
      const key = (Math.round(x * 400) * 262144 + Math.round(y * 400)) * 65536 + Math.round(z * 400);
      let k = map.get(key);
      if (k === undefined) {
        k = vertices.length / 3;
        vertices.push(x, y, z);
        map.set(key, k);
      }
      id[v] = k;
    }
    if (id[0] === id[1] || id[1] === id[2] || id[0] === id[2]) continue;
    indices[n++] = id[0]; indices[n++] = id[1]; indices[n++] = id[2];
  }
  return { vertices: Float32Array.from(vertices), indices: indices.subarray(0, n) };
}

export function toSTL(parts, title = 'relief map') {
  let count = 0;
  for (const t of parts) count += t.length / 9;
  const out = new Uint8Array(84 + count * 50);
  out.set(strToU8(title.slice(0, 79)));
  const dv = new DataView(out.buffer);
  dv.setUint32(80, count, true);
  let o = 84;
  for (const t of parts) {
    for (let i = 0; i < t.length; i += 9) {
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
      const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / len, true);
      dv.setFloat32(o + 4, ny / len, true);
      dv.setFloat32(o + 8, nz / len, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, t[i + k], true);
      o += 50;
    }
  }
  return out;
}

// Builds large text files without creating one giant string.
class TextChunks {
  constructor() {
    this.parts = [];
    this.lines = [];
    this.size = 0;
    this.enc = new TextEncoder();
  }
  add(line) {
    this.lines.push(line);
    if (this.lines.length >= 8192) this.flush();
  }
  flush() {
    if (!this.lines.length) return;
    const u = this.enc.encode(this.lines.join('\n') + '\n');
    this.parts.push(u);
    this.size += u.length;
    this.lines = [];
  }
  done() {
    this.flush();
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

const num = (v) => String(+v.toFixed(4));
const xmlEsc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** parts: [{ name, color: '#rrggbb', tris }] -> 3MF with one coloured part per entry. */
export function to3MF(parts, title = 'Relief map') {
  const t = new TextChunks();
  t.add('<?xml version="1.0" encoding="UTF-8"?>');
  t.add('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  t.add(` <metadata name="Title">${xmlEsc(title)}</metadata>`);
  t.add(' <metadata name="Application">3D Relief Map</metadata>');
  t.add(' <resources>');
  t.add('  <basematerials id="1">');
  for (const p of parts) t.add(`   <base name="${xmlEsc(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>`);
  t.add('  </basematerials>');
  parts.forEach((p, pi) => {
    const { vertices, indices } = weld(p.tris);
    t.add(`  <object id="${pi + 2}" name="${xmlEsc(p.name)}" type="model" pid="1" pindex="${pi}">`);
    t.add('   <mesh>');
    t.add('    <vertices>');
    for (let i = 0; i < vertices.length; i += 3) {
      t.add(`<vertex x="${num(vertices[i])}" y="${num(vertices[i + 1])}" z="${num(vertices[i + 2])}"/>`);
    }
    t.add('    </vertices>');
    t.add('    <triangles>');
    for (let i = 0; i < indices.length; i += 3) {
      t.add(`<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}"/>`);
    }
    t.add('    </triangles>');
    t.add('   </mesh>');
    t.add('  </object>');
  });
  const assembly = parts.length + 2;
  t.add(`  <object id="${assembly}" name="${xmlEsc(title)}" type="model">`);
  t.add('   <components>');
  parts.forEach((p, pi) => t.add(`    <component objectid="${pi + 2}"/>`));
  t.add('   </components>');
  t.add('  </object>');
  t.add(' </resources>');
  t.add(' <build>');
  t.add(`  <item objectid="${assembly}"/>`);
  t.add(' </build>');
  t.add('</model>');

  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': t.done(),
  }, { level: 6 });
}

/** parts: [{ name, color, tris }] -> zip with .obj (one group per colour) and .mtl. */
export function toOBJZip(parts, baseName) {
  const o = new TextChunks();
  o.add('# 3D Relief Map - units: mm, Z up');
  o.add(`mtllib ${baseName}.mtl`);
  let mtl = '';
  let offset = 1;
  parts.forEach((p, pi) => {
    const mat = `color_${pi + 1}`;
    const c = p.color;
    const rgb = [1, 3, 5].map((k) => (parseInt(c.slice(k, k + 2), 16) / 255).toFixed(4)).join(' ');
    mtl += `newmtl ${mat}\nKd ${rgb}\nKa 0 0 0\nKs 0 0 0\nd 1\nillum 1\n\n`;
    const { vertices, indices } = weld(p.tris);
    o.add(`o ${p.name.replace(/\s+/g, '_')}`);
    for (let i = 0; i < vertices.length; i += 3) {
      o.add(`v ${num(vertices[i])} ${num(vertices[i + 1])} ${num(vertices[i + 2])}`);
    }
    o.add(`usemtl ${mat}`);
    for (let i = 0; i < indices.length; i += 3) {
      o.add(`f ${indices[i] + offset} ${indices[i + 1] + offset} ${indices[i + 2] + offset}`);
    }
    offset += vertices.length / 3;
  });
  return zipSync({ [`${baseName}.obj`]: o.done(), [`${baseName}.mtl`]: strToU8(mtl) }, { level: 6 });
}

/** files: { name: Uint8Array } */
export function toZip(files) {
  return zipSync(files, { level: 6 });
}

export function download(bytes, filename, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
