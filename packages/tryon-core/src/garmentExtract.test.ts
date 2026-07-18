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
    expect(result.alpha[12 * W]).toBe(0); // pants (the default target is 'upper')
    expect(result.alpha[15 * W]).toBe(0); // leg
  });

  it("target 'lower' keeps the trousers and drops the top the model is also wearing", () => {
    // The whole point of the target: an on-model trousers photo contains a
    // shirt too, and picking the largest garment class would extract the
    // wrong half about as often as not.
    const foreground = rowBand(0, 17);
    const result = extractGarmentAlpha(foreground, wornPhotoSegments(), W, H, {
      ...OPTIONS,
      target: 'lower',
    });
    expect(result.kind).toBe('garment');
    if (result.kind !== 'garment') return;
    expect(result.alpha[5 * W]).toBe(0); // upper-clothes dropped
    expect(result.alpha[12 * W]).toBe(255); // pants kept
    expect(result.alpha[2 * W]).toBe(0); // face still removed
    expect(result.alpha[15 * W]).toBe(0); // legs still removed
  });

  it('fills a hole punched through the garment by an occluder (hair over a shoulder)', () => {
    // Garment rows 4-11, with a 'Hair' blob sitting fully inside them — the
    // fabric continues behind the hair, so the cutout must not be holed.
    const hair = new Uint8ClampedArray(W * H);
    for (let y = 6; y < 9; y++) {
      for (let x = 8; x < 12; x++) hair[y * W + x] = 255;
    }
    const upper = rowBand(4, 12);
    for (let y = 6; y < 9; y++) {
      for (let x = 8; x < 12; x++) upper[y * W + x] = 0; // parser assigned these to Hair
    }
    const segments: LabelMask[] = [
      { label: 'Face', maskData: rowBand(0, 4) },
      { label: 'Hair', maskData: hair },
      { label: 'Upper-clothes', maskData: upper },
      { label: 'Left-leg', maskData: rowBand(12, 17) },
    ];
    const result = extractGarmentAlpha(rowBand(0, 17), segments, W, H, OPTIONS);
    expect(result.kind).toBe('garment');
    if (result.kind !== 'garment') return;
    expect(result.alpha[7 * W + 10]).toBe(255); // hole filled
    expect(result.alpha[2 * W]).toBe(0); // face still removed — fill is interior-only
    expect(result.alpha[14 * W]).toBe(0); // leg still removed
  });

  it('leaves a gap that opens to the image border alone (the space between trouser legs)', () => {
    // Two legs with a gap between them running to the bottom edge: that gap
    // reaches the border, so it is NOT enclosed and must stay transparent.
    const pants = new Uint8ClampedArray(W * H);
    for (let y = 4; y < H; y++) {
      for (let x = 2; x < 9; x++) pants[y * W + x] = 255;
      for (let x = 11; x < 18; x++) pants[y * W + x] = 255;
    }
    const segments: LabelMask[] = [
      { label: 'Face', maskData: rowBand(0, 4) },
      { label: 'Pants', maskData: pants },
    ];
    const result = extractGarmentAlpha(rowBand(0, H), segments, W, H, { ...OPTIONS, target: 'lower' });
    expect(result.kind).toBe('garment');
    if (result.kind !== 'garment') return;
    expect(result.alpha[10 * W + 5]).toBe(255); // left leg
    expect(result.alpha[10 * W + 14]).toBe(255); // right leg
    expect(result.alpha[10 * W + 10]).toBe(0); // gap between them survives
  });

  it("target 'lower' reports no-garment-found on a photo with no lower garment", () => {
    const segments: LabelMask[] = [
      { label: 'Face', maskData: rowBand(0, 4) },
      { label: 'Dress', maskData: rowBand(4, 15) },
      { label: 'Left-leg', maskData: rowBand(15, 17) },
    ];
    const result = extractGarmentAlpha(rowBand(0, 17), segments, W, H, { ...OPTIONS, target: 'lower' });
    expect(result.kind).toBe('no-garment-found');
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
