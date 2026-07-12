import { describe, expect, it } from 'vitest';
import { extractGarmentAlpha, type GarmentExtractOptions, type LabelMask } from './garmentExtract';

const OPTIONS: GarmentExtractOptions = {
  humanPresenceFrac: 0.05,
  minGarmentFrac: 0.05,
  maskBlurPx: 0, // no blur in most tests so expected values are exact
};

const W = 20;
const H = 20;

/** Fills rows [y0, y1) with 255 in a fresh w*h single-channel buffer. */
function rowBand(y0: number, y1: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) data[y * W + x] = 255;
  }
  return data;
}

/**
 * A synthetic "person wearing a top": foreground rows 0-16 (head + torso +
 * legs), Face rows 0-3, Upper-clothes rows 4-10, Pants rows 11-14,
 * legs rows 15-16.
 */
function wornPhotoSegments(): LabelMask[] {
  return [
    { label: 'Face', maskData: rowBand(0, 4) },
    { label: 'Upper-clothes', maskData: rowBand(4, 11) },
    { label: 'Pants', maskData: rowBand(11, 15) },
    { label: 'Left-leg', maskData: rowBand(15, 16) },
    { label: 'Right-leg', maskData: rowBand(16, 17) },
  ];
}

describe('extractGarmentAlpha', () => {
  it('keeps only the garment rows when a person is wearing it', () => {
    const foreground = rowBand(0, 17);
    const result = extractGarmentAlpha(foreground, wornPhotoSegments(), W, H, OPTIONS);
    expect(result.kind).toBe('garment');
    if (result.kind !== 'garment') return;
    // Face rows removed, garment rows kept, pants/legs removed.
    expect(result.alpha[2 * W]).toBe(0); // face
    expect(result.alpha[5 * W]).toBe(255); // upper-clothes
    expect(result.alpha[12 * W]).toBe(0); // pants (not an upload category)
    expect(result.alpha[15 * W]).toBe(0); // leg
  });

  it('never exceeds the matting alpha (soft edges preserved)', () => {
    const foreground = rowBand(0, 17);
    foreground[5 * W + 3] = 100; // a soft-edge pixel inside the garment rows
    const result = extractGarmentAlpha(foreground, wornPhotoSegments(), W, H, OPTIONS);
    if (result.kind !== 'garment') throw new Error('expected garment');
    expect(result.alpha[5 * W + 3]).toBe(100);
  });

  it('reports no-person for a flat-lay (no human-part labels), leaving the matting result to be used as-is', () => {
    const foreground = rowBand(4, 11);
    const segments: LabelMask[] = [{ label: 'Upper-clothes', maskData: rowBand(4, 11) }];
    expect(extractGarmentAlpha(foreground, segments, W, H, OPTIONS).kind).toBe('no-person');
  });

  it('reports no-person when human parts are a negligible sliver of the foreground', () => {
    const foreground = rowBand(0, 17);
    const segments: LabelMask[] = [
      { label: 'Upper-clothes', maskData: rowBand(4, 11) },
      // 3 stray "Face" pixels out of 340 foreground — below humanPresenceFrac.
      { label: 'Face', maskData: (() => { const m = new Uint8ClampedArray(W * H); m[0] = m[1] = m[2] = 255; return m; })() },
    ];
    expect(extractGarmentAlpha(foreground, segments, W, H, OPTIONS).kind).toBe('no-person');
  });

  it('reports no-garment-found when a person is present but no top/dress class has meaningful area', () => {
    const foreground = rowBand(0, 17);
    const segments: LabelMask[] = [
      { label: 'Face', maskData: rowBand(0, 4) },
      { label: 'Pants', maskData: rowBand(4, 15) }, // pants aren't an upload category
    ];
    expect(extractGarmentAlpha(foreground, segments, W, H, OPTIONS).kind).toBe('no-garment-found');
  });

  it('picks the dominant garment class (a dress beats a small jacket)', () => {
    const foreground = rowBand(0, 18);
    const segments: LabelMask[] = [
      { label: 'Face', maskData: rowBand(0, 3) },
      { label: 'Upper-clothes', maskData: rowBand(3, 5) }, // small jacket
      { label: 'Dress', maskData: rowBand(5, 16) }, // dominant
    ];
    const result = extractGarmentAlpha(foreground, segments, W, H, OPTIONS);
    if (result.kind !== 'garment') throw new Error('expected garment');
    expect(result.alpha[4 * W]).toBe(0); // jacket rows excluded
    expect(result.alpha[10 * W]).toBe(255); // dress rows kept
  });

  it('includes belt and scarf with the chosen garment instead of leaving holes', () => {
    const foreground = rowBand(0, 17);
    const segments: LabelMask[] = [
      { label: 'Face', maskData: rowBand(0, 4) },
      { label: 'Dress', maskData: rowBand(4, 14) },
      { label: 'Belt', maskData: rowBand(9, 10) }, // belt across the dress
    ];
    const result = extractGarmentAlpha(foreground, segments, W, H, OPTIONS);
    if (result.kind !== 'garment') throw new Error('expected garment');
    expect(result.alpha[9 * W + 5]).toBe(255); // belt row kept, no stripe hole
  });

  it('reports no-person on an empty matting result', () => {
    const foreground = new Uint8ClampedArray(W * H);
    expect(extractGarmentAlpha(foreground, wornPhotoSegments(), W, H, OPTIONS).kind).toBe('no-person');
  });

  it('softens the class-mask edge when maskBlurPx > 0', () => {
    const foreground = rowBand(0, 17);
    const result = extractGarmentAlpha(foreground, wornPhotoSegments(), W, H, { ...OPTIONS, maskBlurPx: 2 });
    if (result.kind !== 'garment') throw new Error('expected garment');
    // The row just outside the hard class boundary picks up partial alpha
    // instead of a hard 255->0 step.
    const edgeOutside = result.alpha[3 * W + 10];
    expect(edgeOutside).toBeGreaterThan(0);
    expect(edgeOutside).toBeLessThan(255);
    // Deep inside the garment stays fully opaque-ish.
    expect(result.alpha[7 * W + 10]).toBeGreaterThan(240);
  });
});
