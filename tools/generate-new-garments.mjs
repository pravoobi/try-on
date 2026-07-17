/**
 * Generates the shirt / t-shirt / pants / shorts catalog garments as
 * procedural PNGs (true alpha, per-leg/per-panel cylinder shading, seam and
 * stitch details) and inserts their entries into src/garments/catalog.json
 * with pixel-exact anchors taken from the same geometry the drawing used —
 * no auto-anchor guessing involved.
 *
 * Same spirit as generate-placeholder-garments.mjs (which bootstrapped the
 * original catalog before real product photos replaced it): these are
 * functional, decent-looking stand-ins proving the category pipeline —
 * swap in background-removed product photos via tools/raw-garments/ +
 * tools/process-new-garments.mjs when available. Idempotent: re-running
 * replaces its own catalog entries by id and leaves everything else alone.
 *
 * Usage: node tools/generate-new-garments.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const garmentsDir = path.join(root, 'public', 'garments');
const catalogPath = path.join(root, 'src', 'garments', 'catalog.json');

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

// --- Drawing helpers ---

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Scanline even-odd polygon fill (matches generate-placeholder-garments.mjs). */
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

function fillCircle(buf, W, H, cx, cy, radius, [r, g, b]) {
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(H - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(W - 1, Math.ceil(cx + radius)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      const idx = (y * W + x) * 4;
      if (buf[idx + 3] === 0) continue; // stay inside the garment silhouette
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
    }
  }
}

/** Draws a polyline as stamped discs — good enough for seam/stitch lines. */
function strokePolyline(buf, W, H, points, thickness, rgb) {
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len));
    for (let s = 0; s <= steps; s++) {
      fillCircle(buf, W, H, x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps, thickness / 2, rgb);
    }
  }
}

/** Multiplies RGB inside a rect (silhouette pixels only) — cheap panel tint. */
function tintRect(buf, W, H, x0, y0, x1, y1, factor) {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const idx = (y * W + x) * 4;
      if (buf[idx + 3] === 0) continue;
      buf[idx] = Math.min(255, buf[idx] * factor);
      buf[idx + 1] = Math.min(255, buf[idx + 1] * factor);
      buf[idx + 2] = Math.min(255, buf[idx + 2] * factor);
    }
  }
}

/** Elliptical soft lighten — the worn-wash highlight on denim thighs. */
function lightenEllipse(buf, W, H, cx, cy, rx, ry, amount) {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(H - 1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, Math.ceil(cx + rx)); x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d >= 1) continue;
      const idx = (y * W + x) * 4;
      if (buf[idx + 3] === 0) continue;
      const f = 1 + amount * (1 - d);
      buf[idx] = Math.min(255, buf[idx] * f);
      buf[idx + 1] = Math.min(255, buf[idx + 1] * f);
      buf[idx + 2] = Math.min(255, buf[idx + 2] * f);
    }
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fabric shading pass, run LAST: for every row, each contiguous alpha run is
 * shaded as its own cylinder (darker toward the run's edges, subtly lit in
 * the middle) — a pants row has two runs, so each leg rounds independently —
 * plus a gentle top-to-bottom falloff and deterministic per-pixel noise for
 * a woven-fabric feel instead of flat vector fill.
 */
function shadeFabric(buf, W, H, seed = 7) {
  const rand = mulberry32(seed);
  const noise = new Float32Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * 0.045;
  for (let y = 0; y < H; y++) {
    const vertical = 1.02 - 0.07 * (y / H);
    let x = 0;
    while (x < W) {
      if (buf[(y * W + x) * 4 + 3] === 0) {
        x++;
        continue;
      }
      let end = x;
      while (end < W && buf[(y * W + end) * 4 + 3] !== 0) end++;
      const runLen = Math.max(1, end - x - 1);
      for (let px = x; px < end; px++) {
        const t = (px - x) / runLen;
        const cylinder = 0.74 + 0.26 * Math.sin(Math.PI * t);
        const f = cylinder * vertical * (1 + noise[y * W + px]);
        const idx = (y * W + px) * 4;
        buf[idx] = Math.max(0, Math.min(255, buf[idx] * f));
        buf[idx + 1] = Math.max(0, Math.min(255, buf[idx + 1] * f));
        buf[idx + 2] = Math.max(0, Math.min(255, buf[idx + 2] * f));
      }
      x = end;
    }
  }
}

