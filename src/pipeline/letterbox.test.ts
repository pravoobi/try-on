import { describe, expect, it } from 'vitest';
import { computeLetterbox, contentRect, unletterboxPoint } from './letterbox';

describe('computeLetterbox', () => {
  it('fits a landscape image into the segmenter input (256x144)', () => {
    const lb = computeLetterbox(1920, 1080, 256, 144);
    expect(lb.scaledW).toBe(256);
    expect(lb.scaledH).toBe(144);
    expect(lb.dx).toBe(0);
    expect(lb.dy).toBe(0);
  });

  it('pads a portrait image left/right in a square input (192x192)', () => {
    const lb = computeLetterbox(720, 1280, 192, 192);
    expect(lb.scaledH).toBe(192);
    expect(lb.scaledW).toBe(108);
    expect(lb.dy).toBe(0);
    expect(lb.dx).toBe(42); // (192-108)/2
  });

  it('pads a portrait image heavily in a landscape input (256x144)', () => {
    const lb = computeLetterbox(720, 1280, 256, 144);
    expect(lb.scaledH).toBe(144);
    expect(lb.scaledW).toBe(81);
    expect(lb.dx).toBe(87); // floor((256-81)/2)
    expect(lb.dy).toBe(0);
  });

  it('never stretches: content aspect ratio matches source', () => {
    const lb = computeLetterbox(1000, 400, 192, 192);
    expect(lb.scaledW / lb.scaledH).toBeCloseTo(1000 / 400, 1);
  });

  it('rejects degenerate dimensions', () => {
    expect(() => computeLetterbox(0, 100, 192, 192)).toThrow();
  });
});

describe('unletterboxPoint', () => {
  it('round-trips a point through letterbox space', () => {
    const lb = computeLetterbox(720, 1280, 192, 192);
    // source point → target space (same mapping the model input uses)
    const sx = 360;
    const sy = 640;
    const tx = lb.dx + (sx * lb.scaledW) / lb.srcW;
    const ty = lb.dy + (sy * lb.scaledH) / lb.srcH;
    const back = unletterboxPoint(tx, ty, lb);
    expect(back.x).toBeCloseTo(sx, 6);
    expect(back.y).toBeCloseTo(sy, 6);
  });

  it('maps target corners of the content rect to source corners', () => {
    const lb = computeLetterbox(640, 480, 256, 144);
    const rect = contentRect(lb);
    const tl = unletterboxPoint(rect.x, rect.y, lb);
    const br = unletterboxPoint(rect.x + rect.w, rect.y + rect.h, lb);
    expect(tl.x).toBeCloseTo(0, 6);
    expect(tl.y).toBeCloseTo(0, 6);
    expect(br.x).toBeCloseTo(640, 6);
    expect(br.y).toBeCloseTo(480, 6);
  });
});
