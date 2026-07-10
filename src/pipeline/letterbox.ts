/**
 * Letterbox math: fit a source image into a fixed model input size without
 * stretching, and map coordinates back out. Pure functions — unit tested.
 */

export interface Letterbox {
  srcW: number;
  srcH: number;
  targetW: number;
  targetH: number;
  /** Content size inside the target, after uniform scaling (rounded to px). */
  scaledW: number;
  scaledH: number;
  /** Top-left offset of the content inside the target (the padding). */
  dx: number;
  dy: number;
}

export function computeLetterbox(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): Letterbox {
  if (srcW <= 0 || srcH <= 0 || targetW <= 0 || targetH <= 0) {
    throw new Error(`invalid letterbox dims ${srcW}x${srcH} -> ${targetW}x${targetH}`);
  }
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const scaledW = Math.max(1, Math.round(srcW * scale));
  const scaledH = Math.max(1, Math.round(srcH * scale));
  const dx = Math.floor((targetW - scaledW) / 2);
  const dy = Math.floor((targetH - scaledH) / 2);
  return { srcW, srcH, targetW, targetH, scaledW, scaledH, dx, dy };
}

/**
 * Map a point in target (model-input) pixel space back to source-image pixels.
 * Uses per-axis effective scale so rounding in computeLetterbox cancels out.
 */
export function unletterboxPoint(
  x: number,
  y: number,
  lb: Letterbox,
): { x: number; y: number } {
  return {
    x: ((x - lb.dx) * lb.srcW) / lb.scaledW,
    y: ((y - lb.dy) * lb.srcH) / lb.scaledH,
  };
}

/** The region of the target actually covered by image content (not padding). */
export function contentRect(lb: Letterbox): { x: number; y: number; w: number; h: number } {
  return { x: lb.dx, y: lb.dy, w: lb.scaledW, h: lb.scaledH };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
