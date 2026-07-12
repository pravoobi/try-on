import { useMemo, useRef } from 'react';
import {
  estimateTorsoOrientation,
  INITIAL_ORIENTATION_CALIBRATION,
  updateOrientationCalibration,
  zoneForYaw,
  type OrientationConfig,
  type TorsoOrientation,
} from '../pipeline/orientation';
import type { Keypoint } from '../pipeline/types';

/**
 * Owns the running orientation-calibration state across live frames (Phase
 * A5, see docs/plan-3d-garment-assets.md §5.4.3 and pipeline/orientation.ts).
 * Meaningful only in live mode — a single photo has only one frame and no
 * baseline to calibrate a "frontal" shoulder width against — so `active`
 * gates the whole thing: calibration resets whenever `active` transitions
 * from false to true, so a fresh live session never inherits a stale
 * baseline from a previous one (different person, different distance from
 * camera).
 *
 * Derived during render (useMemo keyed on the keypoints array's identity —
 * one new array per live frame), NOT via state + effect: a setState here
 * would add a second commit per live frame, doubling the per-frame render
 * work and — worse — interleaving extra paints between the live loop's
 * close-old-frame / publish-new-frame steps, which is exactly the window
 * where a paint can catch a detached ImageBitmap and crash (see
 * DebugCanvas's stale-bitmap guard).
 */
export function useTorsoOrientation(
  keypoints: readonly Keypoint[] | null,
  active: boolean,
  orientationConfig: OrientationConfig,
): TorsoOrientation | null {
  const calRef = useRef(INITIAL_ORIENTATION_CALIBRATION);
  const yawRef = useRef<number | null>(null);
  const wasActiveRef = useRef(false);

  return useMemo(() => {
    if (!active) {
      wasActiveRef.current = false;
      calRef.current = INITIAL_ORIENTATION_CALIBRATION;
      yawRef.current = null;
      return null;
    }
    if (!wasActiveRef.current) {
      calRef.current = INITIAL_ORIENTATION_CALIBRATION;
      yawRef.current = null;
      wasActiveRef.current = true;
    }
    if (!keypoints) return null;
    calRef.current = updateOrientationCalibration(calRef.current, keypoints, orientationConfig);
    const raw = estimateTorsoOrientation(keypoints, calRef.current, orientationConfig);
    if (!raw) {
      yawRef.current = null;
      return null;
    }
    // Smooth yaw across frames before anything downstream consumes it:
    // acos(width/baseline) has unbounded slope near frontal, so raw yaw
    // swings tens of degrees on a couple pixels of shoulder noise —
    // flickering the view fade (garment "blinks") and breathing the
    // foreshorten width on a perfectly still subject. The zone is
    // re-derived from the smoothed value so it can't disagree with it.
    const a = orientationConfig.yawSmoothingAlpha;
    const yawDeg = yawRef.current === null ? raw.yawDeg : a * raw.yawDeg + (1 - a) * yawRef.current;
    yawRef.current = yawDeg;
    return { yawDeg, zone: zoneForYaw(yawDeg, orientationConfig), confidence: raw.confidence };
  }, [keypoints, active, orientationConfig]);
}
