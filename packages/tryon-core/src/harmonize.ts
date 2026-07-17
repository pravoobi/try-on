/**
 * Color harmonization: nudges a warped garment layer's exposure and color
 * cast toward the scene's illumination, so studio-lit product photography
 * reads as "in the photo" rather than pasted on. Deliberately conservative
 * — every adjustment is a strength-blended, clamped NUDGE (a navy dress in
 * a bright room must stay navy; the goal is matching the light, not the
 * palette).
 *
 * The scene probe is the PERSON region (mask-weighted): the illumination
 * falling on the person is what the garment they're "wearing" would
 * receive, and the background (curtains, walls) often has a strong color
 * of its own that would poison a whole-frame gray-world estimate. Skin and
 * existing clothing aren't gray either — which is exactly why castStrength
 * and the clamps keep this a nudge.
 *
 * The apply path is three GPU canvas ops, not a per-pixel JS loop, so it's
 * cheap enough for live mode: per-channel gain g = (gr, gg, gb) is exactly
 * `brightness(max(g))` followed by a multiply-composite with the color
 * (g / max(g)), with the layer's own alpha restored via destination-in.
 */
import type { HarmonizeConfig } from './config.js';

/** Rec. 709 luma on 0-255 RGB. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface SceneColorStats {
  /** Mask-weighted mean RGB of the person region, 0-255. */
  personMean: [number, number, number];
  /** Luma of personMean. */
  personLum: number;
}

function readDownsampled(
  source: CanvasImageSource,
  sampleSize: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const canvas = new OffscreenCanvas(sampleSize, sampleSize);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('harmonize: no 2d context');
  ctx.drawImage(source, 0, 0, sampleSize, sampleSize);
  return { data: ctx.getImageData(0, 0, sampleSize, sampleSize).data, w: sampleSize, h: sampleSize };
}

/**
 * Estimates the scene's illumination stats from the person region, or null
 * when the mask covers too little of the frame to trust (no person — no
 * probe). One small downsample+readback each for frame and mask.
 */
export function estimateSceneColor(
  frame: CanvasImageSource,
  maskBitmap: ImageBitmap,
  config: HarmonizeConfig,
): SceneColorStats | null {
  const s = config.sampleSize;
  const framePx = readDownsampled(frame, s);
  const maskPx = readDownsampled(maskBitmap, s);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  for (let i = 0; i < s * s; i++) {
    const a = maskPx.data[i * 4 + 3] / 255;
    if (a <= 0) continue;
    sumR += framePx.data[i * 4] * a;
    sumG += framePx.data[i * 4 + 1] * a;
    sumB += framePx.data[i * 4 + 2] * a;
    sumA += a;
  }
  // Under ~2% person coverage the "person mean" is a handful of noisy
  // pixels — skip harmonization rather than trust it.
  if (sumA < s * s * 0.02) return null;

  const personMean: [number, number, number] = [sumR / sumA, sumG / sumA, sumB / sumA];
  return { personMean, personLum: luminance(...personMean) };
}

/** Alpha-weighted mean luma of a rendered garment layer (small readback). */
export function measureLayerLuminance(layer: CanvasImageSource, config: HarmonizeConfig): number {
  const s = config.sampleSize;
  const px = readDownsampled(layer, s);
  let sumLum = 0;
  let sumA = 0;
  for (let i = 0; i < s * s; i++) {
    const a = px.data[i * 4 + 3] / 255;
    if (a <= 0) continue;
    sumLum += luminance(px.data[i * 4], px.data[i * 4 + 1], px.data[i * 4 + 2]) * a;
    sumA += a;
  }
  return sumA > 0 ? sumLum / sumA : 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Pure gain math (unit-tested): exposure gain pulls the garment's mean luma
 * toward the person region's, cast gains tilt each channel toward the
 * scene's chromatic balance — both strength-blended toward 1 and clamped.
 * `exposureStrength` 0 disables the exposure part (used when advanced-mode
 * shading already applied a scene-driven intensity — doubling it up would
 * over-darken/brighten).
 */
export function computeHarmonizeGains(
  stats: SceneColorStats,
  layerLum: number,
  config: HarmonizeConfig,
  exposureStrength: number = config.exposureStrength,
): [number, number, number] {
  const rawExposure = layerLum > 1 ? stats.personLum / layerLum : 1;
  const exposure = clamp(1 + (rawExposure - 1) * exposureStrength, config.minExposure, config.maxExposure);

  const lum = Math.max(1, stats.personLum);
  const gains: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const rawCast = stats.personMean[c] / lum;
    const cast = clamp(1 + (rawCast - 1) * config.castStrength, config.minCast, config.maxCast);
    gains[c] = exposure * cast;
  }
  return gains;
}

/**
 * Applies per-channel gains to a garment layer in three GPU ops (see module
 * comment), preserving the layer's alpha exactly.
 */
export function harmonizeLayer(
  layer: OffscreenCanvas,
  gains: [number, number, number],
): OffscreenCanvas {
  const k = Math.max(gains[0], gains[1], gains[2], 0.01);
  const out = new OffscreenCanvas(layer.width, layer.height);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('harmonizeLayer: no 2d context');
  ctx.filter = `brightness(${k})`;
  ctx.drawImage(layer, 0, 0);
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgb(${Math.round((gains[0] / k) * 255)}, ${Math.round((gains[1] / k) * 255)}, ${Math.round((gains[2] / k) * 255)})`;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(layer, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return out;
}
