import { describe, expect, it } from 'vitest';
import { findAlphaBBox, suggestAnchors } from './autoAnchor';

const W = 100;
const H = 200;

/** Builds a synthetic RGBA alpha buffer: opaque within [left(y), right(y)] for y in [top, bottom), transparent elsewhere. */
function buildSilhouette(widthAt: (y: number) => number, top: number, bottom: number, centerX = 50): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = top; y < bottom; y++) {
    const width = widthAt(y);
    const left = Math.round(centerX - width / 2);
    const right = Math.round(centerX + width / 2);
    for (let x = Math.max(0, left); x <= Math.min(W - 1, right); x++) {
      data[(y * W + x) * 4 + 3] = 255;
    }
  }
  return data;
}

describe('findAlphaBBox', () => {
  it('finds the bounding box of a centered silhouette', () => {
    const data = buildSilhouette(() => 40, 20, 180);
    const bbox = findAlphaBBox(data, W, H);
    expect(bbox).not.toBeNull();
    expect(bbox!.minY).toBe(20);
    expect(bbox!.maxY).toBe(179);
    expect(bbox!.minX).toBe(30);
    expect(bbox!.maxX).toBe(70);
  });

  it('returns null for a fully transparent image', () => {
    const data = new Uint8ClampedArray(W * H * 4);
    expect(findAlphaBBox(data, W, H)).toBeNull();
  });
});

describe('suggestAnchors', () => {
  it('places shoulder/waist/hem sensibly on a tapered (fitted) silhouette', () => {
    // Narrow neckline (20-25), wide shoulders (26-35), taper to a narrow
    // waist (36-100), narrow plateau (101-150), flare to a wide hem (151-179).
    const widthAt = (y: number): number => {
      if (y < 26) return 40;
      if (y <= 35) return 80;
      if (y <= 100) {
        const t = (y - 35) / (100 - 35);
        return 80 - t * 50;
      }
      if (y <= 150) return 30;
      const t = (y - 150) / (179 - 150);
      return 30 + t * 60;
    };
    const data = buildSilhouette(widthAt, 20, 180);
    const anchors = suggestAnchors(data, W, H);
    expect(anchors).not.toBeNull();
    const { shoulderL, shoulderR, waistL, waistR, hemL, hemR } = anchors!;

    // Shoulders sit in the top band and are wider than the waist.
    expect(shoulderL[1]).toBeLessThan(70);
    const shoulderWidth = shoulderR[0] - shoulderL[0];
    const waistWidth = waistR[0] - waistL[0];
    expect(shoulderWidth).toBeGreaterThan(waistWidth);

    // Waist is the narrowest point, roughly in the middle of the silhouette.
    expect(waistL[1]).toBeGreaterThan(shoulderL[1]);
    expect(waistL[1]).toBeLessThan(hemL[1]);
    expect(waistWidth).toBeCloseTo(30, 0);

    // Hem sits at the very bottom and flares wider than the waist.
    expect(hemL[1]).toBe(179);
    expect(hemR[0] - hemL[0]).toBeGreaterThan(waistWidth);

    // Left is left-of-image, right is right-of-image (matches catalog.json convention).
    expect(shoulderL[0]).toBeLessThan(shoulderR[0]);
    expect(waistL[0]).toBeLessThan(waistR[0]);
    expect(hemL[0]).toBeLessThan(hemR[0]);
  });

  it('falls back to a straight-line waist for a boxy silhouette with no real taper', () => {
    const data = buildSilhouette(() => 60, 20, 180); // constant width throughout
    const anchors = suggestAnchors(data, W, H);
    expect(anchors).not.toBeNull();
    const { shoulderL, waistL, hemL } = anchors!;
    // Waist should fall between shoulder and hem (fallback interpolation), not
    // collapse to some arbitrary noisy row.
    expect(waistL[1]).toBeGreaterThan(shoulderL[1]);
    expect(waistL[1]).toBeLessThan(hemL[1]);
  });

  it('returns null for an empty image', () => {
    const data = new Uint8ClampedArray(W * H * 4);
    expect(suggestAnchors(data, W, H)).toBeNull();
  });
});
