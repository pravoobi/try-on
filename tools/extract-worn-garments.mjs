/**
 * Batch-extracts garments from ON-MODEL product photos, Node-side.
 *
 * This is the ML sibling of tools/process-new-garments.mjs. That tool keys
 * out a flat studio BACKGROUND with a flood fill — fine for a flat-lay or
 * hanger shot, useless when a person is wearing the garment, since the
 * person is foreground and survives the key. This tool runs the same two
 * models the browser upload flow uses (MODNet for the foreground matte,
 * SegFormer human-parsing for per-pixel garment/body-part labels) and
 * reuses tryon-core's own `extractGarmentAlpha` so batch output matches
 * what the in-app upload flow would produce, pixel for pixel.
 *
 * Usage:
 *   node tools/extract-worn-garments.mjs                # every mapped file
 *   node tools/extract-worn-garments.mjs jeans shirt    # only ids matching a substring
 *
 * Reads the GARMENTS manifest below (id/source/category/meta live there,
 * not inferred from filenames — the category decides which half of a worn
 * outfit gets kept, and that can't be guessed reliably from a filename).
 * Writes cutout PNGs to public/garments/ and a tools/extracted-garments.json
 * of suggested anchors to review and merge into src/garments/catalog.json.
 *
 * Anchors are a STARTING POINT (CLAUDE.md: "anchor quality dominates output
 * quality") — verify each against a test photo before trusting it,
 * especially shoulders on puff/gathered sleeves.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { env, pipeline, RawImage } from '@huggingface/transformers';
// tryon-core's own cropToAlphaBBox needs a canvas; this file has a Node
// port below. The extraction + anchor heuristics are pure and reused as-is,
// so batch output matches the in-app upload flow exactly.
import { extractGarmentAlpha, suggestAnchors, suggestPantsAnchors } from '@practics/tryon-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'tools', 'raw-garments');
const outDir = path.join(root, 'public', 'garments');

env.allowLocalModels = false; // pull from the Hub, same as the browser worker

const MATTING_MODEL_ID = 'Xenova/modnet';
const PARSING_MODEL_ID = 'Xenova/segformer_b2_clothes';

/** Mirrors config.garmentExtract in the app. */
const EXTRACT_CONFIG = { humanPresenceFrac: 0.05, minGarmentFrac: 0.05, maskBlurPx: 2 };

/**
 * The catalog manifest for this batch. `target` follows from category
 * (pants/shorts are 'lower'), and meta.sleeves drives whether the anchor
 * editor/renderer will look for sleeve anchors later.
 */
