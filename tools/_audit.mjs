/**
 * Audits catalog anchors against each cutout's actual silhouette, so bad
 * placements are caught numerically rather than by squinting at a render.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function decodePng(buf) {
  const chunks = []; let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    chunks.push({ type: buf.toString('ascii', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let ro = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[ro++]; const rs = y * stride, prs = rs - stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[ro + x];
      const a = x >= bpp ? out[rs + x - bpp] : 0;
      const b = y > 0 ? out[prs + x] : 0;
      const c = y > 0 && x >= bpp ? out[prs + x - bpp] : 0;
      let v;
      switch (ft) { case 0: v=rb; break; case 1: v=rb+a; break; case 2: v=rb+b; break;
        case 3: v=rb+Math.floor((a+b)/2); break; case 4: v=rb+paeth(a,b,c); break;
        default: throw new Error('filter'+ft); }
      out[rs + x] = v & 0xff;
    }
    ro += stride;
  }
  return { width, height, rgba: out };
}

const catalog = JSON.parse(await readFile('src/garments/catalog.json', 'utf8'));
const only = process.argv[2];

for (const g of catalog) {
  if (only && !g.id.includes(only)) continue;
  if (g.category === 'lehenga-choli' && g.choli) continue;
  const { width: w, height: h, rgba } = decodePng(await readFile(path.join('public', g.image.replace(/^\//, ''))));

  // Row extents + per-row opaque count
  const rows = [];
  for (let y = 0; y < h; y++) {
    let minX = -1, maxX = -1, count = 0;
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 127) { if (minX < 0) minX = x; maxX = x; count++; }
    }
    rows.push({ minX, maxX, count });
  }
  const firstY = rows.findIndex((r) => r.count > 0);
  const lastY = h - 1 - [...rows].reverse().findIndex((r) => r.count > 0);

  // Detect a horizontal EMPTY band (detached parts, e.g. choli above skirt)
  let gapStart = -1, gapEnd = -1;
  for (let y = firstY; y <= lastY; y++) {
    if (rows[y].count === 0) { if (gapStart < 0) gapStart = y; gapEnd = y; }
  }

  const pct = (v, total) => `${((v / total) * 100).toFixed(0)}%`;
  const flags = [];

  const a = g.anchors;
  // Does each anchor sit on or near opaque pixels?
  const onGarment = (p) => {
    const x = Math.round(p[0]), y = Math.round(p[1]);
    if (y < 0 || y >= h) return 'OUT-OF-FRAME';
    const r = rows[y];
    if (r.count === 0) return 'EMPTY-ROW';
    if (x < r.minX - 8 || x > r.maxX + 8) return 'OFF-SILHOUETTE';
    return 'ok';
  };
  for (const [name, p] of Object.entries(a)) {
    const status = onGarment(p);
    if (status !== 'ok') flags.push(`${name}=${status}`);
  }

  if (g.category !== 'pants') {
    const shoulderW = a.shoulderR[0] - a.shoulderL[0];
    const hemW = a.hemR[0] - a.hemL[0];
    const shoulderYFrac = (a.shoulderL[1] - firstY) / (lastY - firstY);
    if (shoulderYFrac > 0.18) flags.push(`shoulderY LOW (${pct(a.shoulderL[1] - firstY, lastY - firstY)} down)`);
    if (gapStart >= 0) flags.push(`DETACHED-PARTS gap y=${gapStart}-${gapEnd}`);
    if (hemW > shoulderW * 1.8) flags.push(`hem ${(hemW / shoulderW).toFixed(1)}x shoulders`);
  }

  const tag = flags.length ? `  <<< ${flags.join(' | ')}` : '';
  console.log(`${g.id.padEnd(28)} ${String(w).padStart(4)}x${String(h).padStart(4)}${tag}`);
}
