/**
 * Torso-orientation heuristic for live-mode orientation-aware warping and
 * front/back view selection (Phase A5, see docs/plan-3d-garment-assets.md
 * §5.4.3). The plan's primary design assumes BlazePose's 3D landmarks (z
 * gives yaw directly); this app still runs MoveNet (2D-only, see
 * pipeline/types.ts), so this is the plan's explicitly-sanctioned interim:
 * "shoulder-width-ratio heuristic". No signed yaw is recoverable from 2D
 * keypoints alone, so this estimates only |yaw| (0 = frontal, 180 = facing
 * away) from two independent, cheap signals:
 *
 *  - Shoulder width shrinks roughly with cos(yaw) as the torso turns,
 *    relative to a running "widest confidently-frontal" baseline
 *    (calibration, see updateOrientationCalibration).
 *  - Two independent back-facing signals disambiguate "just past profile,
 *    turning back to front" from "almost fully turned away" (width alone
 *    shrinks-then-grows identically for both): the shoulder pair swapping
 *    image sides (a front-facing person's anatomical left appears at
 *    LARGER image-x — the camera "mirrors" them — so left-at-smaller-x
 *    means facing away; the plan's §5.4.3 "landmark L/R flip"), and
 *    face-keypoint (nose/eyes) confidence dropping out. Either alone is
 *    unreliable — MoveNet frequently keeps confident face keypoints on
 *    the back of a head, and its L/R labels get noisy near profile — so
 *    treat firing of either as "back hemisphere".
 *
 * Meaningful only in live mode: a single photo has no prior frame to
 * calibrate a "frontal" baseline against (see hooks/useTorsoOrientation.ts).
 */
import type { Keypoint, KeypointName } from './types';

export interface OrientationCalibration {
  /** Running "most-frontal-observed" shoulder width, in px. 0 = uncalibrated (first frame). */
  maxShoulderWidth: number;
}

export const INITIAL_ORIENTATION_CALIBRATION: OrientationCalibration = { maxShoulderWidth: 0 };

export interface OrientationConfig {
  frontMaxYawDeg: number;
  backMinYawDeg: number;
  faceVisibleThreshold: number;
  calibrationDecay: number;
  minKeypointScore: number;
  minViewAlpha: number;
  fadeRampDeg: number;
  foreshortenFloor: number;
}

export interface TorsoOrientation {
  /** 0 (facing camera) .. 180 (facing away). Magnitude only — no signed left/right. */
  yawDeg: number;
  /** Categorical zone, before considering whether the asset actually has a back photo (see selectGarmentView). */
  zone: 'front' | 'profile' | 'back';
  /** min(shoulderL.score, shoulderR.score) — how much to trust this estimate. */
  confidence: number;
}

function byName(keypoints: readonly Keypoint[]): Map<KeypointName, Keypoint> {
  return new Map(keypoints.map((k) => [k.name, k] as const));
}

function faceVisibility(map: Map<KeypointName, Keypoint>): number {
  const names: KeypointName[] = ['nose', 'left_eye', 'right_eye'];
  const scores = names.map((n) => map.get(n)?.score ?? 0);
  return scores.reduce((a, b) => a + b, 0) / names.length;
}

/**
 * Grows the calibrated "frontal" shoulder-width baseline instantly whenever
 * a wider, confidently-frontal width is observed; otherwise decays it
 * slowly (config.calibrationDecay per call) so a stale high-water-mark
 * (e.g. the user leaned toward the camera early in the session) relaxes
 * rather than permanently reading every later, normal-distance frame as
 * "turned away".
 */
export function updateOrientationCalibration(
  cal: OrientationCalibration,
  keypoints: readonly Keypoint[],
  config: OrientationConfig,
): OrientationCalibration {
  const map = byName(keypoints);
  const ls = map.get('left_shoulder');
  const rs = map.get('right_shoulder');
  if (!ls || !rs || ls.score < config.minKeypointScore || rs.score < config.minKeypointScore) {
    return { maxShoulderWidth: cal.maxShoulderWidth * config.calibrationDecay };
  }
  const width = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const faceScore = faceVisibility(map);
  // Only a confidently FRONT-facing frame may grow the baseline: face
  // visible and shoulders in front-facing image order (anatomical left at
  // larger x) — a squared-to-camera back view has full shoulder width too,
  // but calibrating on it would be calibrating on the wrong hemisphere.
  const facingCamera = faceScore >= config.faceVisibleThreshold && ls.x >= rs.x;
  if (facingCamera && width > cal.maxShoulderWidth) {
    return { maxShoulderWidth: width };
  }
  return { maxShoulderWidth: cal.maxShoulderWidth * config.calibrationDecay };
}

