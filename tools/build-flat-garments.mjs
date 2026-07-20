/**
 * Builds catalog-ready garment cutouts from FLAT product photography —
 * flat-lay, hanger, or ghost-mannequin shots on a plain studio background,
 * with no person in frame.
 *
 * Sibling of tools/extract-worn-garments.mjs, and the two are not
 * interchangeable: that one runs MODNet + SegFormer to strip a WEARER out
 * of an on-model shot. Here there is no wearer, so that machinery has
 * nothing to do and its "which half of the outfit?" question is
 * meaningless. What these photos need is background keying, which is pure
 * geometry — no models, no downloads, and a few seconds for the whole
 * batch instead of several minutes.
 *
 * Background removal is the flood-fill keyer ported from
 * tools/process-new-garments.mjs: a pixel goes transparent only if it is
 * CONNECTED to the image border through other background-coloured pixels.
 * Plain per-pixel colour distance punches holes through light print motifs
 * that happen to match the backdrop; connectivity can't, because an
 * interior motif is never reachable from outside the garment. The
 * background estimate itself is an inverse-distance-weighted grid sampled
 * along the whole border, which handles a vignette as well as a flat
 * colour.
 *
 * Adds over that tool: a manifest (stable ids, categories, meta, optional
 * back photos) so output lands straight in catalog shape, category-aware
 * anchor suggestion, and speck pruning that removes the AI-generation
 * "sparkle" watermark these photos carry in a corner while keeping
 * legitimately-detached garment parts such as a flat-photographed choli.
 *
 * Usage:
 *   node tools/build-flat-garments.mjs             # whole manifest
 *   node tools/build-flat-garments.mjs kurti pant  # ids matching a substring
 *
 * Writes cutouts to public/garments/ and tools/flat-garments.json for
 * review (see tools/garment-contact-sheet.mjs) before merging into
 * src/garments/catalog.json.
 *
 * Anchors are a STARTING POINT (CLAUDE.md: "anchor quality dominates
 * output quality") — check them on the contact sheet, and render any
 * puff/gathered-sleeve garment against a test photo before trusting it.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { suggestAnchors, suggestPantsAnchors } from '@practics/tryon-core';

/**
 * Per-garment keying strategy.
 *
 * 'color' (default): the flood-fill keyer described above. Fast, exact,
 * no models — but it decides by COLOUR DISTANCE from the backdrop, so a
 * white shirt on a white sweep is indistinguishable from the sweep and
 * gets eaten. Observed on this batch: a white kurti reduced to fragments,
 * gashes through white denim shorts, and the pale cholis of several
 * lehengas erased entirely, leaving skirt-only cutouts.
 *
 * 'ml': MODNet foreground matting, the same model the browser upload flow
 * uses. It segments by learned salient-foreground semantics rather than
 * colour, so white-on-white is not the pathological case it is for a
 * keyer. Slower and needs the model, so it's opt-in per garment rather
 * than the default.
 */
const KEYERS = ['color', 'ml'];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'tools', 'raw-garments');
const outDir = path.join(root, 'public', 'garments');

/**
 * Colour distance from the local background estimate at which a pixel
 * stops counting as background. Only applied along connected paths from
 * the border (see floodFillBackgroundMask).
 */
const KEY_THRESHOLD = 45;

/**
 * The catalog manifest. Ids and categories live here rather than being
 * inferred from filenames: `category` drives which anchor heuristic runs
 * and how the garment renders, and neither is reliably guessable from a
 * name. `sleeves` deliberately stays 'sleeveless' unless the garment has
 * fitted, straight-hanging sleeves — sleeve ANCHORS are only worth adding
 * for those (a bell or flared sleeve hangs away from the arm, so pinning
 * its cuff to the forearm pulls the flare in; see the kurti regression
 * noted in docs/production-gaps.md). Sleeve anchors are not emitted by
 * this tool at all; add them by hand, verified, per garment.
 */
