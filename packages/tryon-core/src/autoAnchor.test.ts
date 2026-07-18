import { describe, expect, it } from 'vitest';
import { findAlphaBBox, suggestAnchors, suggestPantsAnchors } from './autoAnchor';

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

describe('suggestPantsAnchors', () => {
  it('places the waistband at the top extents and the hems at the outer leg corners', () => {
    // Pants silhouette: waistband (rows 20-40, width 60), then two legs
    // (rows 41-179) with a gap between them.
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 20; y < 180; y++) {
      if (y <= 40) {
        for (let x = 20; x <= 80; x++) data[(y * W + x) * 4 + 3] = 255;
      } else {
        for (let x = 20; x <= 44; x++) data[(y * W + x) * 4 + 3] = 255; // left leg
        for (let x = 56; x <= 80; x++) data[(y * W + x) * 4 + 3] = 255; // right leg
      }
    }
    const anchors = suggestPantsAnchors(data, W, H);
    expect(anchors).not.toBeNull();
    const { waistL, waistR, hemL, hemR } = anchors!;
    expect(waistL[0]).toBeCloseTo(20, 0);
    expect(waistR[0]).toBeCloseTo(80, 0);
    expect(waistL[1]).toBeLessThan(45);
    expect(hemL[0]).toBeCloseTo(20, 0); // OUTER corner of the left leg
    expect(hemR[0]).toBeCloseTo(80, 0);
    expect(hemL[1]).toBe(179);
  });

  it('returns null for an empty image', () => {
    const data = new Uint8ClampedArray(W * H * 4);
    expect(suggestPantsAnchors(data, W, H)).toBeNull();
  });

  it('regression: a thin artifact row above the true waistband does not collapse the waist width', () => {
    // A garment re-run through matting (e.g. a catalog PNG uploaded back
    // through the upload flow) can pick up a faint few-pixel-wide wisp just
    // above the real opaque waistband edge. Averaging a fixed top slice let
    // that wisp drag waistL/waistR to near-identical x values (observed live
    // as a jeans photo warping into a vertical sliver); the widest-row
    // search must skip past it to the real waistband.
    const data = new Uint8ClampedArray(W * H * 4);
    // Wisp: rows 20-21, a 2px sliver near center (x=49-50).
    for (let y = 20; y <= 21; y++) {
      data[(y * W + 49) * 4 + 3] = 255;
      data[(y * W + 50) * 4 + 3] = 255;
    }
    // Real waistband: rows 22-40, full width (20-80).
    for (let y = 22; y <= 40; y++) {
      for (let x = 20; x <= 80; x++) data[(y * W + x) * 4 + 3] = 255;
    }
    // Legs below.
    for (let y = 41; y < 180; y++) {
      for (let x = 20; x <= 44; x++) data[(y * W + x) * 4 + 3] = 255;
      for (let x = 56; x <= 80; x++) data[(y * W + x) * 4 + 3] = 255;
    }
    const anchors = suggestPantsAnchors(data, W, H);
    expect(anchors).not.toBeNull();
    const { waistL, waistR } = anchors!;
    expect(waistR[0] - waistL[0]).toBeGreaterThan(50); // real waistband width, not the ~1px wisp
    expect(waistL[1]).toBeGreaterThanOrEqual(22); // landed on the real band, not the wisp rows
  });
});
