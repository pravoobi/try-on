/**
 * One-off utility: turns raw product photos in public/garments/new/ (flat
 * gray/white studio backgrounds, fully opaque) into catalog-ready garment
 * PNGs — background removal (port of tools/remove-background.html's
 * corner-sampled bilinear key, so results match what that tool would
 * produce, done Node-side to avoid Chrome's per-origin download-limit
 * gotcha for a multi-file batch — see docs memory), crop to the alpha
 * bounding box (+ small margin, matches pipeline/autoAnchor.ts's
 * cropToAlphaBBox), and auto-suggested anchors (port of pipeline/
 * autoAnchor.ts's suggestAnchors — same heuristic, see that file for the
 * reasoning). Anchors are a STARTING POINT ONLY (CLAUDE.md: "anchor
 * quality dominates output quality") — verify visually before trusting.
 *
 * Usage: node tools/process-new-garments.mjs
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'public', 'garments', 'new');
const outDir = path.join(root, 'public', 'garments');

// --- Minimal PNG decoder (8-bit RGBA only — matches crop-garment-top.mjs) ---

function readChunks(buf) {
  const chunks = [];
  let offset = 8;
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    chunks.push({ type, data });
    offset += 12 + len;
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
  const bpp = 4;
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

// --- Minimal PNG encoder (matches generate-placeholder-garments.mjs) ---

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

// --- Background removal (port of tools/remove-background.html) ---

function sampleCorner(data, width, height, cx, cy, r) {
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

function despeckleAlpha(data, w, h) {
  const src = new Uint8ClampedArray(data.length);
  for (let i = 3; i < data.length; i += 4) src[i] = data[i];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          sum += src[(ny * w + nx) * 4 + 3];
          n++;
        }
      }
      data[(y * w + x) * 4 + 3] = Math.round(sum / n);
    }
  }
}

/**
 * Background color model: inverse-distance-weighted interpolation from
 * samples all along the image BORDER (not just the 4 corners) onto a
 * coarse grid, bilinearly upsampled per-pixel. A pure 4-corner bilinear
 * model (tools/remove-background.html's browser version) assumes the
 * background varies linearly corner-to-corner — true for a flat color or
 * a simple directional gradient, but one of these real product photos
 * turned out to have a RADIAL vignette (brighter in the center, darker
 * toward every edge including mid-top/mid-bottom/mid-sides), which a
 * 4-corner bilinear fit systematically underestimates in the middle of
 * each edge — discovered by inspecting raw edge pixel values after the
 * simple model left the whole frame at full opacity (crop never shrank).
 * IDW from many border points handles both cases without needing to
 * special-case which kind of background a given photo has.
 */
function sampleBorderPoints(data, w, h, stepPx, sampleRadius) {
  const points = [];
  const add = (x, y) => points.push({ x, y, rgb: sampleCorner(data, w, h, x, y, sampleRadius) });
  for (let x = sampleRadius; x < w - sampleRadius; x += stepPx) {
    add(x, sampleRadius);
    add(x, h - 1 - sampleRadius);
  }
  for (let y = sampleRadius; y < h - sampleRadius; y += stepPx) {
    add(sampleRadius, y);
    add(w - 1 - sampleRadius, y);
  }
  return points;
}

function buildBackgroundGrid(points, w, h, gridSize) {
  const grid = new Float32Array(gridSize * gridSize * 3);
  for (let gy = 0; gy < gridSize; gy++) {
    const py = (gy / (gridSize - 1)) * (h - 1);
    for (let gx = 0; gx < gridSize; gx++) {
      const px = (gx / (gridSize - 1)) * (w - 1);
      let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
      for (const p of points) {
        const dx = p.x - px, dy = p.y - py;
        const weight = 1 / (dx * dx + dy * dy + 1); // inverse-distance-squared, +1 avoids div-by-zero
        sumR += p.rgb[0] * weight;
        sumG += p.rgb[1] * weight;
        sumB += p.rgb[2] * weight;
        sumW += weight;
      }
      const idx = (gy * gridSize + gx) * 3;
      grid[idx] = sumR / sumW;
      grid[idx + 1] = sumG / sumW;
      grid[idx + 2] = sumB / sumW;
    }
  }
  return grid;
}

function sampleGridBilinear(grid, gridSize, w, h, x, y) {
  const gx = (x / (w - 1)) * (gridSize - 1);
  const gy = (y / (h - 1)) * (gridSize - 1);
  const gx0 = Math.floor(gx), gy0 = Math.floor(gy);
  const gx1 = Math.min(gridSize - 1, gx0 + 1), gy1 = Math.min(gridSize - 1, gy0 + 1);
  const fx = gx - gx0, fy = gy - gy0;
  const at = (ix, iy, c) => grid[(iy * gridSize + ix) * 3 + c];
  const lerp = (a, b, t) => a + (b - a) * t;
  return [0, 1, 2].map((c) => lerp(lerp(at(gx0, gy0, c), at(gx1, gy0, c), fx), lerp(at(gx0, gy1, c), at(gx1, gy1, c), fx), fy));
}