/**
 * Estimates torso |yaw| + categorical zone from the current frame's
 * keypoints and the running calibration. Returns null when shoulders
 * aren't confidently visible (same reasoning as anchorMapping's own
 * confidence gate — nothing useful to say about orientation either).
 */
export function estimateTorsoOrientation(
  keypoints: readonly Keypoint[],
  cal: OrientationCalibration,
  config: OrientationConfig,
): TorsoOrientation | null {
  const map = byName(keypoints);
  const ls = map.get('left_shoulder');
  const rs = map.get('right_shoulder');
  if (!ls || !rs || ls.score < config.minKeypointScore || rs.score < config.minKeypointScore) {
    return null;
  }
  const width = Math.hypot(rs.x - ls.x, rs.y - ls.y);
  const faceScore = faceVisibility(map);
  const ratio = cal.maxShoulderWidth > 0 ? Math.min(1, width / cal.maxShoulderWidth) : 1;
  const widthYaw = (Math.acos(ratio) * 180) / Math.PI; // 0..90

  // Back hemisphere when EITHER signal fires (see module comment): the
  // shoulder pair swapped image sides, or the face keypoints dropped out.
  // MoveNet keeps confident nose/eye scores on the back of a head often
  // enough that face visibility alone misses back-facing entirely.
  const shouldersFlipped = ls.x < rs.x;
  const backFacing = shouldersFlipped || faceScore < config.faceVisibleThreshold;
  const yawDeg = backFacing ? 180 - widthYaw : widthYaw;

  const zone: TorsoOrientation['zone'] =
    yawDeg <= config.frontMaxYawDeg ? 'front' : yawDeg >= config.backMinYawDeg ? 'back' : 'profile';

  return { yawDeg, zone, confidence: Math.min(ls.score, rs.score) };
}

export interface ViewSelection {
  /** Whether to render the asset's back piece (only ever true when the caller reports hasBack). */
  useBack: boolean;
  /** Garment layer opacity, in [config.minViewAlpha, 1]. */
  alpha: number;
  /** UI hint for the unrenderable zones — 'none' when fully visible. */
  hint: 'none' | 'turn-to-front' | 'turn-to-back';
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Combines the yaw estimate with whether the asset actually has a back
 * photo (product decision, see CLAUDE.md: no back image → no back
 * rendering, ever) to decide what to render: the front image, the back
 * image (mirrored L/R — see anchorMapping.mirrorAnchorsLR), or a faded-out
 * garment with a hint pointing to whichever usable view is nearer.
 */
export function selectGarmentView(
  orientation: TorsoOrientation | null,
  hasBack: boolean,
  config: OrientationConfig,
): ViewSelection {
  if (!orientation) return { useBack: false, alpha: 1, hint: 'none' };
  const { yawDeg } = orientation;

  if (yawDeg <= config.frontMaxYawDeg) return { useBack: false, alpha: 1, hint: 'none' };

  // The back view starts crossfading IN before the nominal back threshold
  // (backMinYawDeg), reaching full opacity exactly at it, so there's a
  // continuous handoff from "front faded to the floor" to "back fading in"
  // rather than a hard pop the instant yaw crosses the threshold.
  const backRampStart = config.backMinYawDeg - config.fadeRampDeg;
  if (hasBack && yawDeg >= backRampStart) {
    const alpha = smoothstep(backRampStart, config.backMinYawDeg, yawDeg);
    return { useBack: true, alpha: Math.max(config.minViewAlpha, alpha), hint: 'none' };
  }

  // Profile band (deep profile, or facing away on a front-only asset): fade
  // the front out, with a hint pointing to whichever usable view is nearer.
  const distFromFront = yawDeg - config.frontMaxYawDeg;
  const alphaFront = 1 - smoothstep(0, config.fadeRampDeg, distFromFront);
  const alpha = Math.max(config.minViewAlpha, alphaFront);
  const distFromBackRamp = hasBack ? backRampStart - yawDeg : Infinity;
  const hint: ViewSelection['hint'] = hasBack && distFromBackRamp < distFromFront ? 'turn-to-back' : 'turn-to-front';
  return { useBack: false, alpha, hint };
}

/**
 * Horizontal foreshorten scale factor for a given |yaw| (see
 * anchorMapping.foreshortenAnchors) — 1 at front or back (frontal to
 * either camera), shrinking toward `floor` at the deep-profile midpoint,
 * symmetric around 90°.
 */
export function foreshortenFactor(yawDeg: number, floor: number): number {
  const symmetric = Math.min(yawDeg, 180 - yawDeg); // 0 at front or back, 90 at deep profile
  const raw = Math.cos((symmetric * Math.PI) / 180);
  return Math.max(floor, raw);
}
