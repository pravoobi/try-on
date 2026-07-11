/**
 * Composites a warped garment onto a photo: frame → warped garment (shaded
 * per-pixel against an estimated light when an advanced-mode normal map is
 * available — Phase A3, see applyGarmentShading) → clipped to the feathered
 * person mask, so fabric never spills onto the background → occlusion
 * patches restoring frame pixels wherever the person is in front of the
 * fabric. Occlusion has two implementations (see applyDepthOcclusion vs
 * drawArmOcclusion below): depth-tested when an advanced-mode person depth
 * map is available (Phase A2), else the arm-capsule heuristic (see
 * CLAUDE.md Phase 2 occlusion note) simple mode has always used.
 *
 * Also covers the lehenga-choli case (renderLehengaCholiTryOn): two
 * independently-photographed pieces, each warped on its own anchor set and
 * composited before the mask clip — see CLAUDE.md's garment difficulty
 * order ("treat as two garments... composite both").
 */
import { config } from '../config';
import { computeBodyAnchors, computeLehengaSkirtBodyAnchors } from './anchorMapping';
import { clipToMask, openMaskBelow, renderFeatheredMask } from './maskRender';
import { applyGarmentShading, estimateLight, type ShadingBBox } from './relight';
import {
  ANCHOR_NAMES,
  SKIRT_ANCHOR_NAMES,
  type GarmentAnchors,
  type HemLength,
  type Keypoint,
  type Point,
  type SkirtAnchors,
} from './types';
import { renderGarmentWarp, type WarpGridOptions } from './warp';

type Canvas2DContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface TryOnInput {
  frame: ImageBitmap;
  maskBitmap: ImageBitmap;
  keypoints: readonly Keypoint[];
  garmentImage: CanvasImageSource & { width: number; height: number };
  garmentAnchors: GarmentAnchors;
  hemLength: HemLength;
  warpGrid?: WarpGridOptions;
  armOcclusion?: boolean;
  /** Fraction of shoulder-to-shoulder width used as the occlusion capsule radius (fallback path only). */
  armOcclusionRadiusFactor?: number;
  /** Advanced-mode person depth map (Phase A2) — when present, occlusion is
   * depth-tested per-pixel instead of the arm-capsule heuristic. Same pixel
   * dimensions as `frame`. */
  personDepth?: ImageBitmap | null;
  /** Advanced-mode garment normal map (Phase A3), same pixel space/coverage
   * as `garmentImage` — when present, the garment is Lambertian-shaded
   * against a light estimated from `frame` before compositing. */
  garmentNormal?: (CanvasImageSource & { width: number; height: number }) | null;
}

export type TryOnStatus = 'ok' | 'pose-not-anchorable';

/**
 * Draws the composited result into `ctx` (sized frame.width x frame.height).
 * Returns 'pose-not-anchorable' (and draws just the frame) when the torso
 * isn't confidently visible enough to place the garment.
 */
export function renderTryOn(ctx: Canvas2DContext, input: TryOnInput): TryOnStatus {
  const { frame, maskBitmap, keypoints, garmentImage, garmentAnchors, hemLength } = input;
  const w = frame.width;
  const h = frame.height;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(frame, 0, 0);

  const bodyAnchors = computeBodyAnchors(keypoints, hemLength);
  if (!bodyAnchors) return 'pose-not-anchorable';

  const srcPoints: Point[] = ANCHOR_NAMES.map((n) => garmentAnchors[n]);
  const dstPoints: Point[] = ANCHOR_NAMES.map((n) => bodyAnchors[n]);

  const garmentLayer = renderGarmentWarp(
    garmentImage,
    srcPoints,
    dstPoints,
    w,
    h,
    input.warpGrid,
  );

  let shadedLayer = garmentLayer;
  if (input.garmentNormal) {
    const normalLayer = renderGarmentWarp(input.garmentNormal, srcPoints, dstPoints, w, h, input.warpGrid);
    const light = estimateLight(frame, maskBitmap, w, h);
    const bbox = toPixelBBox(expandedAnchorBBox(bodyAnchors, config.relighting.bboxMarginFrac, w, h));
    shadedLayer = applyGarmentShading(garmentLayer, normalLayer, light, bbox, w, h, input.personDepth);
  }

  const feathered = renderFeatheredMask(maskBitmap, w, h);
  // A hip-length top is fitted everywhere, so the person mask clips all of
  // it; a knee/ankle garment hangs free below the waist — open the clip
  // there so the hem drapes over the background and the gap between legs.
  const waistY = (bodyAnchors.waistL[1] + bodyAnchors.waistR[1]) / 2;
  const hemY = (bodyAnchors.hemL[1] + bodyAnchors.hemR[1]) / 2;
  const skirtLen = hemY - waistY;
  // Open blend is generous (fitted at the waist, free by mid-thigh); the
  // hem cut is tight — junk in background-removed garment photos (the
  // original model's shoes) starts right at the hem line.
  const clipMask =
    hemLength === 'hip'
      ? feathered
      : openMaskBelow(feathered, waistY, skirtLen * 0.2, hemY + skirtLen * 0.03, skirtLen * 0.05);
  const clipped = clipToMask(shadedLayer, w, h, clipMask);
  ctx.drawImage(clipped, 0, 0);

  if (input.armOcclusion !== false) {
    if (input.personDepth) {
      applyDepthOcclusion(ctx, frame, input.personDepth, keypoints, bodyAnchors, w, h);
    } else {
      drawArmOcclusion(ctx, frame, keypoints, bodyAnchors, input.armOcclusionRadiusFactor ?? 0.14);
    }
  }

  return 'ok';
}

