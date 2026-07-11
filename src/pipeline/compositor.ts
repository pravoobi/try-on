/**
 * Composites a warped garment onto a photo: frame → warped garment (clipped
 * to the feathered person mask, so fabric never spills onto the background)
 * → occlusion patches restoring frame pixels wherever the person is in front
 * of the fabric. Occlusion has two implementations (see applyDepthOcclusion
 * vs drawArmOcclusion below): depth-tested when an advanced-mode person
 * depth map is available (Phase A2), else the arm-capsule heuristic (see
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
import {
  ANCHOR_NAMES,
  SKIRT_ANCHOR_NAMES,
  type GarmentAnchors,
  type HemLength,
  type Keypoint,
  type Point,
  type SkirtAnchors,
} from './types';
import { renderGarmentWarp, ThinPlateSpline, type WarpGridOptions } from './warp';

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
  const clipped = clipToMask(garmentLayer, w, h, clipMask);
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

  const combined = new OffscreenCanvas(w, h);
  const combinedCtx = combined.getContext('2d');
  if (!combinedCtx) throw new Error('renderLehengaCholiTryOn: no 2d context');
  combinedCtx.drawImage(lehengaLayer, 0, 0);
  combinedCtx.drawImage(choliLayer, 0, 0);

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

/** Bounding box of the garment's body-space anchors — a proxy for "where the fabric is". */
function anchorBBox(anchors: GarmentAnchors): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = ANCHOR_NAMES.map((n) => anchors[n][0]);
  const ys = ANCHOR_NAMES.map((n) => anchors[n][1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function overlapsBBox(x: number, y: number, box: ReturnType<typeof anchorBBox>): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

/** anchorBBox expanded by a fraction of its own size and clamped to the frame — hands, hair, and held objects typically extend past the torso anchors themselves. */
function expandedAnchorBBox(
  anchors: GarmentAnchors,
  marginFrac: number,
  maxW: number,
  maxH: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const box = anchorBBox(anchors);
  const mx = (box.maxX - box.minX) * marginFrac;
  const my = (box.maxY - box.minY) * marginFrac;
  return {
    minX: Math.max(0, box.minX - mx),
    minY: Math.max(0, box.minY - my),
    maxX: Math.min(maxW, box.maxX + mx),
    maxY: Math.min(maxH, box.maxY + my),
  };
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
  const box = expandedAnchorBBox(bodyAnchors, config.depthOcclusion.bboxMarginFrac, w, h);
  const bx = Math.floor(box.minX);
  const by = Math.floor(box.minY);
  const bw = Math.ceil(box.maxX) - bx;
  const bh = Math.ceil(box.maxY) - by;
  if (bw <= 0 || bh <= 0) return;

  const depthCanvas = new OffscreenCanvas(w, h);
  const depthCtx = depthCanvas.getContext('2d');
  if (!depthCtx) return;
  depthCtx.drawImage(personDepth, 0, 0, w, h);
  const depthData = depthCtx.getImageData(bx, by, bw, bh).data;

  const depthAt = (x: number, y: number): number => {
    const cx = Math.min(bw - 1, Math.max(0, Math.round(x - bx)));
    const cy = Math.min(bh - 1, Math.max(0, Math.round(y - by)));
    return depthData[(cy * bw + cx) * 4]; // grayscale depth map: R channel carries the value.
  };

  // The depth field's control points must be real on-body locations. The
  // garment anchor targets (bodyAnchors) are deliberately widened past the
  // body's own edge for fit (see config.anchors.widthScale) — sampling
  // depth there can land in the background and drag the whole reference
  // surface down, making nearly the entire torso register as "occluded".
  // The raw pose keypoints are guaranteed on the body.
  const byName = new Map(keypoints.map((k) => [k.name, k] as const));
  const torsoPoints: Point[] = [];
  for (const name of ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'] as const) {
    const kp = byName.get(name);
    if (kp && kp.score >= config.minKeypointScore) torsoPoints.push([kp.x, kp.y]);
  }
  if (torsoPoints.length < 3) return; // not enough for a TPS fit; skip occlusion this frame.

  // A degenerate TPS: solving for a scalar (depth) target by holding the
  // second output dimension at 0 reuses ThinPlateSpline's X-solve exactly
  // as a scalar interpolant (its X/Y solves are already independent).
  const depthField = new ThinPlateSpline(
    torsoPoints,
    torsoPoints.map(([x, y]): Point => [depthAt(x, y), 0]),
  );

  const { marginGray, softBandGray } = config.depthOcclusion;
  const maskData = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const personVal = depthData[(y * bw + x) * 4];
      const garmentVal = depthField.eval([bx + x, by + y])[0];
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
