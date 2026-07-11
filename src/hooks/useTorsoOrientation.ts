import { useMemo, useRef } from 'react';
import {
  estimateTorsoOrientation,
  INITIAL_ORIENTATION_CALIBRATION,
  updateOrientationCalibration,
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
  const wasActiveRef = useRef(false);

  return useMemo(() => {
    if (!active) {
      wasActiveRef.current = false;
      calRef.current = INITIAL_ORIENTATION_CALIBRATION;
      return null;
    }
    if (!wasActiveRef.current) {
      calRef.current = INITIAL_ORIENTATION_CALIBRATION;
      wasActiveRef.current = true;
    }
    if (!keypoints) return null;
    calRef.current = updateOrientationCalibration(calRef.current, keypoints, orientationConfig);
    return estimateTorsoOrientation(keypoints, calRef.current, orientationConfig);
  }, [keypoints, active, orientationConfig]);
}