const GARMENTS = [
  // --- trousers (category 'pants', ankle) ---
  { id: 'pants-black-formal', src: 'black-pant-formal.png', category: 'pants', length: 'ankle' },
  { id: 'pants-black-pleated-wide', src: 'black-pant-pleated-wide.png', category: 'pants', length: 'ankle' },
  { id: 'pants-brown-regular', src: 'brown-pant-regular-fit.png', category: 'pants', length: 'ankle' },
  { id: 'pants-navy-straight', src: 'navy-pant-straight-fit.png', category: 'pants', length: 'ankle' },
  { id: 'pants-blue-regular', src: 'pant-blue-regular.png', category: 'pants', length: 'ankle' },
  { id: 'pants-cream-straight', keyer: 'ml', src: 'pant-striaght-fit-cream.png', category: 'pants', length: 'ankle' },
  { id: 'pants-olive-01', src: 'pants-1.png', category: 'pants', length: 'ankle' },
  { id: 'pants-red-01', src: 'red-pant.png', category: 'pants', length: 'ankle' },

  // --- shorts (category 'pants', knee) ---
  { id: 'shorts-corduroy', src: 'cordury-shorts.png', category: 'pants', length: 'knee' },
  // NOTE: this one is a wrap SKORT, not two-legged shorts. There is no
  // skirt category for a lower-body single piece, so it renders through
  // the pants path; check it on the contact sheet before shipping.
  { id: 'shorts-black-high-rise', src: 'high-rise-shorts-black.png', category: 'pants', length: 'knee' },
  { id: 'shorts-relaxed-denim', src: 'relaxed-denim-shorts.png', category: 'pants', length: 'knee' },
  { id: 'shorts-relaxed-fit-denim', src: 'relaxed-fit-denim-shorts.png', category: 'pants', length: 'knee' },
  { id: 'shorts-green-skinny', src: 'skinny-fit-shorts-green.png', category: 'pants', length: 'knee' },
  { id: 'shorts-white-denim', keyer: 'ml', src: 'white-denim-fit-shorts.png', category: 'pants', length: 'knee' },

  // --- shirts ---
  { id: 'shirt-denim-casual', src: 'casual-denim-shirt-front.png', category: 'shirt', sleeves: 'full', length: 'hip' },
  { id: 'shirt-striped-casual', keyer: 'ml', src: 'casual-striped-shirt-front.png', category: 'shirt', sleeves: 'half', length: 'hip' },
  { id: 'shirt-pink-formal', src: 'formal-shirt-front.png', back: 'formal-shirt-back.png', category: 'shirt', sleeves: 'half', length: 'hip' },
  { id: 'shirt-white-01', keyer: 'ml', src: 'white-shirt-front-1.png', back: 'white-shirt-back-1.png', category: 'shirt', sleeves: 'full', length: 'hip' },

  // --- t-shirts ---
  { id: 'tshirt-green-printed', src: 'cotton-tshirt-printed-green-front.png', category: 'tshirt', sleeves: 'half', length: 'hip' },
  { id: 'tshirt-polo-collared', src: 'pollo-collared-tshirt-front.png', back: 'pollo-collared-tshirt-back.png', category: 'tshirt', sleeves: 'half', length: 'hip' },
  { id: 'tshirt-yellow-vneck', src: 'vneck-tshirt-yellow-front.png', back: 'vneck-tshirt-yellow-back.png', category: 'tshirt', sleeves: 'half', length: 'hip' },

  // --- kurtis ---
  { id: 'kurti-flare-sleeve', src: 'flare-sleeve-top-kurti.png', category: 'kurti', sleeves: 'full', length: 'hip' },
  { id: 'kurti-floral-printed-02', src: 'floarl-printed-kurti-front-2.png', category: 'kurti', sleeves: 'sleeveless', length: 'knee' },
  { id: 'kurti-floral-printed-01', src: 'floral-printed-kurti-front.png', category: 'kurti', sleeves: 'sleeveless', length: 'knee' },
  { id: 'kurti-motifs-printed', src: 'motifs-printed-kurti-front.png', category: 'kurti', sleeves: 'half', length: 'knee' },
  { id: 'kurti-white-short', keyer: 'ml', src: 'white-short-kurti-front.png', back: 'white-short-kurti-back.png', category: 'kurti', sleeves: 'half', length: 'knee' },

  // --- lehenga-choli (single image: choli + skirt together, which is how
  //     real lehenga photography ships — renders through the 6-anchor path
  //     with the skirt's hem flare, see schema SingleImageLehengaGarment) ---
  { id: 'lehenga-embroidered', src: 'embroided-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-kushal-printed', keyer: 'ml', src: 'kushal-printed-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-sharara', keyer: 'ml', src: 'lehnga-choli-sharara.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-yellow', keyer: 'ml', src: 'lehnga-choli-yellow.png', category: 'lehenga-choli', sleeves: 'sleeveless', length: 'ankle' },
  { id: 'lehenga-pink', src: 'pink-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-printed', src: 'printed-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-sangria', keyer: 'ml', src: 'sangria-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-sequined', src: 'sequined-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
  { id: 'lehenga-puff-sleeve', src: 'suppar-sleeve-lehnga-choli.png', category: 'lehenga-choli', sleeves: 'half', length: 'ankle' },
];

// ---------------------------------------------------------------------------
// Minimal PNG decode/encode (8-bit RGBA)
// ---------------------------------------------------------------------------

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
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    chunks.push({ type: buf.toString('ascii', off + 4, off + 8), data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType}); need 8-bit RGB or RGBA`);
  }
  const srcBpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * srcBpp;
  const unfiltered = Buffer.alloc(height * stride);
  let ro = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[ro++];
    const rs = y * stride;
    const prs = rs - stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[ro + x];
      const a = x >= srcBpp ? unfiltered[rs + x - srcBpp] : 0;
      const b = y > 0 ? unfiltered[prs + x] : 0;
      const c = y > 0 && x >= srcBpp ? unfiltered[prs + x - srcBpp] : 0;
      let v;
      switch (ft) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + Math.floor((a + b) / 2); break;
        case 4: v = rb + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${ft}`);
      }
      unfiltered[rs + x] = v & 0xff;
    }
    ro += stride;
  }
  if (srcBpp === 4) return { width, height, rgba: unfiltered };
  // Widen RGB to RGBA so the rest of the pipeline has one shape to handle.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = unfiltered[i * 3];
    rgba[i * 4 + 1] = unfiltered[i * 3 + 1];
    rgba[i * 4 + 2] = unfiltered[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

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

// ---------------------------------------------------------------------------
// Flood-fill background removal (ported from tools/process-new-garments.mjs)
// ---------------------------------------------------------------------------

function samplePatch(data, width, height, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 4;
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
  }
  return n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
}

