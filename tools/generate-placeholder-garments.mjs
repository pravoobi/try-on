/**
 * Generates placeholder garment PNGs (flat silhouette illustrations, true
 * alpha transparency) plus src/garments/catalog.json with pixel-exact
 * anchors matching the drawn silhouettes.
 *
 * These are NOT product photography — they're a functional stand-in so the
 * TPS warp / compositor pipeline can be built and verified now. Swap in real
 * background-removed garment photos later via tools/annotate.html; the
 * schema and anchor names are identical either way.
 *
 * No image-library dependency: hand-rolled PNG encoder (zlib is built into
 * Node) + a scanline polygon fill that handles the concave V-neck outline.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const garmentsDir = path.join(root, 'public', 'garments');
const catalogPath = path.join(root, 'src', 'garments', 'catalog.json');

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, filter type 0, no interlace)
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
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // ihdr[10..12] = compression/filter/interlace, already 0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // per-scanline filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Scanline polygon fill (even-odd rule — handles the concave V-neck outline)
// ---------------------------------------------------------------------------

function fillPolygon(buf, width, height, points, [r, g, b, a]) {
  const ys = points.map((p) => p[1]);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...ys)));

  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5;
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
        xs.push(x1 + ((scanY - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xStart = Math.max(0, Math.round(xs[i]));
      const xEnd = Math.min(width - 1, Math.round(xs[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        const idx = (y * width + x) * 4;
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = a;
      }
    }
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Horizontal stripe shading, drawn only where alpha != 0 (i.e. within the silhouette). */
function addStripes(buf, width, height, stripeHeight, [r, g, b], alphaDelta) {
  for (let y = 0; y < height; y++) {
    if (Math.floor(y / stripeHeight) % 2 !== 0) continue;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (buf[idx + 3] === 0) continue;
      buf[idx] = Math.max(0, buf[idx] - alphaDelta);
      buf[idx + 1] = Math.max(0, buf[idx + 1] - alphaDelta);
      buf[idx + 2] = Math.max(0, buf[idx + 2] - alphaDelta);
    }
  }
  void r;
  void g;
  void b;
}

// ---------------------------------------------------------------------------
// Garment silhouette builder
// ---------------------------------------------------------------------------

/**
 * @param {object} spec
 * @returns {{ png: Buffer, anchors: Record<string, [number, number]> }}
 */
function buildGarment(spec) {
  const {
    width: W,
    height: H,
    centerX: cx,
    shoulderY,
    shoulderHalfWidth,
    waistY,
    waistHalfWidth,
    hemY,
    hemHalfWidth,
    neckDepth,
    neckHalfWidth,
    sleeve, // null | { dropOut, lengthDown, cuffIn }
    color,
    stripes,
  } = spec;

  const buf = Buffer.alloc(W * H * 4, 0);
  const [r, g, b] = hexToRgb(color);
  const fill = [r, g, b, 255];

  const shoulderL = [cx - shoulderHalfWidth, shoulderY];
  const shoulderR = [cx + shoulderHalfWidth, shoulderY];
  const waistL = [cx - waistHalfWidth, waistY];
  const waistR = [cx + waistHalfWidth, waistY];
  const hemL = [cx - hemHalfWidth, hemY];
  const hemR = [cx + hemHalfWidth, hemY];

  // Torso outline (concave at the neck): walk shoulderL -> neck notch -> shoulderR -> waistR -> hemR -> hemL -> waistL -> close.
  const neckTipL = [cx - neckHalfWidth, shoulderY];
  const neckTipR = [cx + neckHalfWidth, shoulderY];
  const neckBottom = [cx, shoulderY + neckDepth];
  const torso = [shoulderL, neckTipL, neckBottom, neckTipR, shoulderR, waistR, hemR, hemL, waistL];
  fillPolygon(buf, W, H, torso, fill);

  if (sleeve) {
    const { dropOut, lengthDown, cuffIn } = sleeve;
    for (const side of [-1, 1]) {
      const shoulderPt = side < 0 ? shoulderL : shoulderR;
      const outerTop = [shoulderPt[0] + side * dropOut, shoulderY + lengthDown * 0.15];
      const outerBottom = [shoulderPt[0] + side * (dropOut - cuffIn * 0.3), shoulderY + lengthDown];
      const innerBottom = [shoulderPt[0] + side * (dropOut - cuffIn), shoulderY + lengthDown];
      const innerTop = [shoulderPt[0], shoulderY + lengthDown * 0.1];
      fillPolygon(buf, W, H, [shoulderPt, outerTop, outerBottom, innerBottom, innerTop], fill);
    }
  }

  if (stripes) addStripes(buf, W, H, stripes.height, [r, g, b], stripes.alphaDelta);

  return {
    png: encodePng(W, H, buf),
    anchors: { shoulderL, shoulderR, waistL, waistR, hemL, hemR },
  };
}