export interface LehengaCholiTryOnInput {
  frame: ImageBitmap;
  maskBitmap: ImageBitmap;
  keypoints: readonly Keypoint[];
  choliImage: CanvasImageSource & { width: number; height: number };
  choliAnchors: GarmentAnchors;
  lehengaImage: CanvasImageSource & { width: number; height: number };
  lehengaAnchors: SkirtAnchors;
  /** The lehenga's hem length (knee/ankle) — the choli's own hem is always the natural waistline. */
  skirtLength: HemLength;
  warpGrid?: WarpGridOptions;
  armOcclusion?: boolean;
  armOcclusionRadiusFactor?: number;
  personDepth?: ImageBitmap | null;
  /** Advanced-mode normal maps (Phase A3) for each piece, same pixel space/coverage as their respective images. */
  choliNormal?: (CanvasImageSource & { width: number; height: number }) | null;
  lehengaNormal?: (CanvasImageSource & { width: number; height: number }) | null;
}

/**
 * Same idea as renderTryOn but for a two-piece lehenga-choli: the skirt is
 * warped and drawn first, the choli on top of it (so the choli's hem
 * covers the waist seam), both clipped to the mask as one combined layer.
 */
export function renderLehengaCholiTryOn(ctx: Canvas2DContext, input: LehengaCholiTryOnInput): TryOnStatus {
  const { frame, maskBitmap, keypoints, choliImage, choliAnchors, lehengaImage, lehengaAnchors, skirtLength } = input;
  const w = frame.width;
  const h = frame.height;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(frame, 0, 0);

  const choliBody = computeBodyAnchors(keypoints, 'hip');
  if (!choliBody) return 'pose-not-anchorable';
  const skirtBody = computeLehengaSkirtBodyAnchors(keypoints, skirtLength);
  if (!skirtBody) return 'pose-not-anchorable';

  const choliSrc: Point[] = ANCHOR_NAMES.map((n) => choliAnchors[n]);
  const choliDst: Point[] = ANCHOR_NAMES.map((n) => choliBody[n]);
  const skirtSrc: Point[] = SKIRT_ANCHOR_NAMES.map((n) => lehengaAnchors[n]);
  const skirtDst: Point[] = SKIRT_ANCHOR_NAMES.map((n) => skirtBody[n]);

  const lehengaLayer = renderGarmentWarp(lehengaImage, skirtSrc, skirtDst, w, h, input.warpGrid);
  const choliLayer = renderGarmentWarp(choliImage, choliSrc, choliDst, w, h, input.warpGrid);

  let shadedLehengaLayer = lehengaLayer;
  let shadedCholiLayer = choliLayer;
  if (input.choliNormal || input.lehengaNormal) {
    const light = estimateLight(frame, maskBitmap, w, h);
    if (input.choliNormal) {
      const choliNormalLayer = renderGarmentWarp(input.choliNormal, choliSrc, choliDst, w, h, input.warpGrid);
      const bbox = toPixelBBox(expandedAnchorBBox(choliBody, config.relighting.bboxMarginFrac, w, h));
      shadedCholiLayer = applyGarmentShading(choliLayer, choliNormalLayer, light, bbox, w, h, input.personDepth);
    }
    if (input.lehengaNormal) {
      const lehengaNormalLayer = renderGarmentWarp(input.lehengaNormal, skirtSrc, skirtDst, w, h, input.warpGrid);
      const skirtBox = expandBBox(
        bboxOfPoints(SKIRT_ANCHOR_NAMES.map((n) => skirtBody[n])),
        config.relighting.bboxMarginFrac,
        w,
        h,
      );
      shadedLehengaLayer = applyGarmentShading(
        lehengaLayer,
        lehengaNormalLayer,
        light,
        toPixelBBox(skirtBox),
        w,
        h,
        input.personDepth,
      );
    }
  }

  const combined = new OffscreenCanvas(w, h);
  const combinedCtx = combined.getContext('2d');
  if (!combinedCtx) throw new Error('renderLehengaCholiTryOn: no 2d context');
  combinedCtx.drawImage(shadedLehengaLayer, 0, 0);
  combinedCtx.drawImage(shadedCholiLayer, 0, 0);

  const feathered = renderFeatheredMask(maskBitmap, w, h);
  // The skirt hangs free below its waistband — open the clip there so it
  // drapes over the background and the gap between legs, instead of being
  // shrink-wrapped to the leg silhouette. The choli above stays mask-clipped.
  const skirtWaistY = (skirtBody.waistL[1] + skirtBody.waistR[1]) / 2;
  const skirtHemY = (skirtBody.hemL[1] + skirtBody.hemR[1]) / 2;
  const skirtLen = skirtHemY - skirtWaistY;
  const clipMask = openMaskBelow(
    feathered,
    skirtWaistY,
    skirtLen * 0.15,
    skirtHemY + skirtLen * 0.03,
    skirtLen * 0.05,
  );
  const clipped = clipToMask(combined, w, h, clipMask);
  ctx.drawImage(clipped, 0, 0);

  if (input.armOcclusion !== false) {
    if (input.personDepth) {
      applyDepthOcclusion(ctx, frame, input.personDepth, keypoints, choliBody, w, h);
    } else {
      drawArmOcclusion(ctx, frame, keypoints, choliBody, input.armOcclusionRadiusFactor ?? 0.14);
    }
  }

  return 'ok';
}

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

