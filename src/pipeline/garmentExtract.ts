/**
 * Worn-garment extraction for user uploads (see docs/plan-3d-garment-assets.md
 * §5.2 and workers/matting.worker.ts): background removal (MODNet) keeps the
 * whole salient foreground — for a photo of someone WEARING the garment,
 * that's the person, head and arms and all. This module combines the matting
 * alpha with a clothes-parsing segmentation (SegFormer trained on human
 * parsing: per-pixel labels like "Upper-clothes", "Dress", "Face",
 * "Left-arm") to keep only the garment itself.
 *
 * Decision logic, in order:
 *  - No meaningful human-part area in the parse → flat-lay/hanger photo →
 *    'no-person': keep the plain matting result unchanged. The parsing
 *    model is trained on worn clothes and can't be trusted on flat-lays,
 *    so extraction must never subtract from that (previously working) path.
 *  - A person is present → keep the DOMINANT single garment class between
 *    "Upper-clothes" and "Dress" (the app's upload categories are
 *    tops/kurtis/dresses — never pants/skirts, so a t-shirt-plus-jeans
 *    photo extracts the t-shirt rather than fusing both into one asset),
 *    plus "Belt"/"Scarf" so those don't punch stripe-shaped holes through
 *    an outfit that includes them.
 *  - A person is present but neither garment class has meaningful area →
 *    'no-garment-found': the caller should surface a friendly error rather
 *    than ship a person cutout as a "garment".
 *
 * Framework-free and canvas-free (raw pixel buffers in, raw alpha out) —
 * unit-testable in isolation, per the pipeline/ convention.
 */

/** One label's binary mask from semantic segmentation: 255 where the class is present, 0 elsewhere. */
export interface LabelMask {
  label: string;
  /** w*h single-channel buffer. */
  maskData: Uint8ClampedArray;
}

export interface GarmentExtractOptions {
  humanPresenceFrac: number;
  minGarmentFrac: number;
  maskBlurPx: number;
}

export type GarmentExtractResult =
  | { kind: 'garment'; alpha: Uint8ClampedArray }
  | { kind: 'no-person' }
  | { kind: 'no-garment-found' };

/** Labels that mean "the wearer, not the garment" — their presence is what flags a worn photo. */
const HUMAN_PART_LABELS: readonly string[] = [
  'Hat',
  'Hair',
  'Sunglasses',
  'Left-shoe',
  'Right-shoe',
  'Face',
  'Left-leg',
  'Right-leg',
  'Left-arm',
  'Right-arm',
];

/** Candidate primary garments — matches the app's uploadable categories (tops/kurtis/dresses). */
const GARMENT_PRIMARY_LABELS: readonly string[] = ['Upper-clothes', 'Dress'];

/** Kept along with the primary so they don't leave holes through the garment they sit on. */
const GARMENT_EXTRA_LABELS: readonly string[] = ['Belt', 'Scarf'];

const OPAQUE_THRESHOLD = 127;

function countOpaque(data: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > OPAQUE_THRESHOLD) n++;
  }
  return n;
}

/**
 * Separable box blur on a single-channel buffer — O(w*h) regardless of
 * radius via a running-sum window (same approach as compositor.ts's
 * boxBlurRedChannel, but single-channel).
 */
function boxBlurChannel(data: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  const out = new Float32Array(w * h);
  if (radius <= 0) {
    out.set(data);
    return out;
  }

  const tmp = new Float32Array(w * h);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += data[y * w + Math.min(w - 1, Math.max(0, x))];
    }
    tmp[y * w] = sum / size;
    for (let x = 1; x < w; x++) {
      const addX = Math.min(w - 1, x + radius);
      const subX = Math.max(0, x - radius - 1);
      sum += data[y * w + addX] - data[y * w + subX];
      tmp[y * w + x] = sum / size;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    }
    out[x] = sum / size;
    for (let y = 1; y < h; y++) {
      const addY = Math.min(h - 1, y + radius);
      const subY = Math.max(0, y - radius - 1);
      sum += tmp[addY * w + x] - tmp[subY * w + x];
      out[y * w + x] = sum / size;
    }
  }
  return out;
}

/**
 * Combines the matting foreground alpha with clothes-parsing label masks
 * into a garment-only alpha (see module comment for the decision logic).
 * All buffers are w*h single-channel and must share dimensions.
 */
export function extractGarmentAlpha(
  foregroundAlpha: Uint8ClampedArray,
  segments: readonly LabelMask[],
  w: number,
  h: number,
  options: GarmentExtractOptions,
): GarmentExtractResult {
  const foregroundArea = countOpaque(foregroundAlpha);
  if (foregroundArea === 0) return { kind: 'no-person' };

  const byLabel = new Map(segments.map((s) => [s.label, s.maskData] as const));

  let humanArea = 0;
  for (const label of HUMAN_PART_LABELS) {
    const mask = byLabel.get(label);
    if (mask) humanArea += countOpaque(mask);
  }
  if (humanArea / foregroundArea < options.humanPresenceFrac) return { kind: 'no-person' };

  let primaryMask: Uint8ClampedArray | null = null;
  let primaryArea = 0;
  for (const label of GARMENT_PRIMARY_LABELS) {
    const mask = byLabel.get(label);
    if (!mask) continue;
    const area = countOpaque(mask);
    if (area > primaryArea) {
      primaryArea = area;
      primaryMask = mask;
    }
  }
  if (!primaryMask || primaryArea / foregroundArea < options.minGarmentFrac) {
    return { kind: 'no-garment-found' };
  }

  const combined = new Uint8ClampedArray(primaryMask);
  for (const label of GARMENT_EXTRA_LABELS) {
    const mask = byLabel.get(label);
    if (!mask) continue;
    for (let i = 0; i < combined.length; i++) {
      if (mask[i] > OPAQUE_THRESHOLD) combined[i] = 255;
    }
  }

  const soft = boxBlurChannel(combined, w, h, options.maskBlurPx);
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = Math.round((foregroundAlpha[i] * soft[i]) / 255);
  }
  return { kind: 'garment', alpha };
}