/**
 * Marks which pixels are actually part of the *background*, not just
 * color-similar to it: a 4-connected flood fill starting from the image
 * border, spreading only through pixels within `high` distance of the local
 * background estimate. A light floral/cream print motif deep inside the
 * garment can be just as close (in RGB distance) to a light gray studio
 * backdrop as the true background is — naive per-pixel keying punches holes
 * through those motifs. Since such a motif is never actually *connected* to
 * the border background region (the garment fabric always encloses it),
 * flood fill correctly leaves it opaque regardless of its own color.
 */
function floodFillBackgroundMask(width, height, rgba, grid, gridSize, high) {
  const n = width * height;
  const isBackground = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  const distAt = (idx) => {
    const x = idx % width;
    const y = (idx - x) / width;
    const i = idx * 4;
    const [bgR, bgG, bgB] = sampleGridBilinear(grid, gridSize, width, height, x, y);
    const dr = rgba[i] - bgR, dg = rgba[i + 1] - bgG, db = rgba[i + 2] - bgB;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  const seed = (idx) => {
    if (visited[idx]) return;
    visited[idx] = 1;
    if (distAt(idx) <= high) {
      isBackground[idx] = 1;
      stack[sp++] = idx;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % width;
    const y = (idx - x) / width;
    const neighbors = [x > 0 ? idx - 1 : -1, x < width - 1 ? idx + 1 : -1, y > 0 ? idx - width : -1, y < height - 1 ? idx + width : -1];
    for (const nb of neighbors) {
      if (nb >= 0 && !visited[nb]) {
        visited[nb] = 1;
        if (distAt(nb) <= high) {
          isBackground[nb] = 1;
          stack[sp++] = nb;
        }
      }
    }
  }
  return isBackground;
}

/**
 * Background removal: a pixel is transparent only if it's *connected* to
 * the border through other background-like pixels (floodFillBackgroundMask)
 * — not merely close in color to the local background estimate. An earlier
 * version ran a separate low/high alpha ramp after the flood fill, which
 * silently re-opaqued any confirmed-background pixel whose own color
 * distance happened to exceed `high` (e.g. a radial vignette's brighter
 * center) — fighting the flood fill's own judgment. Connectivity is the
 * single source of truth for the hard in/out decision; despeckleAlpha
 * supplies the soft edge afterward.
 */
function removeBackground(width, height, rgba, { threshold = 45 } = {}) {
  const data = Buffer.from(rgba); // copy — keep the original opaque buffer untouched
  const borderPoints = sampleBorderPoints(data, width, height, 24, 4);
  const grid = buildBackgroundGrid(borderPoints, width, height, 24);
  const isBackground = floodFillBackgroundMask(width, height, data, grid, 24, threshold);

  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = isBackground[i] ? 0 : 255;
  }
  despeckleAlpha(data, width, height);
  return data;
}

/**
 * Zeroes every opaque-ish connected component except the largest one.
 * These product photos carry a small AI-generation "sparkle" watermark
 * icon in one corner, which sometimes survives background keying as a
 * small blob disconnected from the actual garment — corrupting the alpha
 * bbox (and therefore the crop and the auto-suggested anchors) far more
 * than its tiny size would suggest. 4-connected flood fill; garments are
 * always one contiguous silhouette, so "largest component" is a safe rule.
 */
function keepLargestComponent(data, width, height, threshold = 100) {
  const n = width * height;
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
      const x = idx % width;
      const y = (idx - x) / width;
      const neighbors = [x > 0 ? idx - 1 : -1, x < width - 1 ? idx + 1 : -1, y > 0 ? idx - width : -1, y < height - 1 ? idx + width : -1];
      for (const nb of neighbors) {
        if (nb >= 0 && labels[nb] === -1 && data[nb * 4 + 3] > threshold) {
          labels[nb] = label;
          stack[sp++] = nb;
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length <= 1) return; // nothing to prune
  let largest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[largest]) largest = i;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1 && labels[i] !== largest) data[i * 4 + 3] = 0;
  }
}

// --- Crop to alpha bbox (port of pipeline/autoAnchor.ts's findAlphaBBox/cropToAlphaBBox) ---

function findAlphaBBox(data, w, h, threshold = 10) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function cropToAlphaBBox(width, height, rgba, marginFrac = 0.04) {
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
    const dstStart = y * cropW * 4;
    rgba.copy(out, dstStart, srcStart, srcStart + cropW * 4);
  }
  return { width: cropW, height: cropH, rgba: out };
}

