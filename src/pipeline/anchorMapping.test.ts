import { describe, expect, it } from 'vitest';
import { foreshortenAnchors, mirrorAnchorsLR } from './anchorMapping';
import type { GarmentAnchors, SkirtAnchors } from './types';

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