/** Border samples feed an IDW grid, which copes with a vignette as well as a flat backdrop. */
function buildBackgroundGrid(data, w, h, gridSize = 24, stepPx = 24, radius = 4) {
  const points = [];
  const add = (x, y) => points.push({ x, y, rgb: samplePatch(data, w, h, x, y, radius) });
  for (let x = radius; x < w - radius; x += stepPx) {
    add(x, radius);
    add(x, h - 1 - radius);
  }
  for (let y = radius; y < h - radius; y += stepPx) {
    add(radius, y);
    add(w - 1 - radius, y);
  }
  const grid = new Float32Array(gridSize * gridSize * 3);
  for (let gy = 0; gy < gridSize; gy++) {
    const py = (gy / (gridSize - 1)) * (h - 1);
    for (let gx = 0; gx < gridSize; gx++) {
      const px = (gx / (gridSize - 1)) * (w - 1);
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (const p of points) {
        const dx = p.x - px, dy = p.y - py;
        const weight = 1 / (dx * dx + dy * dy + 1);
        sr += p.rgb[0] * weight; sg += p.rgb[1] * weight; sb += p.rgb[2] * weight; sw += weight;
      }
      const i = (gy * gridSize + gx) * 3;
      grid[i] = sr / sw; grid[i + 1] = sg / sw; grid[i + 2] = sb / sw;
    }
  }
  return { grid, gridSize };
}