// --- Anchor auto-suggestion (port of pipeline/autoAnchor.ts's suggestAnchors) ---

function rowExtents(data, w, h, threshold) {
  const rows = new Array(h);
  for (let y = 0; y < h; y++) {
    let minX = -1, maxX = -1;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    rows[y] = minX === -1 ? null : [minX, maxX];
  }
  return rows;
}

function suggestAnchors(data, w, h, options = {}) {
  const opts = {
    alphaThreshold: 10,
    shoulderBandFrac: 0.25,
    hemBandFrac: 0.06,
    waistTaperThreshold: 0.9,
    waistFallbackT: 0.55,
    ...options,
  };
  const bbox = findAlphaBBox(data, w, h, opts.alphaThreshold);
  if (!bbox) return null;
  const bboxH = bbox.maxY - bbox.minY;
  if (bboxH <= 0) return null;
  const rows = rowExtents(data, w, h, opts.alphaThreshold);

  const shoulderBandEnd = Math.min(bbox.maxY, bbox.minY + Math.round(bboxH * opts.shoulderBandFrac));
  let shoulderY = bbox.minY, shoulderWidth = -1;
  for (let y = bbox.minY; y <= shoulderBandEnd; y++) {
    const r = rows[y];
    if (!r) continue;
    const width = r[1] - r[0];
    if (width > shoulderWidth) { shoulderWidth = width; shoulderY = y; }
  }
  const shoulderRow = rows[shoulderY];
  if (!shoulderRow) return null;

  const hemBandStart = Math.max(bbox.minY, bbox.maxY - Math.round(bboxH * opts.hemBandFrac));
  let hemMinSum = 0, hemMaxSum = 0, hemCount = 0;
  for (let y = hemBandStart; y <= bbox.maxY; y++) {
    const r = rows[y];
    if (!r) continue;
    hemMinSum += r[0]; hemMaxSum += r[1]; hemCount++;
  }
  const hemY = bbox.maxY;
  const hemL_x = hemCount > 0 ? hemMinSum / hemCount : shoulderRow[0];
  const hemR_x = hemCount > 0 ? hemMaxSum / hemCount : shoulderRow[1];

  let waistY = -1, waistWidth = Infinity;
  for (let y = shoulderBandEnd + 1; y < hemBandStart; y++) {
    const r = rows[y];
    if (!r) continue;
    const width = r[1] - r[0];
    if (width < waistWidth) { waistWidth = width; waistY = y; }
  }

  let waistL_x, waistR_x, waistYFinal;
  if (waistY === -1 || waistWidth > shoulderWidth * opts.waistTaperThreshold) {
    waistYFinal = Math.round(shoulderY + (hemY - shoulderY) * opts.waistFallbackT);
    const t = (waistYFinal - shoulderY) / Math.max(1, hemY - shoulderY);
    waistL_x = shoulderRow[0] + (hemL_x - shoulderRow[0]) * t;
    waistR_x = shoulderRow[1] + (hemR_x - shoulderRow[1]) * t;
  } else {
    waistYFinal = waistY;
    const waistRow = rows[waistY];
    if (!waistRow) return null;
    [waistL_x, waistR_x] = waistRow;
  }

  return {
    shoulderL: [shoulderRow[0], shoulderY],
    shoulderR: [shoulderRow[1], shoulderY],
    waistL: [waistL_x, waistYFinal],
    waistR: [waistR_x, waistYFinal],
    hemL: [hemL_x, hemY],
    hemR: [hemR_x, hemY],
  };
}

// --- Main ---

function round1(p) {
  return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
}

const files = await readdir(srcDir);
const results = {};
for (const file of files) {
  if (!file.toLowerCase().endsWith('.png')) continue;
  const buf = await readFile(path.join(srcDir, file));
  const { width, height, rgba } = decodePng(buf);
  const keyed = removeBackground(width, height, rgba, { threshold: 45 });
  keepLargestComponent(keyed, width, height);
  const cropped = cropToAlphaBBox(width, height, keyed);
  if (!cropped) {
    console.error(`${file}: no alpha found after background removal — skipping`);
    continue;
  }
  const anchors = suggestAnchors(cropped.rgba, cropped.width, cropped.height);
  if (!anchors) {
    console.error(`${file}: could not suggest anchors — skipping`);
    continue;
  }
  const base = path.basename(file, '.png');
  const outName = `${base}-cutout.png`;
  await writeFile(path.join(outDir, outName), encodePng(cropped.width, cropped.height, cropped.rgba));
  const roundedAnchors = Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, round1(v)]));
  results[file] = { outName, width: cropped.width, height: cropped.height, anchors: roundedAnchors };
  console.log(`${file} -> ${outName} (${cropped.width}x${cropped.height})`);
}

console.log(JSON.stringify(results, null, 2));