/** Points along a quadratic bezier (for necklines and pocket stitching). */
function quad(p0, p1, p2, n = 16) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return pts;
}

const mirrorX = (W) => (pts) => pts.map(([x, y]) => [W - x, y]);

// --- Garment builders (each returns { buf, anchors } for its fixed W×H) ---

/**
 * Shared top shape: torso panel + two sleeve panels (separate polygons so
 * the underarm boundary reads as a seam after shading). `sleeve: 'short'`
 * ends mid-bicep (t-shirt), 'long' hangs to cuffs at hem level (shirt).
 */
function buildTop({ W, H, color, sleeve, hemY, seed }) {
  const buf = Buffer.alloc(W * H * 4, 0);
  const rgb = hexToRgb(color);
  const fill = [...rgb, 255];

  const neckL = [255, 62];
  const neckR = [W - 255, 62];
  const shoulderL = [128, 84];
  const shoulderR = [W - 128, 84];
  const underarmY = 245;
  const sideTopL = [148, underarmY];
  const hemL = [158, hemY];
  const neckline = quad(neckL, [W / 2, 128], neckR, 14);

  const torso = [
    ...neckline,
    shoulderR,
    [W - sideTopL[0], sideTopL[1]],
    [W - hemL[0], hemY],
    [W / 2, hemY + 14], // slight hem curve
    hemL,
    sideTopL,
    shoulderL,
  ];

  const sleeveShort = [
    shoulderL,
    [58, 205],
    [82, 292],
    [172, 262],
    [sideTopL[0] + 8, underarmY - 6],
  ];
  const sleeveLong = [
    shoulderL,
    [52, 260],
    [58, hemY - 30],
    [138, hemY - 30],
    [162, 300],
    [sideTopL[0] + 8, underarmY - 6],
  ];
  const sleeveL = sleeve === 'short' ? sleeveShort : sleeveLong;
  const sleeveR = mirrorX(W)(sleeveL);

  fillPolygon(buf, W, H, sleeveL, fill);
  fillPolygon(buf, W, H, sleeveR, fill);
  fillPolygon(buf, W, H, torso, fill);

  const darker = rgb.map((c) => c * 0.72);
  if (sleeve === 'short') {
    // Ribbed crew-collar band along the neckline.
    strokePolyline(buf, W, H, neckline, 13, darker);
    // Sleeve hem bands.
    strokePolyline(buf, W, H, [[62, 288], [170, 258]], 8, darker);
    strokePolyline(buf, W, H, mirrorX(W)([[62, 288], [170, 258]]), 8, darker);
  } else {
    // Collar: band + two collar-point triangles.
    strokePolyline(buf, W, H, neckline, 9, darker);
    fillPolygon(buf, W, H, [[neckL[0] - 12, neckL[1] - 4], [neckL[0] + 46, neckL[1] + 42], [neckL[0] + 62, neckL[1] - 2]], [...darker, 255]);
    fillPolygon(buf, W, H, mirrorX(W)([[neckL[0] - 12, neckL[1] - 4], [neckL[0] + 46, neckL[1] + 42], [neckL[0] + 62, neckL[1] - 2]]), [...darker, 255]);
    // Button placket: subtle raised strip + buttons.
    tintRect(buf, W, H, W / 2 - 15, 120, W / 2 + 15, hemY + 8, 1.07);
    strokePolyline(buf, W, H, [[W / 2 - 15, 122], [W / 2 - 15, hemY + 4]], 2, darker);
    for (let y = 158; y < hemY - 20; y += 78) fillCircle(buf, W, H, W / 2, y, 5, darker);
    // Cuffs.
    strokePolyline(buf, W, H, [[60, hemY - 58], [136, hemY - 58]], 6, darker);
    strokePolyline(buf, W, H, mirrorX(W)([[60, hemY - 58], [136, hemY - 58]]), 6, darker);
  }

  shadeFabric(buf, W, H, seed);

  // Waist targets: on the torso's side edge, ~62% shoulder→hem (matches
  // config.anchors.waistT's idea of where a waist sits).
  const waistY = Math.round(shoulderL[1] + (hemY - shoulderL[1]) * 0.62);
  const waistX = sideTopL[0] + ((hemL[0] - sideTopL[0]) * (waistY - underarmY)) / (hemY - underarmY);

  // Sleeve anchors, straight off the drawn sleeve geometry: cuff = center
  // of the sleeve's end-opening edge; elbow (long sleeves) = the sleeve's
  // midline partway down, so the warped sleeve can bend with a bent arm.
  const cuffShortL = [Math.round((82 + 172) / 2), Math.round((292 + 262) / 2)];
  const cuffLongL = [Math.round((58 + 138) / 2), hemY - 30];
  const elbowLongL = [104, Math.round(260 + (hemY - 30 - 260) * 0.47)];
  const sleeveAnchors =
    sleeve === 'short'
      ? { cuffL: cuffShortL, cuffR: [W - cuffShortL[0], cuffShortL[1]] }
      : {
          elbowL: elbowLongL,
          elbowR: [W - elbowLongL[0], elbowLongL[1]],
          cuffL: cuffLongL,
          cuffR: [W - cuffLongL[0], cuffLongL[1]],
        };

  return {
    buf,
    anchors: {
      shoulderL: [shoulderL[0], shoulderL[1]],
      shoulderR: [shoulderR[0], shoulderR[1]],
      waistL: [Math.round(waistX), waistY],
      waistR: [W - Math.round(waistX), waistY],
      hemL: [hemL[0], hemY],
      hemR: [W - hemL[0], hemY],
      ...sleeveAnchors,
    },
  };
}

