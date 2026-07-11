/**
 * Maps detected body keypoints to the 6 named body-space anchor targets a
 * garment's TPS warp is fit to (see CLAUDE.md "Garment data model" —
 * shoulders direct, waist interpolated shoulder→hip, hem extrapolated below
 * hips per meta.length).
 */
import { config } from '../config';
import type { BodyAnchors, HemLength, Keypoint, KeypointName, Point } from './types';

function findKeypoint(keypoints: readonly Keypoint[], name: KeypointName): Keypoint | undefined {
  return keypoints.find((k) => k.name === name);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const HEM_KEYPOINTS: Record<HemLength, readonly [KeypointName, KeypointName] | null> = {
  hip: null,
  knee: ['left_knee', 'right_knee'],
  ankle: ['left_ankle', 'right_ankle'],
};

interface HemContext {
  hipL: Point;
  hipR: Point;
  torsoHeight: number;
}

function computeHem(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
  ctx: HemContext,
): [Point, Point] {
  const pair = HEM_KEYPOINTS[hemLength];
  if (pair) {
    const l = findKeypoint(keypoints, pair[0]);
    const r = findKeypoint(keypoints, pair[1]);
    if (l && r && l.score >= config.minKeypointScore && r.score >= config.minKeypointScore) {
      // Garment hangs from the hip line; only the keypoint's depth (y) is used.
      return [
        [ctx.hipL[0], l.y],
        [ctx.hipR[0], r.y],
      ];
    }
  }
  const dy = ctx.torsoHeight * config.anchors.hemFallbackMultiplier[hemLength];
  return [
    [ctx.hipL[0], ctx.hipL[1] + dy],
    [ctx.hipR[0], ctx.hipR[1] + dy],
  ];
}

/**
 * Computes the 6 body-space anchor targets, or null if the torso isn't
 * confidently visible enough to anchor a garment (e.g. back-facing, heavily
 * occluded, or a non-person photo).
 */
export function computeBodyAnchors(
  keypoints: readonly Keypoint[],
  hemLength: HemLength,
): BodyAnchors | null {
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

  const shoulderL: Point = [ls.x, ls.y];
  const shoulderR: Point = [rs.x, rs.y];
  const hipL: Point = [lh.x, lh.y];
  const hipR: Point = [rh.x, rh.y];
  const torsoHeight = Math.abs((hipL[1] + hipR[1]) / 2 - (shoulderL[1] + shoulderR[1]) / 2);

  const t = config.anchors.waistT;
  const waistL: Point = [lerp(shoulderL[0], hipL[0], t), lerp(shoulderL[1], hipL[1], t)];
  const waistR: Point = [lerp(shoulderR[0], hipR[0], t), lerp(shoulderR[1], hipR[1], t)];

  const [hemL, hemR] = computeHem(keypoints, hemLength, { hipL, hipR, torsoHeight });

  return { shoulderL, shoulderR, waistL, waistR, hemL, hemR };
}
