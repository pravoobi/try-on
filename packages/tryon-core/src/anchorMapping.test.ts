import { describe, expect, it } from 'vitest';
import { computePantsBodyAnchors, foreshortenAnchors, mirrorAnchorsLR } from './anchorMapping';
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