/** Bounding box of a set of points. */
function bboxOfPoints(points: readonly Point[]): BBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** `box` expanded by a fraction of its own size and clamped to (maxW, maxH). */
function expandBBox(box: BBox, marginFrac: number, maxW: number, maxH: number): BBox {
  const mx = (box.maxX - box.minX) * marginFrac;
  const my = (box.maxY - box.minY) * marginFrac;
  return {
    minX: Math.max(0, box.minX - mx),
    minY: Math.max(0, box.minY - my),
    maxX: Math.min(maxW, box.maxX + mx),
    maxY: Math.min(maxH, box.maxY + my),
  };
}

/** Rounds a BBox out to integer pixel bounds for canvas getImageData/patch operations. */
function toPixelBBox(box: BBox): ShadingBBox {
  const bx = Math.floor(box.minX);
  const by = Math.floor(box.minY);
  return { bx, by, bw: Math.ceil(box.maxX) - bx, bh: Math.ceil(box.maxY) - by };
}

/** Bounding box of the garment's body-space anchors — a proxy for "where the fabric is". */
function anchorBBox(anchors: GarmentAnchors): BBox {
  return bboxOfPoints(ANCHOR_NAMES.map((n) => anchors[n]));
}

function overlapsBBox(x: number, y: number, box: BBox): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

/** anchorBBox expanded by a fraction of its own size and clamped to the frame — hands, hair, and held objects typically extend past the torso anchors themselves. */
function expandedAnchorBBox(anchors: GarmentAnchors, marginFrac: number, maxW: number, maxH: number): BBox {
  return expandBBox(anchorBBox(anchors), marginFrac, maxW, maxH);
}

/**
 * Separable box blur of an ImageData's R channel (grayscale depth map),
 * returned as a plain w*h array of blurred values. O(w*h) regardless of
 * radius via a running-sum sliding window, not O(w*h*radius^2).
 */