function bgAt(grid, gridSize, w, h, x, y) {
  const gx = (x / (w - 1)) * (gridSize - 1);
  const gy = (y / (h - 1)) * (gridSize - 1);
  const gx0 = Math.floor(gx), gy0 = Math.floor(gy);
  const gx1 = Math.min(gridSize - 1, gx0 + 1), gy1 = Math.min(gridSize - 1, gy0 + 1);
  const fx = gx - gx0, fy = gy - gy0;
  const at = (ix, iy, c) => grid[(iy * gridSize + ix) * 3 + c];
  const lerp = (a, b, t) => a + (b - a) * t;
  return [0, 1, 2].map((c) => lerp(lerp(at(gx0, gy0, c), at(gx1, gy0, c), fx), lerp(at(gx0, gy1, c), at(gx1, gy1, c), fx), fy));
}

/** Transparent only where reachable from the border through background-like pixels. */
function removeBackground(rgba, w, h, threshold = KEY_THRESHOLD) {
  const data = Buffer.from(rgba);
  const { grid, gridSize } = buildBackgroundGrid(data, w, h);
  const n = w * h;
  const isBg = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  const near = (idx) => {
    const x = idx % w;
    const y = (idx - x) / w;
    const i = idx * 4;
    const [br, bg2, bb] = bgAt(grid, gridSize, w, h, x, y);
    const dr = data[i] - br, dg = data[i + 1] - bg2, db = data[i + 2] - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
  };
  const seed = (idx) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    if (near(idx)) { isBg[idx] = 1; stack[sp++] = idx; }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) seed(idx - 1);
    if (x < w - 1) seed(idx + 1);
    if (y > 0) seed(idx - w);
    if (y < h - 1) seed(idx + w);
  }

  for (let i = 0; i < n; i++) data[i * 4 + 3] = isBg[i] ? 0 : 255;

  // 3x3 mean on alpha only — softens the hard key into a feathered edge.
  const src = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) src[i] = data[i * 4 + 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          sum += src[ny * w + nx]; cnt++;
        }
      }
      data[(y * w + x) * 4 + 3] = Math.round(sum / cnt);
    }
  }
  return data;
}

/**
 * Drops opaque components that are insignificant next to the biggest one —
 * NOT "keep exactly one piece".
 *
 * The point is the small AI-generation "sparkle" watermark these photos
 * carry in a corner: it survives keying as its own blob and, being
 * disconnected, corrupts the alpha bbox far more than its size suggests,
 * dragging the crop (and every suggested anchor with it) out toward the
 * corner. A watermark is a fraction of a percent of the garment.
 *
 * Keeping only the single largest component is too strong, because plenty
 * of garments are legitimately made of disconnected parts: a lehenga-choli
 * photographed flat has the choli floating clear above the skirt with bare
 * midriff between them, and "largest only" silently deleted the choli,
 * yielding skirt-only cutouts that looked like a keying failure. Anything
 * within `minFracOfLargest` of the biggest piece is real garment.
 */
function keepSignificantComponents(data, w, h, threshold = 100, minFracOfLargest = 0.02) {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || data[start * 4 + 3] <= threshold) continue;
    const label = sizes.length;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let size = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      size++;
      const x = idx % w;
      const y = (idx - x) / w;
      const nb = [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1, y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1];
      for (const m of nb) {
        if (m >= 0 && labels[m] === -1 && data[m * 4 + 3] > threshold) { labels[m] = label; stack[sp++] = m; }
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return;
  const largest = Math.max(...sizes);
  const minSize = largest * minFracOfLargest;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1 && sizes[labels[i]] < minSize) data[i * 4 + 3] = 0;
  }
}

function cropToAlphaBBox(rgba, width, height, marginFrac = 0.04) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const mx = Math.round(bw * marginFrac), my = Math.round(bh * marginFrac);
  const cx = Math.max(0, minX - mx), cy = Math.max(0, minY - my);
  const cw = Math.min(width, maxX + mx + 1) - cx, ch = Math.min(height, maxY + my + 1) - cy;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const s = ((y + cy) * width + cx) * 4;
    out.set(rgba.subarray(s, s + cw * 4), y * cw * 4);
  }
  return { rgba: out, width: cw, height: ch };
}

