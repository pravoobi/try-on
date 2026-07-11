/**
 * One-off utility: crops N rows off the top of a garment PNG (to remove a
 * source model's head/hair bleeding into the TPS warp's anchor-bbox margin
 * above the shoulder line — see CLAUDE.md gotcha "anchor quality dominates
 * output quality") and shifts every anchor's Y coordinate by the same
 * amount in catalog.json.
 *
 * Minimal hand-rolled PNG decoder (IHDR + IDAT inflate + unfilter) paired
 * with the existing encoder from generate-placeholder-garments.mjs — no
 * image-library dependency, and avoids the browser download round-trip
 * (Chrome's per-origin automatic-download limit blocks repeated
 * script-triggered downloads after the first few in this session).
 *
 * Usage: node tools/crop-garment-top.mjs <garment-id> <cropPixels>
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const garmentsDir = path.join(root, 'public', 'garments');
const catalogPath = path.join(root, 'src', 'garments', 'catalog.json');

const [, , garmentId, cropArg] = process.argv;
const cropPixels = Number(cropArg);
if (!garmentId || !Number.isFinite(cropPixels) || cropPixels <= 0) {
  console.error('usage: node tools/crop-garment-top.mjs <garment-id> <cropPixels>');
  process.exit(1);
}

// --- Minimal PNG decoder (8-bit RGBA, any standard filter type) -----------

function readChunks(buf) {
  const chunks = [];
  let offset = 8; // skip signature
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    chunks.push({ type, data });
    offset += 12 + len; // length + type + data + crc
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`only 8-bit RGBA PNGs supported (got bitDepth=${bitDepth} colorType=${colorType})`);
  }
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const bpp = 4; // bytes per pixel (RGBA)
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevRowStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevRowStart + x - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + Math.floor((a + b) / 2); break;
        case 4: value = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter type ${filterType}`);
      }
      out[rowStart + x] = value & 0xff;
    }
    rawOffset += stride;
  }
  return { width, height, rgba: out };
}

// --- Minimal PNG encoder (filter type 0 — matches generate-placeholder-garments.mjs) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
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
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- Crop + shift anchors --------------------------------------------------

const pngPath = path.join(garmentsDir, `${garmentId}.png`);
const { width, height, rgba } = decodePng(await readFile(pngPath));
if (cropPixels >= height) throw new Error(`cropPixels ${cropPixels} >= image height ${height}`);

const newHeight = height - cropPixels;
const stride = width * 4;
const cropped = rgba.subarray(cropPixels * stride, height * stride);
await writeFile(pngPath, encodePng(width, newHeight, Buffer.from(cropped)));
console.log(`${garmentId}.png: ${width}x${height} -> ${width}x${newHeight} (cropped ${cropPixels}px off top)`);

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const entry = catalog.find((g) => g.id === garmentId);
if (!entry) throw new Error(`no catalog entry for id "${garmentId}"`);
for (const key of Object.keys(entry.anchors)) {
  entry.anchors[key][1] = Math.round((entry.anchors[key][1] - cropPixels) * 10) / 10;
}
await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`catalog.json: shifted ${garmentId} anchors up by ${cropPixels}px`);