const GARMENTS = [
  // --- pants (category 'pants', hem 'ankle') ---
  { id: 'pants-black-formal', src: 'black-pant-formal.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-black-pleated-wide', src: 'black-pant-pleated-wide.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-brown-regular', src: 'brown-pant-regular-fit.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-navy-straight', src: 'navy-pant-straight-fit.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-blue-regular', src: 'pant-blue-regular.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-cream-straight', src: 'pant-striaght-fit-cream.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-olive-01', src: 'pants-1.jpg', category: 'pants', length: 'ankle' },
  { id: 'pants-red-01', src: 'red-pant.jpg', category: 'pants', length: 'ankle' },

  // --- shorts (category 'pants', hem 'knee') ---
  { id: 'shorts-corduroy', src: 'cordury-shorts.jpg', category: 'pants', length: 'knee' },
  { id: 'shorts-black-high-rise', src: 'high-rise-shorts-black.jpg', category: 'pants', length: 'knee' },
  { id: 'shorts-relaxed-denim', src: 'relaxed-denim-shorts.jpg', category: 'pants', length: 'knee' },
  { id: 'shorts-relaxed-fit-denim', src: 'relaxed-fit-denim-shorts.jpg', category: 'pants', length: 'knee' },
  { id: 'shorts-green-skinny', src: 'skinny-fit-shorts-green.jpg', category: 'pants', length: 'knee' },
  { id: 'shorts-white-denim', src: 'white-denim-fit-shorts.jpg', category: 'pants', length: 'knee' },

  // --- shirts ---
  { id: 'shirt-denim-casual', src: 'casual-denim-shirt-front.jpg', category: 'shirt', sleeves: 'full', length: 'hip' },
  { id: 'shirt-striped-casual', src: 'casual-striped-shirt-front.jpg', category: 'shirt', sleeves: 'full', length: 'hip' },
  {
    id: 'shirt-pink-formal',
    src: 'formal-shirt-front.jpg',
    back: 'formal-shirt-back.jpg',
    category: 'shirt',
    sleeves: 'half',
    length: 'hip',
  },
  {
    id: 'shirt-white-01',
    src: 'white-shirt-front-1.jpg',
    back: 'white-shirt-back-1.jpg',
    category: 'shirt',
    sleeves: 'full',
    length: 'hip',
  },

  // --- t-shirts ---
  {
    id: 'tshirt-green-printed',
    src: 'cotton-tshirt-printed-green-front.jpg',
    category: 'tshirt',
    sleeves: 'half',
    length: 'hip',
  },
  {
    id: 'tshirt-polo-collared',
    src: 'pollo-collared-tshirt-front.jpg',
    back: 'pollo-collared-tshirt-back.jpg',
    category: 'tshirt',
    sleeves: 'half',
    length: 'hip',
  },
  {
    id: 'tshirt-yellow-vneck',
    src: 'vneck-tshirt-yellow-front.jpg',
    back: 'vneck-tshirt-yellow-back.jpg',
    category: 'tshirt',
    sleeves: 'half',
    length: 'hip',
  },

  // --- kurtis ---
  { id: 'kurti-flare-sleeve', src: 'flare-sleeve-top-kurti.jpg', category: 'kurti', sleeves: 'full', length: 'hip' },
  { id: 'kurti-floral-printed-02', src: 'floarl-printed-kurti-front-2.jpg', category: 'kurti', sleeves: 'sleeveless', length: 'knee' },
  { id: 'kurti-floral-printed-01', src: 'floral-printed-kurti-front.jpg', category: 'kurti', sleeves: 'sleeveless', length: 'knee' },
  { id: 'kurti-motifs-printed', src: 'motifs-printed-kurti-front.jpg', category: 'kurti', sleeves: 'half', length: 'knee' },
  {
    id: 'kurti-white-short',
    src: 'white-short-kurti-front.jpg',
    back: 'white-short-kurti-back.jpg',
    category: 'kurti',
    sleeves: 'half',
    length: 'knee',
  },
];

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA) — same as the sibling tools
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Alpha-bbox crop (Node port of tryon-core's cropToAlphaBBox, which needs a canvas)
// ---------------------------------------------------------------------------

function findAlphaBBox(rgba, w, h, threshold = 10) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function cropToAlphaBBox(rgba, width, height, marginFrac = 0.04) {
  const bbox = findAlphaBBox(rgba, width, height);
  if (!bbox) return null;
  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const mx = Math.round(bw * marginFrac);
  const my = Math.round(bh * marginFrac);
  const cropX = Math.max(0, bbox.minX - mx);
  const cropY = Math.max(0, bbox.minY - my);
  const cropW = Math.min(width, bbox.maxX + mx + 1) - cropX;
  const cropH = Math.min(height, bbox.maxY + my + 1) - cropY;

  const out = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    const srcStart = ((y + cropY) * width + cropX) * 4;
    out.set(rgba.subarray(srcStart, srcStart + cropW * 4), y * cropW * 4);
  }
  return { rgba: out, width: cropW, height: cropH };
}

/** Fraction of opaque pixels — a sanity signal that extraction kept something real. */
function coverage(rgba, w, h) {
  let n = 0;
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] > 127) n++;
  return n / (w * h);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const filters = process.argv.slice(2);
const selected = filters.length
  ? GARMENTS.filter((g) => filters.some((f) => g.id.includes(f) || g.src.includes(f)))
  : GARMENTS;

if (selected.length === 0) {
  console.error(`no garments matched ${JSON.stringify(filters)}`);
  process.exit(1);
}

const available = new Set(await readdir(srcDir));
console.log(`loading models (first run downloads ~200MB)…`);
const matter = await pipeline('background-removal', MATTING_MODEL_ID);
const parser = await pipeline('image-segmentation', PARSING_MODEL_ID);
console.log(`models ready; processing ${selected.length} garment(s)\n`);

