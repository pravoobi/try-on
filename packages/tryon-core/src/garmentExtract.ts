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

/**
 * Which half of a worn outfit to keep. An on-model photo almost always
 * contains BOTH an upper and a lower garment (a trousers product shot has
 * the model's shirt in frame too), so the caller must say which one the
 * photo is being ingested as — picking the largest garment class would
 * extract the shirt from a trousers photo about as often as not.
 */
export type GarmentTarget = 'upper' | 'lower';

export interface GarmentExtractOptions {
  humanPresenceFrac: number;
  minGarmentFrac: number;
  maskBlurPx: number;
  /** Defaults to 'upper' — the historical behavior, and what the tops/kurtis/dresses upload path wants. */
  target?: GarmentTarget;
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

/**
 * Candidate primary garment classes per target, and the secondary classes
 * kept alongside so they don't punch holes through the garment they sit on
 * (a belt worn over a kurti, a scarf over a top, a belt at a trouser
 * waistband). Only ONE primary is kept — the largest present — so a
 * t-shirt-plus-jeans photo yields one asset, not a fused blob.
 */
const PRIMARY_LABELS: Record<GarmentTarget, readonly string[]> = {
  upper: ['Upper-clothes', 'Dress'],
  lower: ['Pants', 'Skirt'],
};

const EXTRA_LABELS: Record<GarmentTarget, readonly string[]> = {
  upper: ['Belt', 'Scarf'],
  lower: ['Belt'],
};

const OPAQUE_THRESHOLD = 127;

/**
 * Fills interior holes in a binary garment mask: any non-garment pixel that
 * can't reach the image border through other non-garment pixels is enclosed
 * BY the garment, so it belongs to the garment.
 *
 * This matters because the parser labels whatever visually occludes the
 * fabric — hair falling over a shoulder, a hand in a pocket, a bag strap —
 * as its own class, and those pixels are then subtracted, punching holes
 * clean through the cutout (observed: a striped shirt lost most of one
 * shoulder to a "Hair" region, a polo lost chunks to "Left-arm"). The
 * garment physically continues behind the occluder, so the silhouette
 * should too.
 *
 * Connectivity, not a morphological close, is what makes this safe for the
 * shapes that legitimately have gaps: the space between two trouser legs
 * opens downward to the hem and reaches the border, so it survives; a
 * fully-enclosed keyhole neckline would be filled, which is the accepted
 * trade (rare, and far less damaging than a hole through a shoulder).
 * Same reasoning as the background flood fill in tools/process-new-garments.mjs.
 */
function fillEnclosedHoles(mask: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h;
  const reachable = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  const seed = (idx: number) => {
    if (reachable[idx] || mask[idx] > OPAQUE_THRESHOLD) return;
    reachable[idx] = 1;
    stack[sp++] = idx;
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }

  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) seed(idx - 1);
    if (x < w - 1) seed(idx + 1);
    if (y > 0) seed(idx - w);
    if (y < h - 1) seed(idx + w);
  }

  for (let i = 0; i < n; i++) {
    if (!reachable[i] && mask[i] <= OPAQUE_THRESHOLD) mask[i] = 255;
  }
}

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

  const target = options.target ?? 'upper';
  let primaryMask: Uint8ClampedArray | null = null;
  let primaryArea = 0;
  for (const label of PRIMARY_LABELS[target]) {
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
  for (const label of EXTRA_LABELS[target]) {
    const mask = byLabel.get(label);
    if (!mask) continue;
    for (let i = 0; i < combined.length; i++) {
      if (mask[i] > OPAQUE_THRESHOLD) combined[i] = 255;
    }
  }
  fillEnclosedHoles(combined, w, h);

  const soft = boxBlurChannel(combined, w, h, options.maskBlurPx);
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = Math.round((foregroundAlpha[i] * soft[i]) / 255);
  }
  return { kind: 'garment', alpha };
}
