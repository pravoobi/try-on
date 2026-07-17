import { describe, expect, it } from 'vitest';
import {
  anchorCorrespondences,
  computeBodyAnchors,
  computePantsBodyAnchors,
  foreshortenAnchors,
  mirrorAnchorsLR,
} from './anchorMapping';
import { resolveTryOnConfig } from './config';
import type { GarmentAnchors, Keypoint, SkirtAnchors } from './types';

const ANCHORS: GarmentAnchors = {
  shoulderL: [10, 0],
  shoulderR: [90, 0],
  waistL: [20, 50],
  waistR: [80, 50],
  hemL: [15, 100],
  hemR: [85, 100],
};

const SKIRT_ANCHORS: SkirtAnchors = {
  waistL: [20, 0],
  waistR: [80, 0],
  hemL: [0, 100],
  hemR: [100, 100],
};

describe('mirrorAnchorsLR', () => {
  it('swaps each L/R-named pair, leaving points otherwise unchanged', () => {
    const mirrored = mirrorAnchorsLR(ANCHORS);
    expect(mirrored.shoulderL).toEqual(ANCHORS.shoulderR);
    expect(mirrored.shoulderR).toEqual(ANCHORS.shoulderL);
    expect(mirrored.waistL).toEqual(ANCHORS.waistR);
    expect(mirrored.waistR).toEqual(ANCHORS.waistL);
    expect(mirrored.hemL).toEqual(ANCHORS.hemR);
    expect(mirrored.hemR).toEqual(ANCHORS.hemL);
  });

  it('is its own inverse', () => {
    const roundTripped = mirrorAnchorsLR(mirrorAnchorsLR(ANCHORS));
    expect(roundTripped).toEqual(ANCHORS);
  });

  it('works on the 4-point skirt anchor shape too', () => {
    const mirrored = mirrorAnchorsLR(SKIRT_ANCHORS);
    expect(mirrored.waistL).toEqual(SKIRT_ANCHORS.waistR);
    expect(mirrored.hemR).toEqual(SKIRT_ANCHORS.hemL);
  });
});

describe('computePantsBodyAnchors', () => {
  const config = resolveTryOnConfig();

  const kp = (name: Keypoint['name'], x: number, y: number, score = 0.9): Keypoint => ({ name, x, y, score });
  /** Frontal standing skeleton: hips centered on x=100, legs slightly apart. */
  const SKELETON: Keypoint[] = [
    kp('left_shoulder', 85, 100),
    kp('right_shoulder', 115, 100),
    kp('left_hip', 90, 200),
    kp('right_hip', 110, 200),
    kp('left_knee', 88, 300),
    kp('right_knee', 112, 305),
    kp('left_ankle', 86, 400),
    kp('right_ankle', 114, 402),
  ];

  /** Outward margin the hem corners get past the leg keypoint (see the pants doc comment). */
  function stanceMargin(waistL: [number, number], waistR: [number, number]): number {
    const hipHalfWidth = Math.abs(waistR[0] - waistL[0]) / 2;
    return hipHalfWidth * config.anchors.stanceCoverMargin;
  }

  it('tracks each leg separately: hem corners sit just outside the per-leg ankle keypoints', () => {
    const out = computePantsBodyAnchors(SKELETON, 'ankle', config);
    expect(out).not.toBeNull();
    const { waistL, waistR, hemL, hemR } = out!;
    const margin = stanceMargin(waistL, waistR);
    expect(hemL[0]).toBeCloseTo(86 - margin, 6); // outside the left ankle, on the left
    expect(hemL[1]).toBe(400);
    expect(hemR[0]).toBeCloseTo(114 + margin, 6); // outside the right ankle, on the right
    expect(hemR[1]).toBe(402); // per-leg y, not averaged
  });

  it('knee length (shorts) pins hems at the knees instead', () => {
    const out = computePantsBodyAnchors(SKELETON, 'knee', config)!;
    const margin = stanceMargin(out.waistL, out.waistR);
    expect(out.hemL).toEqual([88 - margin, 300]);
    expect(out.hemR).toEqual([112 + margin, 305]);
  });

  it('waistband sits at the hip line (same points a lehenga waistband uses), below the hip keypoints', () => {
    const out = computePantsBodyAnchors(SKELETON, 'ankle', config)!;
    // x: hips widened outward per config; y: slightly below the hip keypoints.
    expect(out.waistL[0]).toBeLessThan(90);
    expect(out.waistR[0]).toBeGreaterThan(110);
    expect(out.waistL[1]).toBeGreaterThan(200);
  });

  it('falls back to hanging the hem under the waistband when a leg is not confidently tracked', () => {
    const noLegs = SKELETON.map((k) =>
      k.name === 'left_ankle' || k.name === 'right_ankle' ? { ...k, score: 0.1 } : k,
    );
    const out = computePantsBodyAnchors(noLegs, 'ankle', config)!;
    const margin = stanceMargin(out.waistL, out.waistR);
    // Torso height 100 × ankle fallback multiplier below the hip line.
    const expectedY = 200 + 100 * config.anchors.hemFallbackMultiplier.ankle;
    expect(out.hemL[0]).toBeCloseTo(out.waistL[0] - margin, 6);
    expect(out.hemL[1]).toBeCloseTo(expectedY, 6);
    expect(out.hemR[1]).toBeCloseTo(expectedY, 6);
  });

  it('returns null when the torso is not confidently visible', () => {
    const noTorso = SKELETON.map((k) => (k.name === 'left_hip' ? { ...k, score: 0.1 } : k));
    expect(computePantsBodyAnchors(noTorso, 'ankle', config)).toBeNull();
  });
});