function coverage(rgba, w, h) {
  let n = 0;
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] > 127) n++;
  return n / (w * h);
}

const round1 = (p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];

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

/** Lazily loaded — only garments marked keyer:'ml' pay the model cost. */
let matter = null;
let RawImageRef = null;
async function mattePng(absPath) {
  if (!matter) {
    const tf = await import('@huggingface/transformers');
    tf.env.allowLocalModels = false;
    RawImageRef = tf.RawImage;
    console.log('  (loading MODNet for ml-keyed garments…)');
    matter = await tf.pipeline('background-removal', 'Xenova/modnet');
  }
  const out = await matter(await RawImageRef.read(absPath));
  const img = Array.isArray(out) ? out[0] : out;
  return { width: img.width, height: img.height, rgba: Buffer.from(img.data) };
}

async function cutout(fileName, keyer) {
  const abs = path.join(srcDir, fileName);
  let width, height, keyed;
  if (keyer === 'ml') {
    ({ width, height, rgba: keyed } = await mattePng(abs));
  } else {
    const src = decodePng(await readFile(abs));
    width = src.width;
    height = src.height;
    keyed = removeBackground(src.rgba, width, height);
  }
  keepSignificantComponents(keyed, width, height);
  const cropped = cropToAlphaBBox(keyed, width, height);
  if (!cropped) return { error: 'nothing left after background removal' };
  return { cropped, kept: coverage(keyed, width, height) };
}

const entries = [];
const problems = [];

for (const g of selected) {
  if (!available.has(g.src)) {
    problems.push(`${g.id}: source ${g.src} not found`);
    continue;
  }
  try {
    const keyer = g.keyer ?? 'color';
    if (!KEYERS.includes(keyer)) {
      problems.push(`${g.id}: unknown keyer '${keyer}' (expected ${KEYERS.join('/')})`);
      continue;
    }
    const front = await cutout(g.src, keyer);
    if (front.error) {
      problems.push(`${g.id}: ${front.error}`);
      continue;
    }
    const { cropped, kept } = front;
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
      anchors: Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, round1(v)])),
      meta: { sleeves: g.sleeves ?? 'sleeveless', length: g.length },
    };

    if (g.back && available.has(g.back)) {
      const back = await cutout(g.back, keyer);
      if (back.error) {
        problems.push(`${g.id}: back photo — ${back.error} (front saved)`);
      } else {
        const backAnchors = suggestAnchors(back.cropped.rgba, back.cropped.width, back.cropped.height);
        if (!backAnchors) {
          problems.push(`${g.id}: back photo anchors failed (front saved)`);
        } else {
          const backFile = `${g.id}-back.png`;
          await writeFile(path.join(outDir, backFile), encodePng(back.cropped.width, back.cropped.height, back.cropped.rgba));
          entry.back = {
            image: `/garments/${backFile}`,
            anchors: Object.fromEntries(Object.entries(backAnchors).map(([k, v]) => [k, round1(v)])),
          };
        }
      }
    }

    entries.push(entry);
    console.log(
      `${g.id.padEnd(26)} ${String(cropped.width).padStart(4)}x${String(cropped.height).padStart(4)}` +
        `  kept ${(kept * 100).toFixed(1).padStart(5)}%  ${keyer.padEnd(5)}${entry.back ? ' (+back)' : ''}`,
    );
  } catch (err) {
    problems.push(`${g.id}: ${err?.message ?? err}`);
  }
}

console.log(`\n--- ${entries.length} succeeded, ${problems.length} problem(s) ---`);
for (const p of problems) console.log(`  ! ${p}`);

await writeFile(path.join(root, 'tools', 'flat-garments.json'), `${JSON.stringify(entries, null, 2)}\n`);
console.log(`\nwrote tools/flat-garments.json — review with tools/garment-contact-sheet.mjs before merging`);