/** Runs matte + parse + extraction for one photo, returning a cropped RGBA cutout. */
async function extractOne(fileName, target) {
  const image = await RawImage.read(path.join(srcDir, fileName));
  const mattedOut = await matter(image);
  // transformers.js returns either a RawImage or a 1-element array of one,
  // depending on version/task wiring — accept both rather than pinning.
  const matted = Array.isArray(mattedOut) ? mattedOut[0] : mattedOut;
  const segments = await parser(image);

  const w = matted.width;
  const h = matted.height;
  const rgba = Buffer.from(matted.data);
  const foregroundAlpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < foregroundAlpha.length; i++) foregroundAlpha[i] = rgba[i * 4 + 3];

  const labelMasks = segments
    .filter((s) => s.label && s.mask.width === w && s.mask.height === h)
    .map((s) => ({ label: s.label, maskData: new Uint8ClampedArray(s.mask.data) }));

  const extraction = extractGarmentAlpha(foregroundAlpha, labelMasks, w, h, {
    ...EXTRACT_CONFIG,
    target,
  });
  if (extraction.kind !== 'garment') {
    return { error: extraction.kind, labels: labelMasks.map((m) => m.label) };
  }
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = extraction.alpha[i];

  const cropped = cropToAlphaBBox(rgba, w, h);
  if (!cropped) return { error: 'empty-after-extraction', labels: [] };
  return { cropped, sourceCoverage: coverage(rgba, w, h) };
}

const entries = [];
const problems = [];

for (const g of selected) {
  const target = g.category === 'pants' ? 'lower' : 'upper';
  if (!available.has(g.src)) {
    problems.push(`${g.id}: source file ${g.src} not found`);
    continue;
  }
  try {
    const front = await extractOne(g.src, target);
    if (front.error) {
      problems.push(`${g.id}: extraction returned '${front.error}' (labels seen: ${front.labels.join(', ') || 'none'})`);
      continue;
    }
    const { cropped, sourceCoverage } = front;
    const anchors =
      g.category === 'pants'
        ? suggestPantsAnchors(cropped.rgba, cropped.width, cropped.height)
        : suggestAnchors(cropped.rgba, cropped.width, cropped.height);
    if (!anchors) {
      problems.push(`${g.id}: could not suggest anchors`);
      continue;
    }

    const file = `${g.id}.png`;
    await writeFile(path.join(outDir, file), encodePng(cropped.width, cropped.height, cropped.rgba));

    const entry = {
      id: g.id,
      category: g.category,
      image: `/garments/${file}`,
      anchors: Object.fromEntries(
        Object.entries(anchors).map(([k, v]) => [k, [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10]]),
      ),
      meta: { sleeves: g.sleeves ?? 'sleeveless', length: g.length },
    };

    if (g.back && available.has(g.back)) {
      const back = await extractOne(g.back, target);
      if (back.error) {
        problems.push(`${g.id}: BACK photo returned '${back.error}' — saved front only`);
      } else {
        const backAnchors = suggestAnchors(back.cropped.rgba, back.cropped.width, back.cropped.height);
        if (backAnchors) {
          const backFile = `${g.id}-back.png`;
          await writeFile(
            path.join(outDir, backFile),
            encodePng(back.cropped.width, back.cropped.height, back.cropped.rgba),
          );
          entry.back = {
            image: `/garments/${backFile}`,
            anchors: Object.fromEntries(
              Object.entries(backAnchors).map(([k, v]) => [k, [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10]]),
            ),
          };
        } else {
          problems.push(`${g.id}: BACK photo anchors failed — saved front only`);
        }
      }
    }

    entries.push(entry);
    const pct = (sourceCoverage * 100).toFixed(1);
    console.log(
      `${g.id.padEnd(28)} ${String(cropped.width).padStart(4)}x${String(cropped.height).padStart(4)}` +
        `  kept ${pct.padStart(5)}% of frame${entry.back ? '  (+back)' : ''}`,
    );
  } catch (err) {
    problems.push(`${g.id}: ${err?.message ?? err}`);
  }
}

console.log(`\n--- ${entries.length} succeeded, ${problems.length} problem(s) ---`);
for (const p of problems) console.log(`  ! ${p}`);

await writeFile(path.join(root, 'tools', 'extracted-garments.json'), `${JSON.stringify(entries, null, 2)}\n`);
console.log(`\nwrote tools/extracted-garments.json (${entries.length} entries) — review, then merge into src/garments/catalog.json`);
