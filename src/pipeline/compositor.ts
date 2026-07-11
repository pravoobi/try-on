/**
 * Composites a warped garment onto a photo: frame → warped garment (clipped
 * to the feathered person mask, so fabric never spills onto the background)
 * → arm-occlusion patches (approximate "arms in front of fabric" — see
 * CLAUDE.md Phase 2 occlusion note).
 */
import { computeBodyAnchors } from './anchorMapping';
import { clipToMask, renderFeatheredMask } from './maskRender';
import { ANCHOR_NAMES, type GarmentAnchors, type HemLength, type Keypoint, type Point } from './types';
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
  /** Fraction of shoulder-to-shoulder width used as the occlusion capsule radius. */
  armOcclusionRadiusFactor?: number;
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
  const clipped = clipToMask(garmentLayer, w, h, feathered);
  ctx.drawImage(clipped, 0, 0);

  if (input.armOcclusion !== false) {
    drawArmOcclusion(ctx, frame, keypoints, bodyAnchors, input.armOcclusionRadiusFactor ?? 0.14);
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

/**
 * Restores original frame pixels along each forearm (elbow→wrist, extended
 * slightly past the wrist for the hand) when that arm crosses the garment's
 * bounding box — an approximation of correct depth ordering without a real
 * depth/segmentation-per-limb signal.
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
