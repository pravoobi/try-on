/**
 * Single-light Lambertian relighting for garment layers (Phase A3, see
 * docs/plan-3d-garment-assets.md §5.4 "Normal-map relighting"): a flat
 * product photo keeps its own baked-in studio lighting regardless of how
 * the person's photo is actually lit, which is one of the "sticker" tells
 * the plan calls out. Estimating a single light direction from the
 * person's own photo and shading the garment against its (depth-derived)
 * normal map goes a long way without any real 3D geometry.
 */
import { config } from '../config';
import { renderFeatheredMask } from './maskRender';
import type { DepthMapSource } from './types';

export interface LightEstimate {
  /** Unit vector in (image-x, image-y, camera-z) space. */
  dir: readonly [number, number, number];
  /** Overall light strength, derived from the photo's mean luminance. */
  intensity: number;
}

const WORK_SIZE = 128;

const FLAT_LIGHT: LightEstimate = { dir: [0, 0, 1], intensity: 1 };

/**
 * Estimates a single dominant light direction + intensity from the
 * person's own photo: the average luminance gradient across the
 * segmented body region points toward the light (a brighter side implies
 * light coming from that side), biased toward a mostly-frontal z so a
 * flat/ambiguous photo still produces plausible, mild shading rather than
 * an exaggerated or degenerate one.
 */
export function estimateLight(
  frame: ImageBitmap,
  maskBitmap: ImageBitmap,
  frameW: number,
  frameH: number,
): LightEstimate {
  const scale = Math.min(1, WORK_SIZE / Math.max(frameW, frameH));
  const sw = Math.max(2, Math.round(frameW * scale));
  const sh = Math.max(2, Math.round(frameH * scale));

  const frameCanvas = new OffscreenCanvas(sw, sh);
  const frameCtx = frameCanvas.getContext('2d');
  const maskCanvas = renderFeatheredMask(maskBitmap, sw, sh);
  const maskCtx = maskCanvas.getContext('2d');
  if (!frameCtx || !maskCtx) return FLAT_LIGHT;

  frameCtx.drawImage(frame, 0, 0, sw, sh);
  const frameData = frameCtx.getImageData(0, 0, sw, sh).data;
  const maskData = maskCtx.getImageData(0, 0, sw, sh).data;

  const lum = (x: number, y: number): number => {
    const i = (y * sw + x) * 4;
    return 0.299 * frameData[i] + 0.587 * frameData[i + 1] + 0.114 * frameData[i + 2];
  };
  const weightAt = (x: number, y: number): number => maskData[(y * sw + x) * 4 + 3] / 255;

  let sumGx = 0;
  let sumGy = 0;
  let sumW = 0;
  let sumLum = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const wgt = weightAt(x, y);
      if (wgt <= 0) continue;
      sumGx += (lum(x + 1, y) - lum(x - 1, y)) * wgt;
      sumGy += (lum(x, y + 1) - lum(x, y - 1)) * wgt;
      sumLum += lum(x, y) * wgt;
      sumW += wgt;
    }
  }
  if (sumW === 0) return FLAT_LIGHT;

  const { gradientGain, frontalBias, minIntensity, maxIntensity } = config.relighting;
  const avgGx = sumGx / sumW;
  const avgGy = sumGy / sumW;
  const avgLum = sumLum / sumW; // 0..255

  let lx = avgGx * gradientGain;
  let ly = avgGy * gradientGain;
  let lz = frontalBias;
  const len = Math.hypot(lx, ly, lz) || 1;
  lx /= len;
  ly /= len;
  lz /= len;

  const intensity = minIntensity + (avgLum / 255) * (maxIntensity - minIntensity);
  return { dir: [lx, ly, lz], intensity };
}

export interface ShadingBBox {
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

/**
 * Returns a shaded copy of `garmentLayer`: Lambertian shading from
 * `normalLayer` (same dimensions/coverage as garmentLayer — see
 * normalMap.ts) against `light`, multiplied onto the garment's own RGB
 * (its alpha — the garment's silhouette — is untouched). When `personDepth`
 * is supplied, also darkens pixels near sharp person-depth edges — a
 * screen-space approximation of the fabric turning away from camera at
 * the body's own silhouette/curvature.
 */
export function applyGarmentShading(
  garmentLayer: OffscreenCanvas,
  normalLayer: OffscreenCanvas,
  light: LightEstimate,
  bbox: ShadingBBox,
  w: number,
  h: number,
  personDepth?: DepthMapSource | null,
): OffscreenCanvas {
  const { bx, by, bw, bh } = bbox;
  const shaded = new OffscreenCanvas(w, h);
  const shadedCtx = shaded.getContext('2d');
  if (!shadedCtx) return garmentLayer;
  shadedCtx.drawImage(garmentLayer, 0, 0);
  if (bw <= 0 || bh <= 0) return shaded;

  const garmentCtx = garmentLayer.getContext('2d');
  const normalCtx = normalLayer.getContext('2d');
  if (!garmentCtx || !normalCtx) return shaded;
  const garmentData = garmentCtx.getImageData(bx, by, bw, bh).data;
  const normalData = normalCtx.getImageData(bx, by, bw, bh).data;

  let depthData: Uint8ClampedArray | null = null;
  if (personDepth) {
    const depthCanvas = new OffscreenCanvas(w, h);
    const depthCtx = depthCanvas.getContext('2d');
    if (depthCtx) {
      depthCtx.drawImage(personDepth, 0, 0, w, h);
      depthData = depthCtx.getImageData(bx, by, bw, bh).data;
    }
  }
  const sampleDepth = (x: number, y: number): number => {
    const cx = Math.min(bw - 1, Math.max(0, x));
    const cy = Math.min(bh - 1, Math.max(0, y));
    return depthData![(cy * bw + cx) * 4];
  };

  const [lx, ly, lz] = light.dir;
  const { ambient, minShade, maxShade, aoGain, aoMax } = config.relighting;
  const out = new Uint8ClampedArray(garmentData);

  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y * bw + x) * 4;
      if (garmentData[i + 3] === 0) continue;

      let nx = (normalData[i] / 255) * 2 - 1;
      let ny = (normalData[i + 1] / 255) * 2 - 1;
      let nz = (normalData[i + 2] / 255) * 2 - 1;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen;
      ny /= nlen;
      nz /= nlen;

      const ndotl = Math.max(0, nx * lx + ny * ly + nz * lz);
      let shade = ambient + (1 - ambient) * ndotl * light.intensity;

      if (depthData) {
        const edge =
          Math.abs(sampleDepth(x + 1, y) - sampleDepth(x - 1, y)) +
          Math.abs(sampleDepth(x, y + 1) - sampleDepth(x, y - 1));
        shade *= 1 - Math.min(aoMax, (edge / 255) * aoGain);
      }

      shade = Math.min(maxShade, Math.max(minShade, shade));
      out[i] = garmentData[i] * shade;
      out[i + 1] = garmentData[i + 1] * shade;
      out[i + 2] = garmentData[i + 2] * shade;
    }
  }

  shadedCtx.putImageData(new ImageData(out, bw, bh), bx, by);
  return shaded;
}
