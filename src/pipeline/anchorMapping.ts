/**
 * Maps detected body keypoints to the body-space anchor targets a garment's
 * TPS warp is fit to (see CLAUDE.md "Garment data model" — shoulders direct,
 * waist interpolated shoulder→hip, hem extrapolated below hips per
 * meta.length). Also covers the lehenga-choli case: the skirt's waistband
 * shares the exact hip-line point the choli's own hem would use, so the two
 * independently-warped pieces meet with no gap.
 */
import { config } from '../config';
import type { BodyAnchors, HemLength, Keypoint, KeypointName, Point, SkirtAnchors } from './types';

function findKeypoint(keypoints: readonly Keypoint[], name: KeypointName): Keypoint | undefined {
  return keypoints.find((k) => k.name === name);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Pushes two points apart from their shared midpoint by `scale`. */
function scalePairOutward(a: Point, b: Point, scale: number): [Point, Point] {
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  return [
    [cx + (a[0] - cx) * scale, cy + (a[1] - cy) * scale],
    [cx + (b[0] - cx) * scale, cy + (b[1] - cy) * scale],
  ];
}

const HEM_KEYPOINTS: Record<HemLength, readonly [KeypointName, KeypointName] | null> = {
  hip: null,
  knee: ['left_knee', 'right_knee'],
  ankle: ['left_ankle', 'right_ankle'],
};

interface TorsoContext {
  shoulderL: Point;
  shoulderR: Point;
  hipL: Point;
  hipR: Point;
  torsoHeight: number;
}

/**
 * Shared confidence gate + torso measurements used by every anchor-target
 * computation. Returns null if the torso isn't confidently visible enough
 * to anchor a garment (e.g. back-facing, heavily occluded, non-person photo).
 */
function computeTorsoContext(keypoints: readonly Keypoint[]): TorsoContext | null {
  const ls = findKeypoint(keypoints, 'left_shoulder');
  const rs = findKeypoint(keypoints, 'right_shoulder');
  const lh = findKeypoint(keypoints, 'left_hip');
  const rh = findKeypoint(keypoints, 'right_hip');
  const minScore = config.minKeypointScore;
  if (
    !ls ||
    !rs ||
    !lh ||
    !rh ||
    ls.score < minScore ||
    rs.score < minScore ||
    lh.score < minScore ||
    rh.score < minScore
  ) {
    return null;
  }

  const torsoHeight = Math.abs((lh.y + rh.y) / 2 - (ls.y + rs.y) / 2);

  // Keypoints sit at skeletal joints, well inside the clothed silhouette —
  // anchoring fabric to the raw joints leaves skin strips at the shoulders
  // and hips. Widen the targets to the body's visual edges and lift the
  // shoulder targets to the top of the shoulder (the joint center is below
  // the seam line). Overflow past the silhouette is clipped to the person
  // mask downstream, so erring wide is safe.
  const lift = torsoHeight * config.anchors.shoulderLift;
  const [shoulderL, shoulderR] = scalePairOutward(
    [ls.x, ls.y - lift],
    [rs.x, rs.y - lift],
    config.anchors.widthScale.shoulder,
  );
  const [hipL, hipR] = scalePairOutward([lh.x, lh.y], [rh.x, rh.y], config.anchors.widthScale.hip);

  return { shoulderL, shoulderR, hipL, hipR, torsoHeight };
}

/** Returns the [leftY, rightY] a hem/skirt-bottom should sit at, per the
 * knee/ankle keypoint if confidently visible, else a hip-relative fallback. */
function computeHemY(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  ctx: TorsoContext,
): [number, number] {
  const pair = HEM_KEYPOINTS[hemLength];
  if (pair) {
    const l = findKeypoint(keypoints, pair[0]);
    const r = findKeypoint(keypoints, pair[1]);
    if (l && r && l.score >= config.minKeypointScore && r.score >= config.minKeypointScore) {
      return [l.y, r.y];
    }
  }
  const dy = ctx.torsoHeight * config.anchors.hemFallbackMultiplier[hemLength];
  return [ctx.hipL[1] + dy, ctx.hipR[1] + dy];
}

function computeHem(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  ctx: TorsoContext,
): [Point, Point] {
  // Garment hangs from the hip line: only the keypoint's depth (y) is used,
  // x stays at the hips. Correct for a fitted dress/kurti hem, which follows
  // the body silhouette rather than flaring outward.
  const [ly, ry] = computeHemY(keypoints, hemLength, ctx);
  return [
    [ctx.hipL[0], ly],
    [ctx.hipR[0], ry],
  ];
}

/**
 * Like computeHem, but flares the hem outward from the hips by
 * config.anchors.skirtFlare[skirtLength] — a lehenga skirt's hem is
 * dramatically wider than its waistband, unlike a fitted dress hem which
 * hangs straight down. Collapsing it to hip-width (as computeHem does)
 * mismatches the garment image's own wide flare badly enough that the TPS
 * warp folds over itself.
 */
function computeFlaredHem(
  keypoints: readonly Keypoint[],
  skirtLength: HemLength,
  ctx: TorsoContext,
): [Point, Point] {
  const [ly, ry] = computeHemY(keypoints, skirtLength, ctx);
  const centerX = (ctx.hipL[0] + ctx.hipR[0]) / 2;
  const hipHalfWidth = Math.abs(ctx.hipR[0] - ctx.hipL[0]) / 2;
  const halfWidth = hipHalfWidth * config.anchors.skirtFlare[skirtLength];
  const sign = Math.sign(ctx.hipL[0] - ctx.hipR[0]) || 1;
  return [
    [centerX + sign * halfWidth, ly],
    [centerX - sign * halfWidth, ry],
  ];
}

/**
 * Computes the 6 body-space anchor targets, or null if the torso isn't
 * confidently visible enough to anchor a garment.
 */
export function computeBodyAnchors(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
): BodyAnchors | null {
  const ctx = computeTorsoContext(keypoints);
  if (!ctx) return null;

  const t = config.anchors.waistT;
  const waistL: Point = [lerp(ctx.shoulderL[0], ctx.hipL[0], t), lerp(ctx.shoulderL[1], ctx.hipL[1], t)];
  const waistR: Point = [lerp(ctx.shoulderR[0], ctx.hipR[0], t), lerp(ctx.shoulderR[1], ctx.hipR[1], t)];

  const [hemL, hemR] = computeHem(keypoints, hemLength, ctx);

  return { shoulderL: ctx.shoulderL, shoulderR: ctx.shoulderR, waistL, waistR, hemL, hemR };
}

/**
 * Computes the lehenga skirt's body-space anchor targets (waist + hem only).
 * The waistband is exactly the point computeBodyAnchors(keypoints, 'hip')
 * would use as the choli's own hem — that shared point is what makes the
 * two independently-warped pieces meet with no visible seam gap.
 */
export function computeLehengaSkirtBodyAnchors(
  keypoints: readonly Keypoint[],
  skirtLength: HemLength,
): SkirtAnchors | null {
  const ctx = computeTorsoContext(keypoints);
  if (!ctx) return null;

  const [waistL, waistR] = computeHem(keypoints, 'hip', ctx);
  const [hemL, hemR] = computeFlaredHem(keypoints, skirtLength, ctx);

  return { waistL, waistR, hemL, hemR };
}
