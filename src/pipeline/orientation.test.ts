import { describe, expect, it } from 'vitest';
import {
  estimateTorsoOrientation,
  foreshortenFactor,
  INITIAL_ORIENTATION_CALIBRATION,
  selectGarmentView,
  updateOrientationCalibration,
  type OrientationConfig,
  type TorsoOrientation,
} from './orientation';
import type { Keypoint } from './types';

const CONFIG: OrientationConfig = {
  frontMaxYawDeg: 35,
  backMinYawDeg: 145,
  faceVisibleThreshold: 0.25,
  calibrationDecay: 0.995,
  minKeypointScore: 0.3,
  minViewAlpha: 0.08,
  fadeRampDeg: 20,
  foreshortenFloor: 0.22,
};

function kp(name: Keypoint['name'], x: number, y: number, score = 0.9): Keypoint {
  return { name, x, y, score };
}

/** Frontal pose: full shoulder width, face fully visible. */
function frontalKeypoints(shoulderWidth: number): Keypoint[] {
  return [
    kp('left_shoulder', 100, 100),
    kp('right_shoulder', 100 + shoulderWidth, 100),
    kp('nose', 100 + shoulderWidth / 2, 80),
    kp('left_eye', 100 + shoulderWidth / 2 - 5, 75),
    kp('right_eye', 100 + shoulderWidth / 2 + 5, 75),
  ];
}

/** Turned pose: narrower shoulder width, optionally with face hidden (facing away). */
function turnedKeypoints(shoulderWidth: number, faceVisible: boolean): Keypoint[] {
  return [
    kp('left_shoulder', 100, 100),
    kp('right_shoulder', 100 + shoulderWidth, 100),
    kp('nose', 100 + shoulderWidth / 2, 80, faceVisible ? 0.9 : 0.05),
    kp('left_eye', 100 + shoulderWidth / 2 - 5, 75, faceVisible ? 0.9 : 0.05),
    kp('right_eye', 100 + shoulderWidth / 2 + 5, 75, faceVisible ? 0.9 : 0.05),
  ];
}

describe('updateOrientationCalibration', () => {
  it('grows instantly to a wider confidently-frontal width', () => {
    const cal1 = updateOrientationCalibration(INITIAL_ORIENTATION_CALIBRATION, frontalKeypoints(200), CONFIG);
    expect(cal1.maxShoulderWidth).toBeCloseTo(200, 5);
    const cal2 = updateOrientationCalibration(cal1, frontalKeypoints(240), CONFIG);
    expect(cal2.maxShoulderWidth).toBeCloseTo(240, 5);
  });

  it('does not shrink the baseline when a narrower frontal width is observed', () => {
    const cal1 = updateOrientationCalibration(INITIAL_ORIENTATION_CALIBRATION, frontalKeypoints(200), CONFIG);
    const cal2 = updateOrientationCalibration(cal1, frontalKeypoints(150), CONFIG);
    // Decays slightly rather than snapping down to the narrower observation.
    expect(cal2.maxShoulderWidth).toBeLessThan(cal1.maxShoulderWidth);
    expect(cal2.maxShoulderWidth).toBeCloseTo(200 * CONFIG.calibrationDecay, 5);
  });

  it('decays (does not grow) when the face is not visible, even at a wide width', () => {
    const cal1 = updateOrientationCalibration(INITIAL_ORIENTATION_CALIBRATION, frontalKeypoints(200), CONFIG);
    const cal2 = updateOrientationCalibration(cal1, turnedKeypoints(300, false), CONFIG);
    expect(cal2.maxShoulderWidth).toBeCloseTo(200 * CONFIG.calibrationDecay, 5);
  });

  it('decays when shoulders are not confidently visible', () => {
    const cal1 = updateOrientationCalibration(INITIAL_ORIENTATION_CALIBRATION, frontalKeypoints(200), CONFIG);
    const lowConfidence = [kp('left_shoulder', 100, 100, 0.1), kp('right_shoulder', 300, 100, 0.1)];
    const cal2 = updateOrientationCalibration(cal1, lowConfidence, CONFIG);
    expect(cal2.maxShoulderWidth).toBeCloseTo(200 * CONFIG.calibrationDecay, 5);
  });
});

describe('estimateTorsoOrientation', () => {
  it('returns null when shoulders are not confidently visible', () => {
    const lowConfidence = [kp('left_shoulder', 100, 100, 0.1), kp('right_shoulder', 300, 100, 0.1)];
    expect(estimateTorsoOrientation(lowConfidence, INITIAL_ORIENTATION_CALIBRATION, CONFIG)).toBeNull();
  });

  it('reads yaw ~0 (front zone) for a fully-frontal, calibrated pose', () => {
    const cal = { maxShoulderWidth: 200 };
    const o = estimateTorsoOrientation(frontalKeypoints(200), cal, CONFIG);
    expect(o).not.toBeNull();
    expect(o!.yawDeg).toBeCloseTo(0, 3);
    expect(o!.zone).toBe('front');
  });

  it('reads a mid-range yaw (profile zone) for a partially narrowed width with face still visible', () => {
    const cal = { maxShoulderWidth: 200 };
    // width/baseline = 0.5 -> acos(0.5) = 60 deg, past frontMaxYawDeg=35, short of backMinYawDeg=145.
    const o = estimateTorsoOrientation(turnedKeypoints(100, true), cal, CONFIG);
    expect(o).not.toBeNull();
    expect(o!.yawDeg).toBeCloseTo(60, 0);
    expect(o!.zone).toBe('profile');
  });

  it('reads a high yaw (back zone) when the width has recovered but the face is not visible', () => {
    const cal = { maxShoulderWidth: 200 };
    // width/baseline = 0.5 with face hidden -> yaw = 180 - 60 = 120 (still profile, short of 145).
    const midTurn = estimateTorsoOrientation(turnedKeypoints(100, false), cal, CONFIG);
    expect(midTurn!.yawDeg).toBeCloseTo(120, 0);
    expect(midTurn!.zone).toBe('profile');

    // width/baseline back near 1 (squared to camera again) with face hidden -> yaw ~180, back zone.
    const fullyTurned = estimateTorsoOrientation(turnedKeypoints(195, false), cal, CONFIG);
    expect(fullyTurned!.yawDeg).toBeGreaterThan(CONFIG.backMinYawDeg);
    expect(fullyTurned!.zone).toBe('back');
  });
});

