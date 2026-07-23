/**
 * Auto-suggests garment anchors from a background-removed image's alpha
 * silhouette (Phase A4 user uploads, see docs/plan-3d-garment-assets.md
 * §5.2): shoulders are the widest row near the top (shoulders/sleeves are
 * usually wider than a narrower neckline right at the very top), the hem
 * is the bottom of the silhouette, and the waist is the narrowest row in
 * between — falling back to a fixed interpolation for boxy garments with
 * no real taper, rather than trusting a possibly-noisy "narrowest pixel"
 * on a straight-cut shape.
 *
 * L/R here means left/right side of the *image*, matching the convention
 * used throughout src/garments/catalog.json (e.g. dress-navy-floral-01's
 * shoulderL=[131,...] sits left of shoulderR=[498,...]) — not an
 * anatomical "wearer's own left". Matching the existing convention keeps
 * auto-suggested anchors behaving identically to hand-annotated ones.
 *
 * This is a starting point only — CLAUDE.md: "anchor quality dominates
 * output quality" — the drag-adjust UI is what actually makes these usable.
 */
import type { GarmentAnchors, Point, SkirtAnchors } from './types.js';

export interface AlphaBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounding box of non-transparent pixels in an RGBA buffer, or null if fully transparent. */
export function findAlphaBBox(
  alphaData: Uint8ClampedArray,
  w: number,
  h: number,
  threshold = 10,
): AlphaBBox | null {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaData[(y * w + x) * 4 + 3] > threshold) {
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

type RowExtent = readonly [number, number] | null;

/** Per-row [minX, maxX] of opaque pixels, or null for fully-transparent rows. */
function rowExtents(alphaData: Uint8ClampedArray, w: number, h: number, threshold: number): RowExtent[] {
  const rows: RowExtent[] = new Array(h);
  for (let y = 0; y < h; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < w; x++) {
      if (alphaData[(y * w + x) * 4 + 3] > threshold) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    rows[y] = minX === -1 ? null : [minX, maxX];
  }
  return rows;
}

export interface SuggestAnchorsOptions {
  alphaThreshold?: number;
  /** Fraction of the bbox height searched for the shoulder seam, from the top. */
  shoulderBandFrac?: number;
  /** Fraction of the bbox height averaged for the hem, from the bottom. */
  hemBandFrac?: number;
  /** If the narrowest "waist" row isn't at least this much narrower than the shoulder row (as a fraction), treat the garment as having no real taper and fall back to a straight-line interpolation. */
  waistTaperThreshold?: number;
  /** Fallback waist position, as a fraction from shoulder to hem, when there's no real taper. */
  waistFallbackT?: number;
  /**
   * Shoulder-seam detection: the shoulder row is the first one, scanning
   * from the top, whose width reaches this fraction of the median width of
   * the upper band (top `shoulderBandFrac` of the garment). This finds
   * where the narrow neckline/collar has opened out to roughly body width —
   * robust both to the garment continuing to widen below (a ghost-mannequin
   * top, which broke "widest row") and to a collar tip creating a fast
   * emergence at the very top (which broke slope detection). Lower =
   * triggers higher up (safer: a small collar bit above the anchor warps
   * mildly, far better than the whole neck warping over the face).
   */
  shoulderReachFrac?: number;
}

const DEFAULTS: Required<SuggestAnchorsOptions> = {
  alphaThreshold: 10,
  shoulderBandFrac: 0.4,
  hemBandFrac: 0.06,
  waistTaperThreshold: 0.9,
  waistFallbackT: 0.55,
  shoulderReachFrac: 0.8,
};

/** Suggests a 6-anchor GarmentAnchors set from a matted image's alpha channel, or null if the image is empty. */
export function suggestAnchors(
  alphaData: Uint8ClampedArray,
  w: number,
  h: number,
  options: SuggestAnchorsOptions = {},
): GarmentAnchors | null {
  const opts = { ...DEFAULTS, ...options };
  const bbox = findAlphaBBox(alphaData, w, h, opts.alphaThreshold);
  if (!bbox) return null;
  const bboxH = bbox.maxY - bbox.minY;
  if (bboxH <= 0) return null;
  const rows = rowExtents(alphaData, w, h, opts.alphaThreshold);

  // Shoulders: the seam where the narrow neckline/collar has opened out to
  // roughly the body's width. The old "widest row in the top band" placed
  // the anchor at the width peak, but a ghost-mannequin top (and any
  // gathered/flared silhouette) keeps widening monotonically well past the
  // shoulders, so the peak sat a quarter of the way down and the empty
  // neck/collar above it warped up over the wearer's face.
  //
  // Instead: take the median width of the upper band as a body-width
  // reference, then walk down from the top and stop at the first row that
  // reaches shoulderReachFrac of it. That fires at the shoulder line
  // regardless of how much wider the body/sleeves/skirt get below, and —
  // unlike a slope test — isn't fooled by a collar tip's fast emergence at
  // the very top edge.
  const shoulderBandEnd = Math.min(bbox.maxY, bbox.minY + Math.round(bboxH * opts.shoulderBandFrac));
  const bandWidths: number[] = [];
  for (let y = bbox.minY; y <= shoulderBandEnd; y++) {
    const r = rows[y];
    if (r) bandWidths.push(r[1] - r[0]);
  }
  bandWidths.sort((a, b) => a - b);
  const bandMedian = bandWidths.length ? bandWidths[bandWidths.length >> 1] : 0;
  const shoulderTarget = bandMedian * opts.shoulderReachFrac;

  let shoulderY = bbox.minY;
  for (let y = bbox.minY; y <= shoulderBandEnd; y++) {
    const r = rows[y];
    if (!r) continue;
    if (r[1] - r[0] >= shoulderTarget) {
      shoulderY = y;
      break;
    }
  }
  const shoulderRow = rows[shoulderY];
  if (!shoulderRow) return null; // shouldn't happen: bbox.minY row is always non-empty by construction.
  const shoulderWidth = shoulderRow[1] - shoulderRow[0];

  // Hem: average the bottom band's rows, robust against a single stray pixel.
  const hemBandStart = Math.max(bbox.minY, bbox.maxY - Math.round(bboxH * opts.hemBandFrac));
  let hemMinSum = 0;
  let hemMaxSum = 0;
  let hemCount = 0;
  for (let y = hemBandStart; y <= bbox.maxY; y++) {
    const r = rows[y];
    if (!r) continue;
    hemMinSum += r[0];
    hemMaxSum += r[1];
    hemCount++;
  }
  const hemY = bbox.maxY;
  const hemL_x = hemCount > 0 ? hemMinSum / hemCount : shoulderRow[0];
  const hemR_x = hemCount > 0 ? hemMaxSum / hemCount : shoulderRow[1];

  // Waist: narrowest row between the shoulder seam and the hem band. Starts
  // below the shoulder (plus a small margin so the search doesn't begin
  // right at the seam), not at the fixed shoulder-search limit.
  const waistSearchStart = Math.min(hemBandStart - 1, shoulderY + Math.round(bboxH * 0.1));
  let waistY = -1;
  let waistWidth = Infinity;
  for (let y = waistSearchStart; y < hemBandStart; y++) {
    const r = rows[y];
    if (!r) continue;
    const width = r[1] - r[0];
    if (width < waistWidth) {
      waistWidth = width;
      waistY = y;
    }
  }

  let waistL_x: number;
  let waistR_x: number;
  let waistYFinal: number;
  if (waistY === -1 || waistWidth > shoulderWidth * opts.waistTaperThreshold) {
    // No real taper found (or no rows to search): interpolate a straight line
    // from shoulder to hem rather than trust a noisy "narrowest pixel".
    waistYFinal = Math.round(shoulderY + (hemY - shoulderY) * opts.waistFallbackT);
    const t = (waistYFinal - shoulderY) / Math.max(1, hemY - shoulderY);
    waistL_x = shoulderRow[0] + (hemL_x - shoulderRow[0]) * t;
    waistR_x = shoulderRow[1] + (hemR_x - shoulderRow[1]) * t;
  } else {
    waistYFinal = waistY;
    const waistRow = rows[waistY];
    if (!waistRow) return null; // unreachable: waistY only set from a non-null row above.
    [waistL_x, waistR_x] = waistRow;
  }

  const shoulderL: Point = [shoulderRow[0], shoulderY];
  const shoulderR: Point = [shoulderRow[1], shoulderY];
  const waistL: Point = [waistL_x, waistYFinal];
  const waistR: Point = [waistR_x, waistYFinal];
  const hemL: Point = [hemL_x, hemY];
  const hemR: Point = [hemR_x, hemY];

  return { shoulderL, shoulderR, waistL, waistR, hemL, hemR };
}

/**
 * Suggests the 4-point pants anchor set (see schema/PantsGarment: waistband
 * corners + each leg's OUTER bottom corner) from a matted pants photo's
 * alpha silhouette, or null if the image is empty. Much simpler than the
 * top heuristic: a pants photo starts at the waistband (top band extents)
 * and ends at the leg openings (bottom band outer extents) — the inner-leg
 * edges deliberately carry no anchors (see computePantsBodyAnchors).
 */
export function suggestPantsAnchors(
  alphaData: Uint8ClampedArray,
  w: number,
  h: number,
  options: SuggestAnchorsOptions = {},
): SkirtAnchors | null {
  const opts = { ...DEFAULTS, ...options };
  const bbox = findAlphaBBox(alphaData, w, h, opts.alphaThreshold);
  if (!bbox) return null;
  const bboxH = bbox.maxY - bbox.minY;
  if (bboxH <= 0) return null;
  const rows = rowExtents(alphaData, w, h, opts.alphaThreshold);

  // Waistband: WIDEST row within the top band (mirrors suggestAnchors's own
  // shoulder detection — reuses shoulderBandFrac as "how far down to search
  // from the top"), not a plain average of a fixed top slice. A garment that
  // has already been through one matting pass (e.g. a catalog PNG re-run
  // through the upload flow's own background removal) can pick up a faint,
  // low-alpha wisp a row or two above the true opaque waistband edge — a
  // plain top-slice average lets that thin artifact drag the whole waist
  // width toward zero, collapsing the anchors into a near-vertical sliver.
  // Searching for the widest row is immune to a thin outlier the same way
  // the top heuristic already is for puff-sleeve bulges.
  const waistBandEnd = Math.min(bbox.maxY, bbox.minY + Math.round(bboxH * opts.shoulderBandFrac));
  let waistY = bbox.minY;
  let waistWidth = -1;
  for (let y = bbox.minY; y <= waistBandEnd; y++) {
    const r = rows[y];
    if (!r) continue;
    const width = r[1] - r[0];
    if (width > waistWidth) {
      waistWidth = width;
      waistY = y;
    }
  }
  const waistRow = rows[waistY];
  if (!waistRow) return null;

  // Hem: average the bottom band's rows, robust against a single stray pixel.
  const hemBandStart = Math.max(bbox.minY, bbox.maxY - Math.round(bboxH * opts.hemBandFrac));
  let hemMinSum = 0;
  let hemMaxSum = 0;
  let hemCount = 0;
  for (let y = hemBandStart; y <= bbox.maxY; y++) {
    const r = rows[y];
    if (!r) continue;
    hemMinSum += r[0];
    hemMaxSum += r[1];
    hemCount++;
  }
  const hemY = bbox.maxY;
  const hemL_x = hemCount > 0 ? hemMinSum / hemCount : waistRow[0];
  const hemR_x = hemCount > 0 ? hemMaxSum / hemCount : waistRow[1];

  return {
    waistL: [waistRow[0], waistY],
    waistR: [waistRow[1], waistY],
    hemL: [hemL_x, hemY],
    hemR: [hemR_x, hemY],
  };
}

export interface CroppedBitmap {
  bitmap: ImageBitmap;
  alphaData: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Crops a background-removed bitmap to its own alpha bounding box (plus a
 * small margin), matching how catalog garment PNGs are already framed
 * tightly to their silhouette, and returns the cropped alpha data alongside
 * so callers (GarmentUpload.tsx) don't need a second getImageData pass for
 * suggestAnchors. Returns null if the image is fully transparent (matting
 * found no garment).
 */
export async function cropToAlphaBBox(
  bitmap: ImageBitmap,
  marginFrac = 0.04,
): Promise<CroppedBitmap | null> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('cropToAlphaBBox: no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const full = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const bbox = findAlphaBBox(full.data, bitmap.width, bitmap.height);
  if (!bbox) return null;

  const bw = bbox.maxX - bbox.minX + 1;
  const bh = bbox.maxY - bbox.minY + 1;
  const mx = Math.round(bw * marginFrac);
  const my = Math.round(bh * marginFrac);
  const cropX = Math.max(0, bbox.minX - mx);
  const cropY = Math.max(0, bbox.minY - my);
  const cropW = Math.min(bitmap.width, bbox.maxX + mx + 1) - cropX;
  const cropH = Math.min(bitmap.height, bbox.maxY + my + 1) - cropY;

  const cropCanvas = new OffscreenCanvas(cropW, cropH);
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) throw new Error('cropToAlphaBBox: no 2d context');
  cropCtx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  const croppedData = cropCtx.getImageData(0, 0, cropW, cropH).data;
  const croppedBitmap = await createImageBitmap(cropCanvas);
  return { bitmap: croppedBitmap, alphaData: croppedData, width: cropW, height: cropH };
}