function boxBlurRedChannel(data: Uint8ClampedArray, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) {
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = data[i * 4];
    return out;
  }

  const tmp = new Float32Array(w * h);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += data[(y * w + Math.min(w - 1, Math.max(0, x))) * 4];
    }
    tmp[y * w] = sum / size;
    for (let x = 1; x < w; x++) {
      const addX = Math.min(w - 1, x + radius);
      const subX = Math.max(0, x - radius - 1);
      sum += data[(y * w + addX) * 4] - data[(y * w + subX) * 4];
      tmp[y * w + x] = sum / size;
    }
  }

  const out = new Float32Array(w * h);
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
 * Depth-tested occlusion (Phase A2 — used whenever an advanced-mode person
 * depth map is available): restores original frame pixels anywhere the
 * person is measurably closer to the camera than the garment's own
 * surface, so arms, hair, and held objects occlude the fabric correctly
 * wherever they actually are in the photo — not just along the forearm
 * segment the arm-capsule fallback special-cases.
 *
 * The garment has no real depth geometry, so its "surface" is approximated
 * as a smooth field interpolated — via the same TPS math the warp itself
 * uses, just with a scalar (depth) target instead of a 2D point — from the
 * person's own measured depth at each body anchor: the torso's actual
 * depth stands in for "roughly where the fabric sits".
 */
function applyDepthOcclusion(
  ctx: Canvas2DContext,
  frame: ImageBitmap,
  personDepth: ImageBitmap,
  keypoints: readonly Keypoint[],
  bodyAnchors: GarmentAnchors,
  w: number,
  h: number,
): void {
  const { bx, by, bw, bh } = toPixelBBox(expandedAnchorBBox(bodyAnchors, config.depthOcclusion.bboxMarginFrac, w, h));
  if (bw <= 0 || bh <= 0) return;

  const depthCanvas = new OffscreenCanvas(w, h);
  const depthCtx = depthCanvas.getContext('2d');
  if (!depthCtx) return;
  depthCtx.drawImage(personDepth, 0, 0, w, h);
  const rawDepthData = depthCtx.getImageData(bx, by, bw, bh).data;
  // Monocular depth estimation isn't just noisy at fine scale — it actively
  // misjudges high-contrast printed/patterned fabric as height variation
  // (a well-known failure mode: bright/dark regions of a print get read as
  // near/far). Left unblurred, that noise crosses the occlusion threshold
  // the same way a real arm-in-front discontinuity does, "revealing" the
  // person's real shirt in the exact shape of its own print. A real
  // occluding object (arm, hair, held item) is a broad, low-frequency
  // depth shift; print-induced noise is high-frequency. Blur suppresses
  // the latter while leaving the former intact.
  const blurRadius = config.depthOcclusion.blurRadiusPx;
  const depthField2D = boxBlurRedChannel(rawDepthData, bw, bh, blurRadius);

  const depthAt = (x: number, y: number): number => {
    const cx = Math.min(bw - 1, Math.max(0, Math.round(x - bx)));
    const cy = Math.min(bh - 1, Math.max(0, Math.round(y - by)));
    return depthField2D[cy * bw + cx];
  };

  // The reference "garment surface depth" must come from real on-body
  // locations. The garment anchor targets (bodyAnchors) are deliberately
  // widened past the body's own edge for fit (see config.anchors.
  // widthScale) — sampling depth there can land in the background. The
  // raw pose keypoints (shoulders/hips) are guaranteed on the body, but a
  // reference built from just those 4 sparse points (a TPS fit through
  // them) is fragile: a single anomalous sample — e.g. a shoulder keypoint
  // landing exactly on a strap or shadow edge, which happens even after
  // blurring, since it's a real local depth feature at that point, not
  // noise — drags the whole *smoothly interpolated* surface down across a
  // wide area, since TPS is a global fit, not a local one. A single
  // person's real hand-on-hip photo showed exactly this: one shoulder
  // sample ~40 gray levels below the other three was enough to falsely
  // "occlude" a large fraction of the torso. Sampling densely across the
  // torso interior (bilinear grid between the 4 keypoints) and taking the
  // median is robust to that: one bad sample among dozens barely moves it.
  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const shoulderL = byName.get('left_shoulder');
  const shoulderR = byName.get('right_shoulder');
  const hipL = byName.get('left_hip');
  const hipR = byName.get('right_hip');
  const minScore = config.minKeypointScore;
  if (
    !shoulderL || !shoulderR || !hipL || !hipR ||
    shoulderL.score < minScore || shoulderR.score < minScore ||
    hipL.score < minScore || hipR.score < minScore
  ) {
    return; // torso not confidently visible; skip occlusion this frame.
  }
  const torsoSamples: number[] = [];
  const GRID = 5;
  for (let iv = 1; iv < GRID; iv++) {
    const v = iv / GRID;
    for (let iu = 1; iu < GRID; iu++) {
      const u = iu / GRID;
      const topPt: Point = [shoulderL.x + (shoulderR.x - shoulderL.x) * u, shoulderL.y + (shoulderR.y - shoulderL.y) * u];
      const botPt: Point = [hipL.x + (hipR.x - hipL.x) * u, hipL.y + (hipR.y - hipL.y) * u];
      const x = topPt[0] + (botPt[0] - topPt[0]) * v;
      const y = topPt[1] + (botPt[1] - topPt[1]) * v;
      torsoSamples.push(depthAt(x, y));
    }
  }
  torsoSamples.sort((a, b) => a - b);
  const garmentVal = torsoSamples[Math.floor(torsoSamples.length / 2)];

  const { marginGray, softBandGray } = config.depthOcclusion;
  const maskData = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const personVal = depthField2D[y * bw + x];
      // Soft threshold: fully occluded well past the margin, fully fabric
      // well before it, a smooth ramp across the band between.
      const t = (personVal - (garmentVal + marginGray)) / softBandGray;
      const alpha = Math.max(0, Math.min(1, t));
      const i = (y * bw + x) * 4;
      maskData[i] = 255;
      maskData[i + 1] = 255;
      maskData[i + 2] = 255;
      maskData[i + 3] = Math.round(alpha * 255);
    }
  }

  const maskCanvas = new OffscreenCanvas(bw, bh);
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) return;
  maskCtx.putImageData(new ImageData(maskData, bw, bh), 0, 0);

  const framePatch = new OffscreenCanvas(bw, bh);
  const framePatchCtx = framePatch.getContext('2d');
  if (!framePatchCtx) return;
  framePatchCtx.drawImage(frame, bx, by, bw, bh, 0, 0, bw, bh);

  const clippedPatch = clipToMask(framePatch, bw, bh, maskCanvas);
  ctx.drawImage(clippedPatch, bx, by);
}