describe('computeBodyAnchors sleeve targets', () => {
  const config = resolveTryOnConfig();
  const kp = (name: Keypoint['name'], x: number, y: number, score = 0.9): Keypoint => ({ name, x, y, score });
  /** Frontal skeleton with the left arm hanging and the right arm bent (hand on hip). */
  const SKELETON: Keypoint[] = [
    kp('left_shoulder', 85, 100),
    kp('right_shoulder', 115, 100),
    kp('left_elbow', 80, 160),
    kp('right_elbow', 130, 150),
    kp('left_wrist', 78, 215),
    kp('right_wrist', 112, 190),
    kp('left_hip', 90, 200),
    kp('right_hip', 110, 200),
  ];

  it('full sleeves: elbow targets at the elbow joints, cuffs just short of the wrists', () => {
    const out = computeBodyAnchors(SKELETON, 'hip', config, 'full')!;
    const t = config.anchors.sleeve.fullCuffT;
    expect(out.elbowL).toEqual([80, 160]);
    expect(out.elbowR).toEqual([130, 150]);
    expect(out.cuffL![0]).toBeCloseTo(80 + (78 - 80) * t, 6);
    expect(out.cuffL![1]).toBeCloseTo(160 + (215 - 160) * t, 6);
    expect(out.cuffR![0]).toBeCloseTo(130 + (112 - 130) * t, 6);
  });

  it('half sleeves: cuff mid-upper-arm from the RAW shoulder joint, no elbow target', () => {
    const out = computeBodyAnchors(SKELETON, 'hip', config, 'half')!;
    const t = config.anchors.sleeve.halfCuffT;
    expect(out.elbowL).toBeUndefined();
    expect(out.cuffL![0]).toBeCloseTo(85 + (80 - 85) * t, 6);
    expect(out.cuffL![1]).toBeCloseTo(100 + (160 - 100) * t, 6);
  });

  it('an unconfident wrist drops only that cuff target; the elbow still tracks', () => {
    const noWrist = SKELETON.map((k) => (k.name === 'left_wrist' ? { ...k, score: 0.1 } : k));
    const out = computeBodyAnchors(noWrist, 'hip', config, 'full')!;
    expect(out.elbowL).toEqual([80, 160]);
    expect(out.cuffL).toBeUndefined();
    expect(out.cuffR).toBeDefined();
  });

  it("emits no sleeve targets for 'sleeveless' or when the param is omitted", () => {
    expect(computeBodyAnchors(SKELETON, 'hip', config, 'sleeveless')!.cuffL).toBeUndefined();
    expect(computeBodyAnchors(SKELETON, 'hip', config)!.cuffL).toBeUndefined();
  });
});