/**
 * Pants/shorts: waistband, hip flare, two legs meeting at the crotch. One
 * simply-connected outline; the leg gap comes from the even-odd fill of the
 * inseam edges. `style` picks the detail pass (denim vs clean chino).
 */
function buildPants({ W, H, color, hemY, legHemHalf, style, seed }) {
  const buf = Buffer.alloc(W * H * 4, 0);
  const rgb = hexToRgb(color);
  const fill = [...rgb, 255];

  const waistY = 42;
  const waistL = [152, waistY];
  const waistR = [W - 152, waistY];
  const hipY = 205;
  const hipL = [126, hipY];
  const crotch = [W / 2, 345];
  const legOuterHemL = [W / 2 - 152, hemY]; // outer bottom corner, left leg
  const legInnerHemL = [W / 2 - 152 + legHemHalf * 2, hemY];

  const outline = [
    waistL,
    waistR,
    [W - hipL[0], hipY],
    [W - legOuterHemL[0], hemY],
    [W - legInnerHemL[0], hemY],
    crotch,
    legInnerHemL,
    legOuterHemL,
    hipL,
  ];
  fillPolygon(buf, W, H, outline, fill);

  const darker = rgb.map((c) => c * 0.7);
  const stitch = style === 'denim' ? [219, 199, 148] : rgb.map((c) => c * 0.82); // contrast thread on denim

  // Waistband + closure.
  tintRect(buf, W, H, 0, waistY, W, waistY + 46, 0.88);
  strokePolyline(buf, W, H, [[waistL[0], waistY + 46], [waistR[0], waistY + 46]], 2, stitch);
  fillCircle(buf, W, H, W / 2, waistY + 24, 6, darker);
  if (style === 'denim') {
    for (const bx of [186, 258, W - 258, W - 186]) {
      fillPolygon(buf, W, H, [[bx - 6, waistY + 2], [bx + 6, waistY + 2], [bx + 6, waistY + 44], [bx - 6, waistY + 44]], [...darker, 255]);
    }
    // Front pocket stitch arcs + fly.
    strokePolyline(buf, W, H, quad([152, 118], [235, 150], [252, 235], 14), 3, stitch);
    strokePolyline(buf, W, H, quad([W - 152, 118], [W - 235, 150], [W - 252, 235], 14), 3, stitch);
    strokePolyline(buf, W, H, [[W / 2, waistY + 50], [W / 2, 300], [W / 2 - 26, 335]], 3, stitch);
  }

  // Outseam stitching down each outer edge (follows the outline's own slope).
  const outseamL = [
    [hipL[0] + 8, hipY],
    [legOuterHemL[0] + 8, hemY - 6],
  ];
  strokePolyline(buf, W, H, outseamL, 3, stitch);
  strokePolyline(buf, W, H, mirrorX(W)(outseamL), 3, stitch);
  // Hem bands.
  tintRect(buf, W, H, 0, hemY - 26, W, hemY, 0.85);

  if (style === 'denim') {
    // Worn-wash thigh highlights.
    lightenEllipse(buf, W, H, W / 2 - 92, 470, 78, 200, 0.11);
    lightenEllipse(buf, W, H, W / 2 + 92, 470, 78, 200, 0.11);
  } else {
    // Pressed front creases.
    const creaseL = [
      [W / 2 - 100, hipY + 60],
      [(legOuterHemL[0] + legInnerHemL[0]) / 2, hemY - 30],
    ];
    strokePolyline(buf, W, H, creaseL, 2, rgb.map((c) => Math.min(255, c * 1.12)));
    strokePolyline(buf, W, H, mirrorX(W)(creaseL), 2, rgb.map((c) => Math.min(255, c * 1.12)));
  }

  shadeFabric(buf, W, H, seed);

  return {
    buf,
    anchors: {
      waistL: [waistL[0], waistY + 22],
      waistR: [waistR[0], waistY + 22],
      hemL: [legOuterHemL[0], hemY - 4],
      hemR: [W - legOuterHemL[0], hemY - 4],
    },
  };
}