describe('selectGarmentView', () => {
  const front: TorsoOrientation = { yawDeg: 10, zone: 'front', confidence: 0.9 };
  const profile: TorsoOrientation = { yawDeg: 90, zone: 'profile', confidence: 0.9 };
  const back: TorsoOrientation = { yawDeg: 170, zone: 'back', confidence: 0.9 };
  // Within the back crossfade ramp (backMinYawDeg=145, fadeRampDeg=20 -> ramp starts at 125) but
  // below the nominal back threshold, so estimateTorsoOrientation would still call this 'profile'.
  const nearBack: TorsoOrientation = { yawDeg: 135, zone: 'profile', confidence: 0.9 };

  it('returns fully-visible front when orientation is unavailable (photo mode / no confident pose)', () => {
    expect(selectGarmentView(null, true, CONFIG)).toEqual({ useBack: false, alpha: 1, hint: 'none' });
    expect(selectGarmentView(null, false, CONFIG)).toEqual({ useBack: false, alpha: 1, hint: 'none' });
  });

  it('front zone is always fully visible regardless of hasBack', () => {
    expect(selectGarmentView(front, true, CONFIG)).toEqual({ useBack: false, alpha: 1, hint: 'none' });
    expect(selectGarmentView(front, false, CONFIG)).toEqual({ useBack: false, alpha: 1, hint: 'none' });
  });

  it('profile zone always fades regardless of hasBack, hinting toward the nearer usable view', () => {
    const withBack = selectGarmentView(profile, true, CONFIG);
    expect(withBack.useBack).toBe(false);
    expect(withBack.alpha).toBeLessThan(1);
    expect(withBack.alpha).toBeGreaterThanOrEqual(CONFIG.minViewAlpha);

    const frontOnly = selectGarmentView(profile, false, CONFIG);
    expect(frontOnly.useBack).toBe(false);
    expect(frontOnly.hint).toBe('turn-to-front');
  });

  it('back zone shows the back view (fully faded in) only when the asset has one', () => {
    const withBack = selectGarmentView(back, true, CONFIG);
    expect(withBack.useBack).toBe(true);
    expect(withBack.alpha).toBeCloseTo(1, 5);
    expect(withBack.hint).toBe('none');

    const frontOnly = selectGarmentView(back, false, CONFIG);
    expect(frontOnly.useBack).toBe(false);
    expect(frontOnly.hint).toBe('turn-to-front');
  });

  it('back zone near the threshold ramps alpha in rather than snapping to 1', () => {
    const withBack = selectGarmentView(nearBack, true, CONFIG);
    expect(withBack.useBack).toBe(true);
    expect(withBack.alpha).toBeGreaterThan(CONFIG.minViewAlpha);
    expect(withBack.alpha).toBeLessThan(1);
  });

  it('picks the hint pointing to whichever usable view is nearer in the profile band', () => {
    const nearFront: TorsoOrientation = { yawDeg: 60, zone: 'profile', confidence: 0.9 };
    const nearBackSide: TorsoOrientation = { yawDeg: 120, zone: 'profile', confidence: 0.9 };
    expect(selectGarmentView(nearFront, true, CONFIG).hint).toBe('turn-to-front');
    expect(selectGarmentView(nearBackSide, true, CONFIG).hint).toBe('turn-to-back');
  });
});

describe('foreshortenFactor', () => {
  it('is 1 at front (yaw 0) and at back (yaw 180)', () => {
    expect(foreshortenFactor(0, CONFIG.foreshortenFloor)).toBeCloseTo(1, 5);
    expect(foreshortenFactor(180, CONFIG.foreshortenFloor)).toBeCloseTo(1, 5);
  });

  it('is at its floor at the deep-profile midpoint (yaw 90)', () => {
    expect(foreshortenFactor(90, CONFIG.foreshortenFloor)).toBeCloseTo(CONFIG.foreshortenFloor, 5);
  });

  it('is symmetric around 90 degrees', () => {
    expect(foreshortenFactor(60, CONFIG.foreshortenFloor)).toBeCloseTo(foreshortenFactor(120, CONFIG.foreshortenFloor), 5);
  });

  it('never drops below the floor even well past 90', () => {
    expect(foreshortenFactor(95, 0.5)).toBeCloseTo(0.5, 5);
  });
});