/**
 * Restores original frame pixels along each forearm (elbow→wrist, extended
 * slightly past the wrist for the hand) when that arm crosses the garment's
 * bounding box — an approximation of correct depth ordering without a real
 * depth/segmentation-per-limb signal. Fallback path used when no
 * advanced-mode depth map is available (see applyDepthOcclusion above).
 */
function drawArmOcclusion(
  ctx: Canvas2DContext,
  frame: ImageBitmap,
  keypoints: readonly Keypoint[],
  bodyAnchors: GarmentAnchors,
  radiusFactor: number,
): void {
  const box = anchorBBox(bodyAnchors);
  const [slx, sly] = bodyAnchors.shoulderL;
  const [srx, sry] = bodyAnchors.shoulderR;
  const shoulderWidth = Math.hypot(srx - slx, sry - sly);
  const radius = Math.max(2, shoulderWidth * radiusFactor);

  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const minScore = 0.3;

  for (const [elbowName, wristName] of [
    ['left_elbow', 'left_wrist'],
    ['right_elbow', 'right_wrist'],
  ] as const) {
    const elbow = byName.get(elbowName);
    const wrist = byName.get(wristName);
    if (!elbow || !wrist || elbow.score < minScore || wrist.score < minScore) continue;
    if (!overlapsBBox(elbow.x, elbow.y, box) && !overlapsBBox(wrist.x, wrist.y, box)) continue;

    // Extend a bit past the wrist to cover the hand.
    const dx = wrist.x - elbow.x;
    const dy = wrist.y - elbow.y;
    const ex = wrist.x + dx * 0.35;
    const ey = wrist.y + dy * 0.35;

    ctx.save();
    capsulePath(ctx, elbow.x, elbow.y, ex, ey, radius);
    ctx.clip();
    ctx.drawImage(frame, 0, 0);
    ctx.restore();
  }
}

/** Builds a stadium/capsule-shaped clip path along the segment (x1,y1)-(x2,y2). */
function capsulePath(
  ctx: Canvas2DContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * r;
  const ny = (dx / len) * r;
  const angle = Math.atan2(dy, dx);

  ctx.beginPath();
  ctx.moveTo(x1 + nx, y1 + ny);
  ctx.lineTo(x2 + nx, y2 + ny);
  ctx.arc(x2, y2, r, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.lineTo(x1 - nx, y1 - ny);
  ctx.arc(x1, y1, r, angle + Math.PI / 2, angle + Math.PI * 1.5);
  ctx.closePath();
}