// --- Catalog assembly ---

const GARMENTS = [
  {
    id: 'tshirt-offwhite-01',
    category: 'tshirt',
    meta: { sleeves: 'half', length: 'hip' },
    W: 640,
    H: 640,
    build: () => buildTop({ W: 640, H: 640, color: '#eeece6', sleeve: 'short', hemY: 600, seed: 11 }),
  },
  {
    id: 'tshirt-navy-01',
    category: 'tshirt',
    meta: { sleeves: 'half', length: 'hip' },
    W: 640,
    H: 640,
    build: () => buildTop({ W: 640, H: 640, color: '#2e3d5f', sleeve: 'short', hemY: 600, seed: 12 }),
  },
  {
    id: 'shirt-oxford-blue-01',
    category: 'shirt',
    meta: { sleeves: 'full', length: 'hip' },
    W: 640,
    H: 700,
    build: () => buildTop({ W: 640, H: 700, color: '#a9c3de', sleeve: 'long', hemY: 650, seed: 13 }),
  },
  {
    id: 'jeans-blue-01',
    category: 'pants',
    meta: { sleeves: 'sleeveless', length: 'ankle' },
    W: 600,
    H: 1000,
    build: () => buildPants({ W: 600, H: 1000, color: '#3f5e88', hemY: 962, legHemHalf: 56, style: 'denim', seed: 14 }),
  },
  {
    id: 'chinos-khaki-01',
    category: 'pants',
    meta: { sleeves: 'sleeveless', length: 'ankle' },
    W: 600,
    H: 1000,
    build: () => buildPants({ W: 600, H: 1000, color: '#c4ab83', hemY: 962, legHemHalf: 52, style: 'chino', seed: 15 }),
  },
  {
    id: 'shorts-gray-01',
    category: 'pants',
    meta: { sleeves: 'sleeveless', length: 'knee' },
    W: 600,
    H: 540,
    build: () => buildPants({ W: 600, H: 540, color: '#66707e', hemY: 505, legHemHalf: 72, style: 'chino', seed: 16 }),
  },
];

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const generatedIds = new Set(GARMENTS.map((g) => g.id));
const kept = catalog.filter((entry) => !generatedIds.has(entry.id));

const newEntries = [];
for (const spec of GARMENTS) {
  const { buf, anchors } = spec.build();
  const file = `${spec.id}.png`;
  await writeFile(path.join(garmentsDir, file), encodePng(spec.W, spec.H, buf));
  newEntries.push({
    id: spec.id,
    category: spec.category,
    image: `/garments/${file}`,
    anchors,
    meta: spec.meta,
  });
  console.log(`${file} (${spec.W}x${spec.H})`);
}

await writeFile(catalogPath, `${JSON.stringify([...kept, ...newEntries], null, 2)}\n`);
console.log(`catalog.json: ${kept.length} existing + ${newEntries.length} generated entries`);