// ---------------------------------------------------------------------------
// Garment definitions
// ---------------------------------------------------------------------------

const GARMENTS = [
  {
    id: 'kurti-teal-01',
    category: 'kurti',
    meta: { sleeves: 'half', length: 'hip' },
    spec: {
      width: 460,
      height: 620,
      centerX: 230,
      shoulderY: 60,
      shoulderHalfWidth: 95,
      waistY: 310,
      waistHalfWidth: 80,
      hemY: 560,
      hemHalfWidth: 110,
      neckDepth: 55,
      neckHalfWidth: 30,
      // Kept modest relative to shoulderHalfWidth: TPS only anchors at the
      // shoulder point, so sleeve tips extending far beyond it extrapolate
      // outside the control-point convex hull and can fold badly (visible
      // as spikes above the shoulders) once warped onto a body whose
      // proportions differ from the illustration's.
      sleeve: { dropOut: 35, lengthDown: 110, cuffIn: 12 },
      color: '#1f9e8e',
      stripes: { height: 14, alphaDelta: 18 },
    },
  },
  {
    id: 'kurti-mustard-02',
    category: 'kurti',
    meta: { sleeves: 'sleeveless', length: 'knee' },
    spec: {
      width: 460,
      height: 760,
      centerX: 230,
      shoulderY: 55,
      shoulderHalfWidth: 90,
      waistY: 320,
      waistHalfWidth: 88,
      hemY: 720,
      hemHalfWidth: 165,
      neckDepth: 30,
      neckHalfWidth: 45,
      sleeve: null,
      color: '#d9a441',
      stripes: null,
    },
  },
  {
    id: 'dress-coral-01',
    category: 'dress',
    meta: { sleeves: 'half', length: 'knee' },
    spec: {
      width: 480,
      height: 780,
      centerX: 240,
      shoulderY: 55,
      shoulderHalfWidth: 88,
      waistY: 300,
      waistHalfWidth: 68,
      hemY: 740,
      hemHalfWidth: 175,
      neckDepth: 45,
      neckHalfWidth: 28,
      sleeve: { dropOut: 28, lengthDown: 90, cuffIn: 10 },
      color: '#e0645a',
      stripes: null,
    },
  },
  {
    id: 'dress-navy-02',
    category: 'dress',
    meta: { sleeves: 'sleeveless', length: 'ankle' },
    spec: {
      width: 480,
      height: 940,
      centerX: 240,
      shoulderY: 55,
      shoulderHalfWidth: 90,
      waistY: 290,
      waistHalfWidth: 78,
      hemY: 900,
      hemHalfWidth: 150,
      neckDepth: 35,
      neckHalfWidth: 40,
      sleeve: null,
      color: '#28365e',
      stripes: { height: 40, alphaDelta: 14 },
    },
  },
];

await mkdir(garmentsDir, { recursive: true });

const catalog = [];
for (const g of GARMENTS) {
  const { png, anchors } = buildGarment(g.spec);
  const file = `${g.id}.png`;
  await writeFile(path.join(garmentsDir, file), png);
  const rounded = Object.fromEntries(
    Object.entries(anchors).map(([k, [x, y]]) => [k, [Math.round(x * 10) / 10, Math.round(y * 10) / 10]]),
  );
  catalog.push({ id: g.id, category: g.category, image: `/garments/${file}`, anchors: rounded, meta: g.meta });
  console.log(`generated ${file} (${g.spec.width}x${g.spec.height})`);
}

await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`wrote ${catalog.length} entries -> src/garments/catalog.json`);
