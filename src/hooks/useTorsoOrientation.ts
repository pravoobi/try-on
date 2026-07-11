import { useEffect, useRef, useState } from 'react';
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
 */
export function useTorsoOrientation(
  keypoints: readonly Keypoint[] | null,
  active: boolean,
  orientationConfig: OrientationConfig,
): TorsoOrientation | null {
  const calRef = useRef(INITIAL_ORIENTATION_CALIBRATION);
  const wasActiveRef = useRef(false);
  const [orientation, setOrientation] = useState<TorsoOrientation | null>(null);

  useEffect(() => {
    if (!active) {
      wasActiveRef.current = false;
      calRef.current = INITIAL_ORIENTATION_CALIBRATION;
      setOrientation(null);
      return;
    }
    if (!wasActiveRef.current) {
      calRef.current = INITIAL_ORIENTATION_CALIBRATION;
      wasActiveRef.current = true;
    }
    if (!keypoints) {
      setOrientation(null);
      return;
    }
    calRef.current = updateOrientationCalibration(calRef.current, keypoints, orientationConfig);
    setOrientation(estimateTorsoOrientation(keypoints, calRef.current, orientationConfig));
  }, [active, keypoints, orientationConfig]);

  return orientation;
}