describe('anchorCorrespondences', () => {
  const garment: GarmentAnchors = {
    ...ANCHORS,
    cuffL: [5, 60],
    cuffR: [95, 60],
  };

  it('pairs the 6 required anchors plus only the sleeve anchors present on BOTH sides', () => {
    const body: GarmentAnchors = {
      ...ANCHORS,
      cuffL: [200, 300],
      // no cuffR on the body side (arm not tracked), no elbows anywhere
    };
    const { src, dst } = anchorCorrespondences(garment, body);
    expect(src).toHaveLength(7);
    expect(dst).toHaveLength(7);
    expect(src[6]).toEqual([5, 60]);
    expect(dst[6]).toEqual([200, 300]);
  });

  it('is exactly the 6 base pairs when the garment has no sleeve anchors', () => {
    const { src } = anchorCorrespondences(ANCHORS, garment);
    expect(src).toHaveLength(6);
  });

  it('adds a synthesized sleeve-cap pin per side whose elbow pair exists', () => {
    const withElbows: GarmentAnchors = { ...garment, elbowL: [8, 40] };
    const body: GarmentAnchors = {
      ...ANCHORS,
      elbowL: [150, 250],
      cuffL: [200, 300],
      cuffR: [420, 300],
    };
    const { src, dst } = anchorCorrespondences(withElbows, body);
    // 6 base + elbowL + cuffL + cuffR + capPinL (elbowR pair absent → no pinR)
    expect(src).toHaveLength(10);
    // The pin interpolates shoulder→elbow at a fixed fraction on both sides.
    const pinSrc = src[9];
    const pinDst = dst[9];
    expect(pinSrc[0]).toBeCloseTo(10 + (8 - 10) * 0.35, 6);
    expect(pinSrc[1]).toBeCloseTo(0 + (40 - 0) * 0.35, 6);
    expect(pinDst[0]).toBeCloseTo(10 + (150 - 10) * 0.35, 6);
    expect(pinDst[1]).toBeCloseTo(0 + (250 - 0) * 0.35, 6);
  });
});

describe('foreshortenAnchors', () => {
  it('is a no-op at factor 1', () => {
    expect(foreshortenAnchors(ANCHORS, 1)).toEqual(ANCHORS);
  });

  it('compresses x toward the centroid, leaves y untouched', () => {
    const centerX = Object.values(ANCHORS).reduce((s, p) => s + p[0], 0) / Object.values(ANCHORS).length;
    const squeezed = foreshortenAnchors(ANCHORS, 0.5);
    for (const name of Object.keys(ANCHORS) as (keyof GarmentAnchors)[]) {
      const [x, y] = ANCHORS[name];
      const [sx, sy] = squeezed[name];
      expect(sy).toBe(y);
      expect(sx).toBeCloseTo(centerX + (x - centerX) * 0.5, 6);
    }
  });

  it('collapses everything to the centroid x at factor 0', () => {
    const centerX = Object.values(ANCHORS).reduce((s, p) => s + p[0], 0) / Object.values(ANCHORS).length;
    const collapsed = foreshortenAnchors(ANCHORS, 0);
    for (const name of Object.keys(ANCHORS) as (keyof GarmentAnchors)[]) {
      expect(collapsed[name][0]).toBeCloseTo(centerX, 6);
    }
  });
});
