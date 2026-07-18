/**
 * Builds a review contact sheet from cutout garment PNGs: each is scaled
 * into a fixed cell and composited over MAGENTA, so anything that should
 * be transparent but isn't (leftover background, skin, the wearer's other
 * clothes) is immediately obvious — a cutout viewed on white or a light
 * checkerboard hides exactly the failures you're looking for.
 *
 * Also overlays each garment's catalog anchors as dots when a catalog-shaped
 * JSON is supplied, so anchor placement can be eyeballed at a glance rather
 * than one garment at a time in the browser.
 *
 * Usage:
 *   node tools/garment-contact-sheet.mjs tools/extracted-garments.json [out.png]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CELL = 260;
const PAD = 8;
const COLS = 5;
const BG = [190, 20, 150]; // magenta — no garment is ever this color

// --- PNG decode (8-bit RGBA) ---
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6) throw new Error('expected 8-bit RGBA');
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let ro = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[ro++];
    const rs = y * stride, prs = rs - stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[ro + x];
      const a = x >= bpp ? out[rs + x - bpp] : 0;
      const b = y > 0 ? out[prs + x] : 0;
      const c = y > 0 && x >= bpp ? out[prs + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + Math.floor((a + b) / 2); break;
        case 4: v = rb + paeth(a, b, c); break;
        default: throw new Error('unknown filter ' + ft);
      }
      out[rs + x] = v & 0xff;
    }
    ro += stride;
  }
  return { width, height, rgba: out };
}

// --- PNG encode ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const catalogPath = process.argv[2] ?? path.join(root, 'tools', 'extracted-garments.json');
const outPath = process.argv[3] ?? path.join(root, 'tools', 'contact-sheet.png');
const entries = JSON.parse(await readFile(catalogPath, 'utf8'));

const rows = Math.ceil(entries.length / COLS);
const W = COLS * (CELL + PAD) + PAD;
const H = rows * (CELL + PAD) + PAD;
const sheet = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  sheet[i * 4] = 30;
  sheet[i * 4 + 1] = 30;
  sheet[i * 4 + 2] = 36;
  sheet[i * 4 + 3] = 255;
}

function put(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  sheet[i] = r;
  sheet[i + 1] = g;
  sheet[i + 2] = b;
}

for (let idx = 0; idx < entries.length; idx++) {
  const e = entries[idx];
  const cx = PAD + (idx % COLS) * (CELL + PAD);
  const cy = PAD + Math.floor(idx / COLS) * (CELL + PAD);

  const imgPath = path.join(root, 'public', e.image.replace(/^\//, ''));
  let img;
  try {
    img = decodePng(await readFile(imgPath));
  } catch (err) {
    console.error(`${e.id}: ${err.message}`);
    continue;
  }

  const scale = Math.min(CELL / img.width, CELL / img.height);
  const dw = Math.max(1, Math.round(img.width * scale));
  const dh = Math.max(1, Math.round(img.height * scale));
  const ox = cx + Math.floor((CELL - dw) / 2);
  const oy = cy + Math.floor((CELL - dh) / 2);

  // Magenta cell backdrop, then the garment composited over it.
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) put(cx + x, cy + y, BG[0], BG[1], BG[2]);

  for (let y = 0; y < dh; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4;
      const a = img.rgba[si + 3] / 255;
      if (a <= 0) continue;
      put(
        ox + x,
        oy + y,
        Math.round(img.rgba[si] * a + BG[0] * (1 - a)),
        Math.round(img.rgba[si + 1] * a + BG[1] * (1 - a)),
        Math.round(img.rgba[si + 2] * a + BG[2] * (1 - a)),
      );
    }
  }

  // Anchor dots (yellow), so misplaced anchors are visible at a glance.
  for (const [, p] of Object.entries(e.anchors ?? {})) {
    const ax = ox + Math.round(p[0] * scale);
    const ay = oy + Math.round(p[1] * scale);
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + dy * dy <= 9) put(ax + dx, ay + dy, 250, 204, 21);
    }
  }
}

await writeFile(outPath, encodePng(W, H, sheet));
console.log(`wrote ${outPath} (${W}x${H}, ${entries.length} garments, ${COLS} per row)`);
console.log('order:');
entries.forEach((e, i) => {
  if (i % COLS === 0) process.stdout.write(`  row ${Math.floor(i / COLS) + 1}: `);
  process.stdout.write(e.id + (i % COLS === COLS - 1 || i === entries.length - 1 ? '\n' : ', '));
});
